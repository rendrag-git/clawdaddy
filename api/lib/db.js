const Database = require('better-sqlite3');
const path = require('node:path');
const { mkdirSync, existsSync, readFileSync, renameSync } = require('node:fs');
const crypto = require('node:crypto');

const DB_PATH = process.env.CLAWDADDY_DB_PATH || path.resolve(__dirname, '..', '..', 'data', 'clawdaddy.db');

let db;

function initDb() {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      bot_name TEXT,
      tier TEXT DEFAULT 'byok',
      stripe_customer_id TEXT,
      stripe_session_id TEXT,
      stripe_subscription_id TEXT,
      server_ip TEXT,
      ssh_key_path TEXT,
      dns_hostname TEXT,
      provision_status TEXT DEFAULT 'pending',
      provision_stage TEXT,
      auth_status TEXT DEFAULT 'pending',
      auth_provider TEXT,
      status TEXT,
      destroy_scheduled_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS onboarding_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stripe_session_id TEXT UNIQUE NOT NULL,
      customer_id TEXT REFERENCES customers(id),
      quiz_results TEXT,
      generated_files TEXT,
      gateway_token TEXT,
      portal_password TEXT,
      step TEXT DEFAULT 'quiz',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
    CREATE INDEX IF NOT EXISTS idx_customers_stripe_customer_id ON customers(stripe_customer_id);
    CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_customer_id ON onboarding_sessions(customer_id);

    CREATE TRIGGER IF NOT EXISTS customers_updated_at AFTER UPDATE ON customers
    BEGIN UPDATE customers SET updated_at = datetime('now') WHERE id = NEW.id; END;

    CREATE TRIGGER IF NOT EXISTS onboarding_sessions_updated_at AFTER UPDATE ON onboarding_sessions
    BEGIN UPDATE onboarding_sessions SET updated_at = datetime('now') WHERE id = NEW.id; END;
  `);

  migrateFromJson();
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

function generateId() {
  return 'oc_' + crypto.randomBytes(8).toString('hex');
}

// --- customers ---

function createCustomer({ username, email, botName, tier, stripeCustomerId, stripeSessionId }) {
  const id = generateId();
  getDb().prepare(`
    INSERT INTO customers (id, username, email, bot_name, tier, stripe_customer_id, stripe_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, username, email, botName || null, tier || 'byok', stripeCustomerId || null, stripeSessionId || null);
  return id;
}

function getCustomerByUsername(username) {
  return getDb().prepare('SELECT * FROM customers WHERE username = ?').get(username);
}

function getCustomerByStripeSessionId(stripeSessionId) {
  return getDb().prepare('SELECT * FROM customers WHERE stripe_session_id = ?').get(stripeSessionId);
}

function getCustomerById(id) {
  return getDb().prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

function getCustomerByStripeCustomerId(stripeCustomerId) {
  return getDb().prepare('SELECT * FROM customers WHERE stripe_customer_id = ?').get(stripeCustomerId);
}

function updateProvision(customerId, { serverIp, sshKeyPath, dnsHostname, provisionStatus, provisionStage }) {
  const fields = [];
  const values = [];
  if (serverIp !== undefined) { fields.push('server_ip = ?'); values.push(serverIp); }
  if (sshKeyPath !== undefined) { fields.push('ssh_key_path = ?'); values.push(sshKeyPath); }
  if (dnsHostname !== undefined) { fields.push('dns_hostname = ?'); values.push(dnsHostname); }
  if (provisionStatus !== undefined) { fields.push('provision_status = ?'); values.push(provisionStatus); }
  if (provisionStage !== undefined) { fields.push('provision_stage = ?'); values.push(provisionStage); }
  fields.push("updated_at = datetime('now')");
  values.push(customerId);
  getDb().prepare(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function updateAuth(customerId, { authStatus, authProvider }) {
  getDb().prepare(`
    UPDATE customers SET auth_status = ?, auth_provider = ?, updated_at = datetime('now') WHERE id = ?
  `).run(authStatus, authProvider || null, customerId);
}

function updateCustomer(customerId, updates) {
  // Generic update for Stripe IDs, status, etc.
  const allowed = ['stripe_customer_id', 'stripe_subscription_id', 'stripe_session_id', 'status', 'destroy_scheduled_at', 'tier'];
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    if (allowed.includes(key)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  values.push(customerId);
  getDb().prepare(`UPDATE customers SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

// --- onboarding_sessions ---

function createOnboardingSession({ stripeSessionId, customerId }) {
  getDb().prepare(`
    INSERT INTO onboarding_sessions (stripe_session_id, customer_id)
    VALUES (?, ?)
  `).run(stripeSessionId, customerId);
}

function getOnboardingSession(stripeSessionId) {
  return getDb().prepare('SELECT * FROM onboarding_sessions WHERE stripe_session_id = ?').get(stripeSessionId);
}

function updateOnboardingSession(stripeSessionId, updates) {
  const allowed = ['quiz_results', 'generated_files', 'gateway_token', 'portal_password', 'step'];
  const fields = [];
  const values = [];
  for (const [key, val] of Object.entries(updates)) {
    if (allowed.includes(key)) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (fields.length === 0) return;
  fields.push("updated_at = datetime('now')");
  values.push(stripeSessionId);
  getDb().prepare(`UPDATE onboarding_sessions SET ${fields.join(', ')} WHERE stripe_session_id = ?`).run(...values);
}

// --- migration ---

function migrateFromJson() {
  // Migrate customers.json from webhook server
  const jsonPaths = [
    path.resolve(__dirname, '..', '..', 'customers.json'),
    path.resolve(__dirname, '..', '..', 'script', 'webhook-server', 'customers.json'),
  ];

  for (const jsonPath of jsonPaths) {
    if (!existsSync(jsonPath)) continue;

    let data;
    try {
      data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    } catch { continue; }

    const customers = data.customers || [];
    const insert = getDb().prepare(`
      INSERT OR IGNORE INTO customers (id, username, email, bot_name, tier, stripe_customer_id, stripe_session_id, server_ip, ssh_key_path, dns_hostname, provision_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = getDb().transaction(() => {
      for (const c of customers) {
        insert.run(
          c.id || generateId(),
          c.username || c.id,
          c.email || '',
          c.bot_name || null,
          c.tier || 'byok',
          c.stripe_customer_id || null,
          c.stripe_checkout_session_id || null,
          c.ip || c.server_ip || null,
          c.ssh_key_path || null,
          c.dns_hostname || null,
          c.ip ? 'ready' : 'pending'
        );
      }
    });
    tx();

    renameSync(jsonPath, jsonPath + '.migrated');
    console.log(`Migrated ${customers.length} customers from ${jsonPath}`);
  }

  // Migrate onboarding-data.json from onboarding server
  const onboardingJsonPath = path.resolve(__dirname, '..', 'onboarding-data.json');
  if (existsSync(onboardingJsonPath)) {
    let data;
    try {
      data = JSON.parse(readFileSync(onboardingJsonPath, 'utf-8'));
    } catch { return; }

    const sessions = data.sessions || {};
    const insertSession = getDb().prepare(`
      INSERT OR IGNORE INTO onboarding_sessions (stripe_session_id, customer_id, quiz_results, generated_files, gateway_token, portal_password, step)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = getDb().transaction(() => {
      for (const [sessionId, rec] of Object.entries(sessions)) {
        // Try to find matching customer by stripe session ID or username
        const customer = getCustomerByStripeSessionId(sessionId)
          || getCustomerByUsername(rec.username);

        insertSession.run(
          sessionId,
          customer?.id || null,
          rec.quizResults ? JSON.stringify(rec.quizResults) : null,
          rec.generatedFiles ? JSON.stringify(rec.generatedFiles) : null,
          rec.gatewayToken || null,
          rec.portalToken || null,
          rec.authComplete ? 'complete' : rec.generatedFiles ? 'auth' : rec.quizResults ? 'profile' : 'quiz'
        );
      }
    });
    tx();

    renameSync(onboardingJsonPath, onboardingJsonPath + '.migrated');
    console.log(`Migrated ${Object.keys(sessions).length} onboarding sessions from ${onboardingJsonPath}`);
  }
}

module.exports = {
  initDb, getDb, generateId,
  createCustomer, getCustomerByUsername, getCustomerByStripeSessionId,
  getCustomerById, getCustomerByStripeCustomerId,
  updateProvision, updateAuth, updateCustomer,
  createOnboardingSession, getOnboardingSession, updateOnboardingSession,
};
