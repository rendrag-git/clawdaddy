import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CUSTOMERS_FILE = path.resolve(process.env.CUSTOMERS_FILE || '../customers.json');

export async function read_customers() {
  if (!existsSync(CUSTOMERS_FILE)) {
    return [];
  }
  const raw = await readFile(CUSTOMERS_FILE, 'utf-8');
  const data = JSON.parse(raw);
  return data.customers || [];
}

export async function write_customers(customers) {
  const tmp = CUSTOMERS_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify({ customers }, null, 2), 'utf-8');
  await rename(tmp, CUSTOMERS_FILE);
}

export async function find_by_email(email) {
  const customers = await read_customers();
  return customers.find(c => c.email === email) || null;
}

export async function find_most_recent_by_email(email) {
  const customers = await read_customers();
  for (let i = customers.length - 1; i >= 0; i -= 1) {
    if (customers[i].email === email) {
      return customers[i];
    }
  }
  return null;
}

export async function find_by_stripe_id(stripe_customer_id) {
  const customers = await read_customers();
  return customers.find(c => c.stripe_customer_id === stripe_customer_id) || null;
}

export async function find_by_stripe_subscription_id(stripe_subscription_id) {
  const customers = await read_customers();
  return customers.find(c => c.stripe_subscription_id === stripe_subscription_id) || null;
}

export async function find_by_checkout_session_id(checkout_session_id) {
  const customers = await read_customers();
  return customers.find(c => c.stripe_checkout_session_id === checkout_session_id) || null;
}

export async function update_customer(id, updates) {
  const customers = await read_customers();
  const idx = customers.findIndex(c => c.id === id);
  if (idx === -1) {
    throw new Error(`Customer not found: ${id}`);
  }
  customers[idx] = { ...customers[idx], ...updates };
  await write_customers(customers);
  return customers[idx];
}
