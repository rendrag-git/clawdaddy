import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('../../../api/lib/db.js');

export function init() {
  db.initDb();
}

export function find_by_email(email) {
  return db.getDb().prepare('SELECT * FROM customers WHERE email = ?').get(email) || null;
}

export function find_most_recent_by_email(email) {
  return db.getDb().prepare('SELECT * FROM customers WHERE email = ? ORDER BY created_at DESC LIMIT 1').get(email) || null;
}

export function find_by_stripe_id(stripe_customer_id) {
  return db.getCustomerByStripeCustomerId(stripe_customer_id);
}

export function find_by_stripe_subscription_id(stripe_subscription_id) {
  return db.getDb().prepare('SELECT * FROM customers WHERE stripe_subscription_id = ?').get(stripe_subscription_id) || null;
}

export function find_by_checkout_session_id(checkout_session_id) {
  return db.getCustomerByStripeSessionId(checkout_session_id);
}

export function update_customer(id, updates) {
  // Map legacy field name to new schema name
  if (updates.stripe_checkout_session_id !== undefined) {
    updates.stripe_session_id = updates.stripe_checkout_session_id;
    delete updates.stripe_checkout_session_id;
  }
  db.updateCustomer(id, updates);
}

export function create_customer(params) {
  return db.createCustomer(params);
}
