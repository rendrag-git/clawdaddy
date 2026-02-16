const { spawn } = require('node:child_process');
const { createWriteStream } = require('node:fs');
const path = require('node:path');

const PROVISION_SCRIPT = path.resolve(process.env.PROVISION_SCRIPT || path.join(__dirname, '..', '..', 'script', 'provision.sh'));
const DISCORD_OPS_WEBHOOK_URL = process.env.DISCORD_OPS_WEBHOOK_URL;

// Note: global fetch requires Node 18+. The onboarding server runs on the
// control plane server where we control the Node version. If this ever runs
// on older Node, add: const fetch = require('node-fetch');

function logAppend(logFile, msg) {
  const stream = createWriteStream(logFile, { flags: 'a' });
  stream.write(`[${new Date().toISOString()}] ${msg}\n`);
  stream.end();
}

async function discordAlert(message) {
  if (!DISCORD_OPS_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_OPS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
  } catch (err) {
    console.error(`Discord alert failed: ${err.message}`);
  }
}

function spawnProvision(params, onStageChange) {
  return new Promise((resolve, reject) => {
    const args = ['--email', params.email];

    if (params.username) args.push('--username', params.username);
    if (params.tier) args.push('--tier', params.tier);
    if (params.apiKey && params.tier !== 'managed') args.push('--api-key', params.apiKey);
    if (params.discordToken) {
      args.push('--discord-token', params.discordToken);
      args.push('--discord-channel', params.discordChannel || '');
    }
    if (params.telegramToken) {
      args.push('--telegram-token', params.telegramToken);
      args.push('--telegram-chat', params.telegramChat || '');
    }
    if (params.signalPhone) args.push('--signal-phone', params.signalPhone);
    if (params.region) args.push('--region', params.region);
    if (params.stripeCustomerId) args.push('--stripe-customer-id', params.stripeCustomerId);
    if (params.stripeSubscriptionId) args.push('--stripe-subscription-id', params.stripeSubscriptionId);
    if (params.stripeCheckoutSessionId) args.push('--stripe-checkout-session-id', params.stripeCheckoutSessionId);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logFile = path.join(__dirname, '..', `provision-onboarding-${timestamp}.log`);

    logAppend(logFile, `Spawning provision.sh for ${params.email} (username: ${params.username || 'none'})`);

    const child = spawn('bash', [PROVISION_SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      logAppend(logFile, `[stdout] ${text.trim()}`);

      // Parse stage markers in real-time
      const lines = text.split('\n');
      for (const line of lines) {
        const stageMatch = line.match(/^STAGE=(.+)$/);
        if (stageMatch && onStageChange) {
          onStageChange(stageMatch[1].trim());
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logAppend(logFile, `[stderr] ${text.trim()}`);
    });

    child.on('close', async (code) => {
      if (code === 0) {
        const result = {
          customerId: (stdout.match(/CUSTOMER_ID=(.+)/) || [])[1]?.trim() || null,
          serverIp: (stdout.match(/SERVER_IP=(.+)/) || [])[1]?.trim() || null,
          vncPassword: (stdout.match(/VNC_PASSWORD=(.+)/) || [])[1]?.trim() || null,
          sshKeyPath: (stdout.match(/SSH_KEY_PATH=(.+)/) || [])[1]?.trim() || null,
          username: (stdout.match(/USERNAME=(.+)/) || [])[1]?.trim() || null,
          dnsHostname: (stdout.match(/DNS_HOSTNAME=(.+)/) || [])[1]?.trim() || null,
          tier: (stdout.match(/TIER=(.+)/) || [])[1]?.trim() || null,
        };
        logAppend(logFile, `Provisioning complete: ${JSON.stringify(result)}`);
        resolve(result);
      } else {
        const msg = `Provision failed for ${params.email} (exit ${code}): ${stderr.slice(-500)}`;
        logAppend(logFile, msg);
        await discordAlert(`@here Provision FAILED for ${params.email} (username: ${params.username || 'none'}) -- exit code ${code}. Check ${logFile}`);
        reject(new Error(msg));
      }
    });

    child.on('error', async (err) => {
      const msg = `Provision spawn error for ${params.email}: ${err.message}`;
      logAppend(logFile, msg);
      await discordAlert(`@here Provision spawn FAILED for ${params.email}: ${err.message}`);
      reject(new Error(msg));
    });
  });
}

module.exports = { spawnProvision };
