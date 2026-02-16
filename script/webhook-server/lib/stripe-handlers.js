import { spawn_provision } from './provisioner.js';
import * as email from './email.js';
import {
  find_by_checkout_session_id,
  find_by_stripe_id,
  find_by_stripe_subscription_id,
  find_most_recent_by_email,
  update_customer,
} from './customers.js';
import { spawn } from 'node:child_process';
import path from 'node:path';

const in_flight_checkout_sessions = new Set();

function normalize_stripe_id(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.id) return value.id;
  return null;
}

export async function handle_checkout_completed(session) {
  const customer_email = session.customer_details?.email || session.metadata?.email;
  const metadata = session.metadata || {};
  const checkout_session_id = normalize_stripe_id(session.id);
  const stripe_customer_id = normalize_stripe_id(session.customer);
  const stripe_subscription_id = normalize_stripe_id(session.subscription);

  const tier = metadata.tier || 'byok';

  // If this checkout was initiated via the onboarding flow, don't provision here.
  // The onboarding server owns the provisioning lifecycle.
  if (metadata.onboarding === 'true') {
    console.log(`Onboarding checkout detected for ${customer_email} (session: ${checkout_session_id}). Sending welcome email only.`);
    try {
      await email.onboarding_welcome(customer_email, checkout_session_id);
    } catch (err) {
      console.error(`Failed to send onboarding welcome email to ${customer_email}: ${err.message}`);
    }
    return;
  }

  if (!customer_email) {
    console.error(`checkout.session.completed missing customer email (session: ${checkout_session_id || 'unknown'})`);
    return;
  }

  if (checkout_session_id) {
    const existing = await find_by_checkout_session_id(checkout_session_id);
    if (existing) {
      console.log(`Checkout session already processed: ${checkout_session_id} -> ${existing.id}`);
      return;
    }
    if (in_flight_checkout_sessions.has(checkout_session_id)) {
      console.log(`Checkout session already in progress: ${checkout_session_id}`);
      return;
    }
  }

  const params = {
    email: customer_email,
    api_key: metadata.api_key,
    discord_token: metadata.discord_token,
    discord_channel: metadata.discord_channel,
    telegram_token: metadata.telegram_token,
    telegram_chat: metadata.telegram_chat,
    signal_phone: metadata.signal_phone,
    preferred_region: metadata.preferred_region,
    tier,
    model_tier: metadata.model_tier || 'sonnet',
    stripe_customer_id,
    stripe_subscription_id,
    stripe_checkout_session_id: checkout_session_id,
  };

  if (checkout_session_id) {
    in_flight_checkout_sessions.add(checkout_session_id);
  }

  // Send immediate acknowledgment (tier-specific template), but don't block provisioning on email issues.
  try {
    if (tier === 'managed') {
      await email.provisioning_started_managed(customer_email);
    } else {
      await email.provisioning_started(customer_email);
    }
  } catch (err) {
    console.error(`Failed to send provisioning start email to ${customer_email}: ${err.message}`);
  }

  // Spawn provision asynchronously -- don't block the webhook response
  void spawn_provision(params)
    .then(async (result) => {
      let customer_id = result.customer_id;
      if (!customer_id) {
        const recent = await find_most_recent_by_email(customer_email);
        customer_id = recent?.id || null;
      }

      if (customer_id) {
        await update_customer(customer_id, {
          stripe_customer_id: stripe_customer_id || '',
          stripe_subscription_id: stripe_subscription_id || '',
          stripe_checkout_session_id: checkout_session_id || '',
        });
      } else {
        console.error(`Could not map provisioned customer for ${customer_email} to persist Stripe IDs`);
      }

      const details = {
        ip: result.ip,
        vnc_password: result.vnc_password,
        region: params.preferred_region || 'us-east',
      };

      if (tier === 'managed') {
        await email.provisioning_complete_managed(customer_email, details);
      } else {
        await email.provisioning_complete(customer_email, details);
      }
    })
    .catch(async (err) => {
      console.error(`Provisioning failed for ${customer_email}: ${err.message}`);
      await email.provisioning_failed(customer_email);
    })
    .finally(() => {
      if (checkout_session_id) {
        in_flight_checkout_sessions.delete(checkout_session_id);
      }
    });
}

export async function handle_subscription_deleted(subscription) {
  const stripe_customer_id = normalize_stripe_id(subscription.customer);
  const stripe_subscription_id = normalize_stripe_id(subscription.id);

  let customer = null;
  if (stripe_customer_id) {
    customer = await find_by_stripe_id(stripe_customer_id);
  }
  if (!customer && stripe_subscription_id) {
    customer = await find_by_stripe_subscription_id(stripe_subscription_id);
  }

  if (!customer) {
    console.error(`No customer found for subscription_deleted (customer=${stripe_customer_id}, subscription=${stripe_subscription_id})`);
    return;
  }

  const destroy_date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await update_customer(customer.id, {
    status: 'pending_destroy',
    destroy_scheduled_at: destroy_date.toISOString(),
  });

  await email.subscription_canceled(customer.email, destroy_date);
}

export async function handle_payment_failed(invoice) {
  const stripe_customer_id = normalize_stripe_id(invoice.customer);
  const stripe_subscription_id = normalize_stripe_id(invoice.subscription);
  const attempt_count = invoice.attempt_count || 0;

  let customer = null;
  if (stripe_customer_id) {
    customer = await find_by_stripe_id(stripe_customer_id);
  }
  if (!customer && stripe_subscription_id) {
    customer = await find_by_stripe_subscription_id(stripe_subscription_id);
  }

  if (!customer) {
    console.error(`No customer found for payment_failed (customer=${stripe_customer_id}, subscription=${stripe_subscription_id})`);
    return;
  }

  if (attempt_count >= 3) {
    // Stop the customer's instance
    const manage_script = path.resolve(
      path.dirname(process.env.PROVISION_SCRIPT || '../provision.sh'),
      'manage.sh'
    );

    spawn('bash', [manage_script, 'stop', customer.id], { stdio: 'ignore' });

    await email.payment_failed_suspended(customer.email);
  } else {
    await email.payment_failed_retry(customer.email);
  }
}
