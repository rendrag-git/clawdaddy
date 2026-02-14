import 'dotenv/config';
import express from 'express';
import Stripe from 'stripe';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  handle_checkout_completed,
  handle_subscription_deleted,
  handle_payment_failed,
} from './lib/stripe-handlers.js';

const PORT = process.env.PORT || 3000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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

// Webhook endpoint -- needs raw body for Stripe signature verification
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], WEBHOOK_SECRET);
  } catch (err) {
    log(`Signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  log(`Received event: ${event.type} (${event.id})`);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handle_checkout_completed(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handle_subscription_deleted(event.data.object);
        break;

      case 'invoice.payment_failed':
        await handle_payment_failed(event.data.object);
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
