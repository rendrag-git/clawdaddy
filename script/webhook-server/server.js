import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { init as initDb } from './lib/customers.js';
initDb();

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
  if (!stripe) stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripe;
}
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

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
