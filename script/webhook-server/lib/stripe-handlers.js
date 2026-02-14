import { spawn_provision } from './provisioner.js';
import * as email from './email.js';
import { find_by_stripe_id, update_customer } from './customers.js';
import { spawn } from 'node:child_process';
import path from 'node:path';

export async function handle_checkout_completed(session) {
  const customer_email = session.customer_details?.email || session.metadata?.email;
  const metadata = session.metadata || {};

  const tier = metadata.tier || 'byok';

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
  };

  // Send immediate acknowledgment (tier-specific template)
  if (tier === 'managed') {
    await email.provisioning_started_managed(customer_email);
  } else {
    await email.provisioning_started(customer_email);
  }

  // Spawn provision asynchronously -- don't block the webhook response
  spawn_provision(params)
    .then(async (result) => {
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
    .catch(async () => {
      await email.provisioning_failed(customer_email);
    });
}

export async function handle_subscription_deleted(subscription) {
  const stripe_customer_id = subscription.customer;
  const customer = await find_by_stripe_id(stripe_customer_id);

  if (!customer) {
    console.error(`No customer found for stripe_customer_id: ${stripe_customer_id}`);
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
  const stripe_customer_id = invoice.customer;
  const attempt_count = invoice.attempt_count || 0;

  const customer = await find_by_stripe_id(stripe_customer_id);

  if (!customer) {
    console.error(`No customer found for stripe_customer_id: ${stripe_customer_id}`);
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
