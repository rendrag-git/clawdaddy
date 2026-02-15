import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import path from 'node:path';

const PROVISION_SCRIPT = path.resolve(process.env.PROVISION_SCRIPT || '../provision.sh');
const DISCORD_OPS_WEBHOOK_URL = process.env.DISCORD_OPS_WEBHOOK_URL;

function log_append(msg) {
  const stream = createWriteStream('webhook.log', { flags: 'a' });
  stream.write(`[${new Date().toISOString()}] ${msg}\n`);
  stream.end();
}

async function discord_alert(message) {
  if (!DISCORD_OPS_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_OPS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
  } catch (err) {
    log_append(`Discord alert failed: ${err.message}`);
  }
}

export function spawn_provision(params) {
  return new Promise((resolve, reject) => {
    const args = [
      '--email', params.email,
    ];

    if (params.tier) {
      args.push('--tier', params.tier);
    }

    // Only pass --api-key for BYOK tier (managed tier uses operator key via env)
    if (params.api_key && params.tier !== 'managed') {
      args.push('--api-key', params.api_key);
    }

    if (params.discord_token) {
      args.push('--discord-token', params.discord_token);
      args.push('--discord-channel', params.discord_channel || '');
    }
    if (params.telegram_token) {
      args.push('--telegram-token', params.telegram_token);
      args.push('--telegram-chat', params.telegram_chat || '');
    }
    if (params.signal_phone) {
      args.push('--signal-phone', params.signal_phone);
    }
    if (params.preferred_region) {
      args.push('--region', params.preferred_region);
    }
    if (params.stripe_customer_id) {
      args.push('--stripe-customer-id', params.stripe_customer_id);
    }
    if (params.stripe_subscription_id) {
      args.push('--stripe-subscription-id', params.stripe_subscription_id);
    }
    if (params.stripe_checkout_session_id) {
      args.push('--stripe-checkout-session-id', params.stripe_checkout_session_id);
    }

    log_append(`Spawning provision.sh for ${params.email}`);

    const child = spawn('bash', [PROVISION_SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      log_append(`[provision stdout] ${text.trim()}`);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      log_append(`[provision stderr] ${text.trim()}`);
    });

    child.on('close', async (code) => {
      if (code === 0) {
        // Parse output for IP and VNC password
        const ip_match = stdout.match(/SERVER_IP=(.+)/);
        const vnc_match = stdout.match(/VNC_PASSWORD=(.+)/);
        const cid_match = stdout.match(/CUSTOMER_ID=(.+)/);

        resolve({
          success: true,
          ip: ip_match ? ip_match[1].trim() : 'unknown',
          vnc_password: vnc_match ? vnc_match[1].trim() : 'unknown',
          customer_id: cid_match ? cid_match[1].trim() : null,
        });
      } else {
        const msg = `Provision failed for ${params.email} (exit code ${code}): ${stderr.slice(-500)}`;
        log_append(msg);
        await discord_alert(`@here Provision FAILED for ${params.email} -- exit code ${code}. Check logs.`);
        reject(new Error(msg));
      }
    });

    child.on('error', async (err) => {
      const msg = `Provision spawn error for ${params.email}: ${err.message}`;
      log_append(msg);
      await discord_alert(`@here Provision spawn FAILED for ${params.email}: ${err.message}`);
      reject(new Error(msg));
    });
  });
}
