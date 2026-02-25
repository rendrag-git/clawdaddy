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
import { createRequire } from 'node:module';

const require_cjs = createRequire(import.meta.url);
const dbMod = require_cjs('../../../api/lib/db.js');

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

  const plan = metadata.tier || 'byok';  // starter, pro, power, byok, managed
  const tier = plan === 'managed' ? 'managed' : 'byok';

  const custom_fields = session.custom_fields || [];
  const username_field = custom_fields.find(f => f.key === 'username');
  const bot_name_field = custom_fields.find(f => f.key === 'botname');
  const username = username_field?.text?.value || metadata.username || null;
  const bot_name = bot_name_field?.text?.value || metadata.bot_name || null;

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
    username,
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

  // Persist customer + onboarding session to SQLite
  let customer_id = null;
  if (username) {
    try {
      customer_id = dbMod.createCustomer({
        username,
        email: customer_email,
        botName: bot_name,
        tier,
        stripeCustomerId: stripe_customer_id,
        stripeSessionId: checkout_session_id,
      });

      // Create onboarding session for the frontend to use
      dbMod.createOnboardingSession({ stripeSessionId: checkout_session_id, customerId: customer_id });
      console.log(`Created customer ${customer_id} (${username}) and onboarding session for ${checkout_session_id}`);

      // Confirm username reservation (if one exists from pre-checkout flow)
      try {
        dbMod.confirmReservation(checkout_session_id);
      } catch (reserveErr) {
        console.error(`Failed to confirm reservation for ${checkout_session_id}: ${reserveErr.message}`);
      }
    } catch (err) {
      console.error(`Failed to persist customer to SQLite: ${err.message}`);
    }
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
      // Resolve customer_id: prefer outer (SQLite-created), then provisioner result, then DB lookup
      let resolved_customer_id = customer_id || result.customer_id;
      if (!resolved_customer_id) {
        const recent = find_most_recent_by_email(customer_email);
        resolved_customer_id = recent?.id || null;
      }

      if (resolved_customer_id) {
        update_customer(resolved_customer_id, {
          stripe_customer_id: stripe_customer_id || '',
          stripe_subscription_id: stripe_subscription_id || '',
          stripe_checkout_session_id: checkout_session_id || '',
        });

        // Update provision details in SQLite
        dbMod.updateProvision(resolved_customer_id, {
          serverIp: result.ip,
          sshKeyPath: result.ssh_key_path || (username ? `/home/ubuntu/.ssh/customer-keys/openclaw-${username}` : null),
          dnsHostname: username ? `${username}.clawdaddy.sh` : null,
          dnsToken: result.dns_token || null,
          provisionStatus: 'ready',
        });
      } else {
        console.error(`Could not map provisioned customer for ${customer_email} to persist Stripe IDs`);
      }

      const details = {
        username: result.username || username,
        portalToken: result.portal_token,
        region: params.preferred_region || 'us-east',
      };

      if (tier === 'managed') {
        await email.provisioning_complete_managed(customer_email, details);
      } else {
        await email.provisioning_complete(customer_email, details);
      }

      // Trigger full nginx map sync as backup (non-blocking)
      try {
        const syncScript = path.resolve(
          path.dirname(process.env.PROVISION_SCRIPT || '../provision.sh'),
          'sync-nginx-map.sh'
        );
        spawn('bash', [syncScript], { stdio: 'ignore' });
        console.log('nginx map sync triggered');
      } catch (err) {
        console.error(`nginx map sync failed (non-fatal): ${err.message}`);
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
