import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createRequire } from 'node:module';
import { init as initDb } from './lib/customers.js';

const execFileAsync = promisify(execFile);

// Load db module (CommonJS) via createRequire — same pattern as stripe-handlers
const require_cjs = createRequire(import.meta.url);
const dbMod = require_cjs('../../api/lib/db.js');
initDb();

// --- Secret loading (file-first, env fallback) ---
const SECRETS_DIR = process.env.SECRETS_DIR || '/home/ubuntu/clawdaddy/.secrets';

function readSecret(filename, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  try {
    return readFileSync(path.join(SECRETS_DIR, filename), 'utf8').trim();
  } catch {
    return undefined;
  }
}

const STRIPE_SECRET_KEY = readSecret('stripe-key', 'STRIPE_SECRET_KEY');
const WEBHOOK_SECRET = readSecret('stripe-webhook-secret', 'STRIPE_WEBHOOK_SECRET');

const ADMIN_TOKEN = readSecret('admin-token', 'ADMIN_TOKEN');

if (!STRIPE_SECRET_KEY) console.error('WARNING: No Stripe secret key found (checked .secrets/stripe-key and STRIPE_SECRET_KEY env)');
if (!WEBHOOK_SECRET) console.error('WARNING: No Stripe webhook secret found (checked .secrets/stripe-webhook-secret and STRIPE_WEBHOOK_SECRET env)');
if (!ADMIN_TOKEN) console.error('WARNING: No admin token found (checked .secrets/admin-token and ADMIN_TOKEN env)');

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Lazy-load stripe handlers to prevent email.js from crashing startup
let stripe_handlers = null;
async function getStripeHandlers() {
  if (!stripe_handlers) {
    stripe_handlers = await import('./lib/stripe-handlers.js');
  }
  return stripe_handlers;
}

const PORT = process.env.PORT || 3000;
let stripe = null;
function getStripe() {
  if (!stripe) stripe = new Stripe(STRIPE_SECRET_KEY);
  return stripe;
}

const app = express();

// Logging
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  const stream = createWriteStream('webhook.log', { flags: 'a' });
  stream.write(line + '\n');
  stream.end();
}

// Health check (before raw body parser)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Usage report endpoint -- receives daily usage from managed-tier proxy instances
const USAGE_DIR = path.resolve('usage-reports');
app.post('/usage-report', express.json(), async (req, res) => {
  const { customer_id, date, spend, requests, models } = req.body;

  if (!customer_id || !date) {
    return res.status(400).json({ error: 'customer_id and date are required' });
  }

  try {
    const customer_dir = path.join(USAGE_DIR, customer_id);
    if (!existsSync(customer_dir)) {
      mkdirSync(customer_dir, { recursive: true });
    }

    const report_path = path.join(customer_dir, `${date}.json`);
    await writeFile(report_path, JSON.stringify({ customer_id, date, spend, requests, models }, null, 2), 'utf-8');

    log(`Usage report saved for ${customer_id} on ${date}`);
    res.json({ received: true });
  } catch (err) {
    log(`Usage report error: ${err.message}`);
    res.status(500).json({ error: 'Failed to save usage report' });
  }
});

// Waitlist endpoint -- receives signups from landing page, creates Zoho CRM lead
const ZOHO_MCP_URL = process.env.ZOHO_MCP_URL || 'https://openclaw-zoho-914186014.zohomcp.com/mcp/message?key=ca37cc03e18427fc42e08b61d5d3a16c';
const ALLOWED_ORIGINS = ['https://clawdaddy.sh', 'https://www.clawdaddy.sh', 'https://getclawdaddy.com', 'https://www.getclawdaddy.com'];

app.options('/api/waitlist', (req, res) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '86400');
  res.status(204).end();
});

app.post('/api/waitlist', express.json(), async (req, res) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
  }

  const { name, email } = req.body || {};

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Valid email required' });
  }
  if (!name || !name.trim()) {
    return res.status(400).json({ ok: false, error: 'Name required' });
  }

  const parts = name.trim().split(/\s+/);
  const firstName = parts[0];
  const lastName = parts.length > 1 ? parts.slice(1).join(' ') : 'Waitlist';

  log(`Waitlist signup: ${name} <${email}>`);

  try {
    // Call Zoho CRM via MCP to create lead
    const mcpPayload = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: 'ZohoCRM_Create_Records',
        arguments: {
          body: JSON.stringify({
            data: [{
              First_Name: firstName,
              Last_Name: lastName,
              Email: email,
              Lead_Source: 'Advertisement',
              Company: 'ClawDaddy Waitlist',
              Description: `Waitlist signup from ${origin || 'unknown'} at ${new Date().toISOString()}`
            }]
          }),
          path_variables: JSON.stringify({ module: 'Leads' })
        }
      }
    };

    const zohoRes = await fetch(ZOHO_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mcpPayload),
      signal: AbortSignal.timeout(15000)
    });

    const zohoData = await zohoRes.json();

    if (zohoData.error || (zohoData.result && zohoData.result.isError)) {
      log(`Zoho CRM error: ${JSON.stringify(zohoData.error || zohoData.result)}`);
      // Still return success to customer — we logged the signup
      res.json({ ok: true, note: 'Signup recorded (CRM sync pending)' });
    } else {
      log(`Zoho CRM lead created for ${email}`);
      res.json({ ok: true });
    }
  } catch (err) {
    log(`Waitlist error: ${err.message}`);
    // Don't fail the signup — log it and return success
    res.json({ ok: true, note: 'Signup recorded (CRM sync pending)' });
  }
});

// --- Admin API endpoints (JSON-parsed, token-gated) ---

// List all customers
app.get('/api/admin/customers', requireAdmin, async (req, res) => {
  log(`Admin API: GET /api/admin/customers`);
  try {
    const rows = dbMod.getDb().prepare('SELECT * FROM customers ORDER BY created_at DESC').all();
    res.json({ customers: rows, count: rows.length });
  } catch (err) {
    log(`Admin API error (list customers): ${err.message}`);
    res.status(500).json({ error: 'Failed to query customers', detail: err.message });
  }
});

// Get single customer by username
app.get('/api/admin/customers/:username', requireAdmin, async (req, res) => {
  const { username } = req.params;
  log(`Admin API: GET /api/admin/customers/${username}`);
  try {
    const customer = dbMod.getCustomerByUsername(username);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found', username });
    }

    // Also fetch onboarding session if one exists
    let onboarding = null;
    if (customer.stripe_session_id) {
      onboarding = dbMod.getOnboardingSession(customer.stripe_session_id);
    }

    res.json({ customer, onboarding });
  } catch (err) {
    log(`Admin API error (get customer ${username}): ${err.message}`);
    res.status(500).json({ error: 'Failed to query customer', detail: err.message });
  }
});

// Reboot a customer's Lightsail instance
app.post('/api/admin/instances/:username/reboot', requireAdmin, express.json(), async (req, res) => {
  const { username } = req.params;
  log(`Admin API: POST /api/admin/instances/${username}/reboot`);
  try {
    const customer = dbMod.getCustomerByUsername(username);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found', username });
    }

    const instanceName = `openclaw-${username}`;
    // Region is not stored in DB; accept from request body or default to us-east-1
    const region = req.body?.region || 'us-east-1';

    log(`Rebooting Lightsail instance ${instanceName} in ${region}`);

    const { stdout, stderr } = await execFileAsync('aws', [
      'lightsail', 'reboot-instance',
      '--instance-name', instanceName,
      '--region', region,
      '--profile', 'clawdaddy',
    ], { timeout: 30000 });

    log(`Reboot succeeded for ${instanceName}: ${stdout || '(no output)'}`);
    res.json({
      success: true,
      instance: instanceName,
      region,
      message: `Instance ${instanceName} is rebooting`,
    });
  } catch (err) {
    log(`Admin API error (reboot ${username}): ${err.message}`);
    const status = err.code === 'ENOENT' ? 500 : 502;
    res.status(status).json({
      error: 'Reboot failed',
      detail: err.stderr || err.message,
      instance: `openclaw-${username}`,
    });
  }
});

// Trigger Docker image update on a customer's instance
app.post('/api/admin/instances/:username/update', requireAdmin, express.json(), async (req, res) => {
  const { username } = req.params;
  log(`Admin API: POST /api/admin/instances/${username}/update`);
  try {
    const customer = dbMod.getCustomerByUsername(username);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found', username });
    }

    const ip = customer.server_ip;
    if (!ip) {
      return res.status(400).json({ error: 'Customer has no server IP', username });
    }

    const sshKeyPath = customer.ssh_key_path || `/home/ubuntu/.ssh/customer-keys/openclaw-${username}`;
    if (!existsSync(sshKeyPath)) {
      return res.status(400).json({ error: 'SSH key not found', path: sshKeyPath });
    }

    const updateScript = path.resolve('update-instance.sh');
    if (!existsSync(updateScript)) {
      return res.status(500).json({ error: 'update-instance.sh not found on control plane' });
    }

    const sshOpts = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=10',
      '-i', sshKeyPath,
    ];

    // Step 1: SCP the update script to the instance
    log(`SCP update script to ${ip}...`);
    await execFileAsync('scp', [
      ...sshOpts,
      updateScript,
      `ubuntu@${ip}:/tmp/update-instance.sh`,
    ], { timeout: 30000 });

    // Step 2: SSH in and run the update script
    log(`Running update script on ${ip}...`);
    const { stdout, stderr } = await execFileAsync('ssh', [
      ...sshOpts,
      `ubuntu@${ip}`,
      'sudo', 'bash', '/tmp/update-instance.sh',
    ], { timeout: 120000 });

    log(`Update completed for ${username} (${ip}): ${stdout.slice(0, 200)}`);
    res.json({
      success: true,
      username,
      ip,
      stdout: stdout.slice(0, 2000),
      stderr: stderr.slice(0, 2000),
    });
  } catch (err) {
    log(`Admin API error (update ${username}): ${err.message}`);
    res.status(502).json({
      error: 'Update failed',
      detail: err.stderr || err.message,
      username,
    });
  }
});

// Webhook endpoint -- needs raw body for Stripe signature verification
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  try {
    event = getStripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET);
  } catch (err) {
    log(`Signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  log(`Received event: ${event.type} (${event.id})`);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await (await getStripeHandlers()).handle_checkout_completed(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await (await getStripeHandlers()).handle_subscription_deleted(event.data.object);
        break;

      case 'invoice.payment_failed':
        await (await getStripeHandlers()).handle_payment_failed(event.data.object);
        break;

      default:
        log(`Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    log(`Handler error for ${event.type}: ${err.message}`);
    // Still return 200 so Stripe doesn't retry
  }

  res.json({ received: true });
});

// Start server
const server = app.listen(PORT, () => {
  log(`Webhook server listening on port ${PORT}`);
});

// Graceful shutdown
function shutdown(signal) {
  log(`Received ${signal}, shutting down gracefully...`);
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
