# BYOK Auth + Onboarding Pipeline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire real SSH-based OAuth auth into onboarding, migrate to SQLite, and make webhook server the single provisioning owner.

**Architecture:** Shared SQLite DB (`data/clawdaddy.db`) replaces JSON stores. Webhook server writes provisioning results; onboarding server reads them and manages quiz/profile/auth. SSH auth uses `child_process.spawn` with `ssh -tt` and an in-memory Map for process handles.

**Tech Stack:** Node.js 22, Express, better-sqlite3 (WAL mode), child_process.spawn, ssh -tt

**Design doc:** `docs/plans/2026-02-18-byok-auth-design.md`
**Auth flow docs:** `docs/auth-flow-anthropic.md`, `docs/auth-flow-openai.md`

**Review feedback incorporated:** Dev (generateId prefix, writeAuthProfile structure + stdin piping, frontend retry max, deployFilesToInstance clarification, Stripe custom fields task), Edgar (bcrypt portal_password, indexes, updated_at triggers).

---

## Task 0: Stripe Custom Fields Setup

**Context:** Username and bot_name are collected during Stripe Checkout, not in the onboarding UI. The Stripe payment link needs custom fields configured.

**Step 1: Add custom fields to Stripe payment link**

Via Stripe Dashboard or API, add two custom fields to the checkout payment link:
- `username` — text, required, label "Choose your username (becomes yourname.clawdaddy.sh)"
- `bot_name` — text, required, label "Name your AI assistant"

Via API (if preferred):
```bash
stripe payment_links update plink_XXXX \
  --custom-fields[0][key]=username \
  --custom-fields[0][label][custom]="Choose your username" \
  --custom-fields[0][type]=text \
  --custom-fields[0][text][minimum_length]=3 \
  --custom-fields[0][text][maximum_length]=20 \
  --custom-fields[1][key]=bot_name \
  --custom-fields[1][label][custom]="Name your AI assistant" \
  --custom-fields[1][type]=text \
  --custom-fields[1][text][minimum_length]=2 \
  --custom-fields[1][text][maximum_length]=80
```

**Step 2: Verify** — create a test checkout session and confirm `custom_fields` appears in the session object with `key`, `text.value`.

**Step 3: Commit** (no code change — Stripe config only, document in commit message)

```bash
git commit --allow-empty -m "chore: configure Stripe payment link custom fields for username + bot_name"
```

---

## Task 1: Shared SQLite Database Layer

**Files:**
- Create: `api/lib/db.js`
- Create: `api/lib/db.test.js`
- Modify: `api/package.json`

This is the foundation. Both servers import this module. CJS format (onboarding server is CJS; webhook server can import CJS via Node 22 ESM interop).

**Step 1: Install dependencies**

```bash
cd api && npm install better-sqlite3 bcrypt
```

> `bcrypt` is for hashing `portal_password` before storage. Already a dep in the portal server — same convention here. Store `bcrypt.hashSync(password, 10)`, verify with `bcrypt.compareSync()` on login.

**Step 2: Create `api/lib/db.js`**

```js
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
      server_ip TEXT,
      ssh_key_path TEXT,
      dns_hostname TEXT,
      provision_status TEXT DEFAULT 'pending',
      provision_stage TEXT,
      auth_status TEXT DEFAULT 'pending',
      auth_provider TEXT,
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
  return 'oc_' + crypto.randomBytes(4).toString('hex');
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
```

**Step 3: Write tests for db.js**

Create `api/lib/db.test.js` using Node's built-in test runner (`node:test`, available in Node 22):

```js
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { mkdirSync, rmSync } = require('node:fs');

// Use temp DB for tests
const TEST_DB_DIR = path.join(__dirname, '..', '..', 'data', 'test');
process.env.CLAWDADDY_DB_PATH = path.join(TEST_DB_DIR, `test-${Date.now()}.db`);

const db = require('./db');

beforeEach(() => {
  // Re-init with fresh tables
  const d = db.initDb();
  d.exec('DELETE FROM onboarding_sessions');
  d.exec('DELETE FROM customers');
});

after(() => {
  try { rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch {}
});

describe('customers', () => {
  it('createCustomer and getByUsername', () => {
    const id = db.createCustomer({ username: 'alice', email: 'alice@test.com', botName: 'Jarvis' });
    assert.ok(id);
    assert.match(id, /^oc_[a-f0-9]{8}$/);
    const c = db.getCustomerByUsername('alice');
    assert.equal(c.username, 'alice');
    assert.equal(c.email, 'alice@test.com');
    assert.equal(c.bot_name, 'Jarvis');
    assert.equal(c.provision_status, 'pending');
  });

  it('getByStripeSessionId', () => {
    db.createCustomer({ username: 'bob', email: 'bob@test.com', stripeSessionId: 'cs_test_123' });
    const c = db.getCustomerByStripeSessionId('cs_test_123');
    assert.equal(c.username, 'bob');
  });

  it('updateProvision', () => {
    const id = db.createCustomer({ username: 'carol', email: 'carol@test.com' });
    db.updateProvision(id, { serverIp: '1.2.3.4', sshKeyPath: '/key', dnsHostname: 'carol.clawdaddy.sh', provisionStatus: 'ready' });
    const c = db.getCustomerById(id);
    assert.equal(c.server_ip, '1.2.3.4');
    assert.equal(c.provision_status, 'ready');
  });

  it('updateAuth', () => {
    const id = db.createCustomer({ username: 'dave', email: 'dave@test.com' });
    db.updateAuth(id, { authStatus: 'complete', authProvider: 'anthropic' });
    const c = db.getCustomerById(id);
    assert.equal(c.auth_status, 'complete');
    assert.equal(c.auth_provider, 'anthropic');
  });

  it('rejects duplicate username', () => {
    db.createCustomer({ username: 'eve', email: 'eve@test.com' });
    assert.throws(() => {
      db.createCustomer({ username: 'eve', email: 'eve2@test.com' });
    });
  });
});

describe('onboarding_sessions', () => {
  it('create and get', () => {
    const custId = db.createCustomer({ username: 'frank', email: 'frank@test.com', stripeSessionId: 'cs_frank' });
    db.createOnboardingSession({ stripeSessionId: 'cs_frank', customerId: custId });
    const s = db.getOnboardingSession('cs_frank');
    assert.equal(s.stripe_session_id, 'cs_frank');
    assert.equal(s.customer_id, custId);
    assert.equal(s.step, 'quiz');
  });

  it('update session', () => {
    const custId = db.createCustomer({ username: 'grace', email: 'grace@test.com', stripeSessionId: 'cs_grace' });
    db.createOnboardingSession({ stripeSessionId: 'cs_grace', customerId: custId });
    db.updateOnboardingSession('cs_grace', { quiz_results: '{"foo":1}', step: 'profile' });
    const s = db.getOnboardingSession('cs_grace');
    assert.equal(s.quiz_results, '{"foo":1}');
    assert.equal(s.step, 'profile');
  });
});
```

**Step 4: Run tests**

```bash
cd api && node --test lib/db.test.js
```

Expected: All tests pass.

**Step 5: Commit**

```bash
git add api/lib/db.js api/lib/db.test.js api/package.json api/package-lock.json
git commit -m "feat: shared SQLite database layer with customers + onboarding_sessions tables"
```

---

## Task 2: Migrate Webhook Server to SQLite

**Files:**
- Modify: `script/webhook-server/lib/stripe-handlers.js`
- Modify: `script/webhook-server/lib/customers.js` (replace entirely)
- Modify: `script/webhook-server/server.js`
- Modify: `script/webhook-server/package.json`

**Step 1: Add better-sqlite3 to webhook server deps**

```bash
cd script/webhook-server && npm install better-sqlite3
```

**Step 2: Replace `customers.js` with SQLite-backed queries**

Rewrite `script/webhook-server/lib/customers.js` to import from `api/lib/db.js` instead of reading/writing JSON. Since the webhook server uses ESM and db.js is CJS, use `createRequire`:

```js
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
  db.updateCustomer(id, updates);
}

export function create_customer(params) {
  return db.createCustomer(params);
}
```

**Step 3: Modify `stripe-handlers.js`**

Key changes:
1. Remove the `metadata.onboarding === 'true'` guard (lines 31-41)
2. Read `session.custom_fields` for username and bot_name
3. Insert customer + onboarding session into SQLite on checkout
4. Update customer with provisioning results on completion

```js
// At top of handle_checkout_completed():
const custom_fields = session.custom_fields || [];
const username_field = custom_fields.find(f => f.key === 'username');
const bot_name_field = custom_fields.find(f => f.key === 'bot_name');
const username = username_field?.text?.value || metadata.username || null;
const bot_name = bot_name_field?.text?.value || metadata.bot_name || null;

// Replace the onboarding guard with:
// (no guard — all checkouts provision)

// After dedup check, before spawn_provision:
let customer_id;
if (username) {
  customer_id = create_customer({
    username,
    email: customer_email,
    botName: bot_name,
    tier,
    stripeCustomerId: stripe_customer_id,
    stripeSessionId: checkout_session_id,
  });

  // Create onboarding session for the frontend to use
  const db = require('../../../api/lib/db.js');
  db.createOnboardingSession({ stripeSessionId: checkout_session_id, customerId: customer_id });
}

// In the .then() after spawn_provision resolves:
if (customer_id) {
  const db = require('../../../api/lib/db.js');
  db.updateProvision(customer_id, {
    serverIp: result.ip,
    sshKeyPath: result.ssh_key_path || `/home/ubuntu/.ssh/customer-keys/openclaw-${username}`,
    dnsHostname: `${username}.clawdaddy.sh`,
    provisionStatus: 'ready',
  });
}
```

**Step 4: Modify `server.js` — init DB on startup**

Add after imports:
```js
import { init } from './lib/customers.js';
init();
```

**Step 5: Verify webhook server starts**

```bash
cd script/webhook-server && node -e "import('./server.js')"
```

Expected: No crash. DB file created at `data/clawdaddy.db`.

**Step 6: Commit**

```bash
git add script/webhook-server/ api/lib/db.js
git commit -m "feat: migrate webhook server from customers.json to SQLite"
```

---

## Task 3: SSH Auth Module

**Files:**
- Create: `api/lib/ssh-auth.js`
- Create: `api/lib/ssh-auth.test.js`

This is the core BYOK auth logic. Manages long-lived SSH processes with PTY.

**Step 1: Create `api/lib/ssh-auth.js`**

Ref: `docs/auth-flow-anthropic.md`, `docs/auth-flow-openai.md`

```js
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const URL_WAIT_TIMEOUT_MS = 20 * 1000;  // 20s for URL to appear
const CODE_WAIT_TIMEOUT_MS = 15 * 1000; // 15s for token after code submitted
const STDIN_DELAY_MS = 500;              // delay before writing to stdin

const sessions = new Map();

// --- stdout line buffer ---
// SSH over PTY can split output mid-line. Buffer until newline before matching.

function createLineBuffer(onLine) {
  let partial = '';
  return (chunk) => {
    partial += chunk.toString();
    const lines = partial.split('\n');
    partial = lines.pop(); // hold trailing partial
    for (const line of lines) {
      onLine(line);
    }
  };
}

// --- Anthropic flow ---

function startAnthropic(serverIp, sshKeyPath) {
  return new Promise((resolve, reject) => {
    const authSessionId = crypto.randomUUID();
    const proc = spawn('ssh', [
      '-tt', '-i', sshKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      `ubuntu@${serverIp}`,
      'claude setup-token'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let resolved = false;
    const stdoutLines = [];

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup(authSessionId);
        reject(new Error('Timed out waiting for Anthropic OAuth URL'));
      }
    }, URL_WAIT_TIMEOUT_MS);

    const onLine = (line) => {
      stdoutLines.push(line);
      const urlMatch = line.match(/(https:\/\/claude\.ai\/oauth\/authorize[^\s]*)/);
      if (urlMatch && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        const session = {
          proc,
          provider: 'anthropic',
          serverIp,
          sshKeyPath,
          stdoutLines,
          createdAt: Date.now(),
          timeoutHandle: setTimeout(() => cleanup(authSessionId), AUTH_TIMEOUT_MS),
          _onLine: onLine,
          _lineHandler: null,
        };
        sessions.set(authSessionId, session);
        resolve({ authSessionId, oauthUrl: urlMatch[1] });
      }
    };

    const lineHandler = createLineBuffer(onLine);
    proc.stdout.on('data', lineHandler);
    proc.stderr.on('data', () => {}); // ignore stderr

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`SSH connection failed: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`SSH process exited with code ${code} before OAuth URL appeared`));
      }
    });
  });
}

function completeAnthropic(authSessionId, codeWithState) {
  return new Promise((resolve, reject) => {
    const session = sessions.get(authSessionId);
    if (!session) return reject(new Error('Auth session not found or expired'));
    if (session.provider !== 'anthropic') return reject(new Error('Wrong provider for this session'));

    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup(authSessionId);
        reject(new Error('Timed out waiting for Anthropic token'));
      }
    }, CODE_WAIT_TIMEOUT_MS);

    // Listen for token in stdout
    const originalOnLine = session._onLine;
    const onLine = (line) => {
      session.stdoutLines.push(line);
      const tokenMatch = line.match(/(sk-ant-oat01-[^\s]+)/);
      if (tokenMatch && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        const token = tokenMatch[1];

        // Kill interactive process
        session.proc.kill();
        clearTimeout(session.timeoutHandle);

        // Write auth-profiles.json via non-interactive SSH
        writeAuthProfile(session.serverIp, session.sshKeyPath, 'anthropic', token)
          .then(() => {
            sessions.delete(authSessionId);
            resolve({ ok: true, provider: 'anthropic', profileName: 'anthropic:manual' });
          })
          .catch((err) => {
            sessions.delete(authSessionId);
            reject(new Error(`Token obtained but failed to write auth profile: ${err.message}`));
          });
      }

      // Check for error
      if (line.includes('OAuth error') && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        cleanup(authSessionId);
        reject(new Error(`Anthropic auth error: ${line.trim()}`));
      }
    };

    // Replace stdout handler
    session.proc.stdout.removeAllListeners('data');
    session.proc.stdout.on('data', createLineBuffer(onLine));

    // Write code to stdin after delay
    setTimeout(() => {
      if (!resolved) {
        session.proc.stdin.write(codeWithState + '\n');
      }
    }, STDIN_DELAY_MS);
  });
}

// --- OpenAI flow ---

function startOpenai(serverIp, sshKeyPath) {
  return new Promise((resolve, reject) => {
    const authSessionId = crypto.randomUUID();
    const proc = spawn('ssh', [
      '-tt', '-i', sshKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      `ubuntu@${serverIp}`,
      'openclaw onboard --auth-choice openai-codex'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let resolved = false;
    let wizardStep = 0; // 0=security, 1=quickstart, 2=config, 3=waiting-for-url
    const stdoutLines = [];
    const expectedPrompts = [
      { pattern: /continue|security|disclaimer/i, action: () => proc.stdin.write('\n'), name: 'security disclaimer' },
      { pattern: /quickstart|onboarding mode/i, action: () => proc.stdin.write('\n'), name: 'onboarding mode' },
      { pattern: /update values|use existing|config/i, action: () => proc.stdin.write('\n'), name: 'config handling' },
    ];

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup(authSessionId);
        reject(new Error('Timed out waiting for OpenAI OAuth URL'));
      }
    }, URL_WAIT_TIMEOUT_MS);

    const onLine = (line) => {
      stdoutLines.push(line);

      // Check for OAuth URL first (highest priority)
      const urlMatch = line.match(/(https:\/\/auth\.openai\.com\/oauth\/authorize[^\s]*)/);
      if (urlMatch && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        wizardStep = expectedPrompts.length; // done with wizard
        const session = {
          proc,
          provider: 'openai',
          serverIp,
          sshKeyPath,
          stdoutLines,
          createdAt: Date.now(),
          timeoutHandle: setTimeout(() => cleanup(authSessionId), AUTH_TIMEOUT_MS),
        };
        sessions.set(authSessionId, session);
        resolve({ authSessionId, oauthUrl: urlMatch[1] });
        return;
      }

      // Navigate wizard prompts in order
      if (wizardStep < expectedPrompts.length) {
        const expected = expectedPrompts[wizardStep];
        if (expected.pattern.test(line)) {
          setTimeout(() => {
            expected.action();
            wizardStep++;
          }, STDIN_DELAY_MS);
        }
        // Don't abort on unexpected lines during wizard — lots of decorative output
      }
    };

    const lineHandler = createLineBuffer(onLine);
    proc.stdout.on('data', lineHandler);
    proc.stderr.on('data', () => {});

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`SSH connection failed: ${err.message}`));
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`SSH process exited with code ${code} before OAuth URL appeared`));
      }
    });
  });
}

function completeOpenai(authSessionId, redirectUrl) {
  return new Promise((resolve, reject) => {
    const session = sessions.get(authSessionId);
    if (!session) return reject(new Error('Auth session not found or expired'));
    if (session.provider !== 'openai') return reject(new Error('Wrong provider for this session'));

    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup(authSessionId);
        reject(new Error('Timed out waiting for OpenAI token exchange'));
      }
    }, CODE_WAIT_TIMEOUT_MS);

    const onLine = (line) => {
      session.stdoutLines.push(line);
      if (line.includes('Model configured') && !resolved) {
        resolved = true;
        clearTimeout(timeout);

        // Send Escape to exit wizard, then kill
        session.proc.stdin.write('\x1b');
        setTimeout(() => {
          session.proc.kill();
          clearTimeout(session.timeoutHandle);
          sessions.delete(authSessionId);
          resolve({ ok: true, provider: 'openai', profileName: 'openai-codex' });
        }, 500);
      }
    };

    session.proc.stdout.removeAllListeners('data');
    session.proc.stdout.on('data', createLineBuffer(onLine));

    // Write redirect URL to stdin after delay
    setTimeout(() => {
      if (!resolved) {
        session.proc.stdin.write(redirectUrl + '\n');
      }
    }, STDIN_DELAY_MS);
  });
}

// --- auth-profiles.json write ---
// Correct format matching entrypoint convention:
// { "version": 1, "profiles": { "anthropic:manual": { "type": "token", "provider": "anthropic", "token": "..." } }, "order": { "anthropic": ["anthropic:manual"] } }
// Pipes JSON via stdin to avoid shell injection.

function writeAuthProfile(serverIp, sshKeyPath, provider, token) {
  return new Promise((resolve, reject) => {
    let profileName, profileEntry, orderKey;

    if (provider === 'anthropic') {
      profileName = 'anthropic:manual';
      orderKey = 'anthropic';
      profileEntry = { type: 'token', provider: 'anthropic', token };
    } else if (provider === 'openai') {
      profileName = 'openai-codex:oauth';
      orderKey = 'openai-codex';
      profileEntry = { type: 'token', provider: 'openai-codex', token };
    } else {
      return reject(new Error(`Unknown provider: ${provider}`));
    }

    // Build the update payload — the remote script reads this from stdin
    const updatePayload = JSON.stringify({ profileName, profileEntry, orderKey });

    // Remote node script: reads JSON from stdin, merges into each auth-profiles.json
    const remoteScript = `
      node -e '
        const fs = require("fs");
        const { profileName, profileEntry, orderKey } = JSON.parse(require("fs").readFileSync("/dev/stdin", "utf8"));
        const glob = require("child_process").execSync("ls /home/ubuntu/.openclaw/agents/*/agent/auth-profiles.json 2>/dev/null || true", { encoding: "utf8" }).trim().split("\\n").filter(Boolean);
        let wrote = 0;
        for (const f of glob) {
          let existing = { version: 1, profiles: {}, order: {} };
          try { existing = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
          existing.version = existing.version || 1;
          existing.profiles = existing.profiles || {};
          existing.order = existing.order || {};
          existing.profiles[profileName] = profileEntry;
          if (!existing.order[orderKey]) existing.order[orderKey] = [];
          if (!existing.order[orderKey].includes(profileName)) existing.order[orderKey].push(profileName);
          fs.writeFileSync(f, JSON.stringify(existing, null, 2));
          wrote++;
        }
        console.log("AUTH_PROFILE_WRITTEN:" + wrote);
      '
    `.trim();

    const proc = spawn('ssh', [
      '-i', sshKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      `ubuntu@${serverIp}`,
      remoteScript
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    // Pipe the update payload via stdin (no shell interpolation)
    proc.stdin.write(updatePayload);
    proc.stdin.end();

    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && stdout.includes('AUTH_PROFILE_WRITTEN')) {
        resolve();
      } else {
        reject(new Error(`Auth profile write failed (exit ${code}): ${stdout.slice(-200)}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

// --- public API ---

async function startAuth(provider, serverIp, sshKeyPath) {
  if (provider === 'anthropic') return startAnthropic(serverIp, sshKeyPath);
  if (provider === 'openai') return startOpenai(serverIp, sshKeyPath);
  throw new Error(`Unknown provider: ${provider}`);
}

async function completeAuth(authSessionId, code) {
  const session = sessions.get(authSessionId);
  if (!session) throw new Error('Auth session not found or expired');
  if (session.provider === 'anthropic') return completeAnthropic(authSessionId, code);
  if (session.provider === 'openai') return completeOpenai(authSessionId, code);
  throw new Error(`Unknown provider: ${session.provider}`);
}

function cleanup(authSessionId) {
  const session = sessions.get(authSessionId);
  if (session) {
    try { session.proc.kill(); } catch {}
    clearTimeout(session.timeoutHandle);
    sessions.delete(authSessionId);
  }
}

function cleanupExpired() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > AUTH_TIMEOUT_MS) {
      console.log(`Cleaning up expired auth session: ${id}`);
      cleanup(id);
    }
  }
}

// Run cleanup every 30 seconds
const cleanupInterval = setInterval(cleanupExpired, 30_000);
cleanupInterval.unref(); // don't prevent process exit

module.exports = { startAuth, completeAuth, cleanup, cleanupExpired };
```

**Step 2: Write basic unit test**

Create `api/lib/ssh-auth.test.js`. These test the line buffer and session management logic (SSH itself requires integration testing on a real instance):

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Test the line buffer logic in isolation
describe('createLineBuffer (extracted for testing)', () => {
  it('buffers partial lines', () => {
    const lines = [];
    // Inline the buffer logic for testing
    let partial = '';
    const onChunk = (chunk) => {
      partial += chunk;
      const parts = partial.split('\n');
      partial = parts.pop();
      for (const p of parts) lines.push(p);
    };

    onChunk('hello wo');
    assert.deepEqual(lines, []);
    onChunk('rld\ngoodbye\n');
    assert.deepEqual(lines, ['hello world', 'goodbye']);
  });

  it('handles complete lines', () => {
    const lines = [];
    let partial = '';
    const onChunk = (chunk) => {
      partial += chunk;
      const parts = partial.split('\n');
      partial = parts.pop();
      for (const p of parts) lines.push(p);
    };

    onChunk('line1\nline2\nline3\n');
    assert.deepEqual(lines, ['line1', 'line2', 'line3']);
  });
});
```

**Step 3: Run tests**

```bash
cd api && node --test lib/ssh-auth.test.js
```

**Step 4: Commit**

```bash
git add api/lib/ssh-auth.js api/lib/ssh-auth.test.js
git commit -m "feat: SSH auth module for Anthropic and OpenAI BYOK flows"
```

---

## Task 4: Rewrite Onboarding Server

**Files:**
- Modify: `api/onboarding-server.js` (major rewrite)

This is the largest single task. The server switches from JSON store to SQLite, drops provisioning, and wires the real auth endpoints.

**Step 1: Rewrite onboarding-server.js**

Key changes (work through the file top to bottom):

**Imports — add db and ssh-auth, remove provisioner:**
```js
const { initDb, getCustomerByStripeSessionId, getOnboardingSession, updateOnboardingSession, updateAuth } = require('./lib/db');
const { startAuth, completeAuth } = require('./lib/ssh-auth');
// Remove: const { spawnProvision } = require('./lib/provisioner');
```

**Startup — init DB:**
```js
initDb();
```

**Remove entirely:**
- `loadStore()`, `saveStore()`, `updateSession()`, `_writeLock`
- The `spawnProvision()` call inside `POST /api/onboarding` (webhook owns provisioning now)

**Keep but modify:**
- `deployFilesToInstance()` — keep the SCP file push logic intact. Only change: read `server_ip` / `ssh_key_path` from `getCustomerByStripeSessionId()` instead of JSON store, and guard with `provision_status === 'ready'` check before attempting SCP. Remove any `spawnProvision()` reference inside it.

**Rewrite `POST /api/onboarding`:**
```js
app.post('/api/onboarding', async (req, res) => {
  const sessionId = parseSessionId(req.body?.sessionId || req.body?.session_id);
  if (!sessionId || !isValidSessionId(sessionId)) {
    return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
  }

  try {
    await validateStripeCheckoutSession(sessionId);

    const customer = getCustomerByStripeSessionId(sessionId);
    if (!customer) {
      return res.status(404).json({ ok: false, error: 'Customer not found. Payment may still be processing.' });
    }

    const session = getOnboardingSession(sessionId);

    return res.json({
      ok: true,
      username: customer.username,
      botName: customer.bot_name,
      provisionStatus: customer.provision_status,
      webchatUrl: customer.dns_hostname ? `https://${customer.dns_hostname}` : null,
      step: session?.step || 'quiz',
    });
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 400) {
      return res.status(400).json({ ok: false, error: 'Invalid or expired Stripe checkout session.' });
    }
    return res.status(500).json({ ok: false, error: 'Unable to process onboarding request.' });
  }
});
```

**Rewrite `GET /api/onboarding/status/:sessionId`:**
```js
app.get('/api/onboarding/status/:sessionId', async (req, res) => {
  const sessionId = parseSessionId(req.params.sessionId);
  if (!sessionId || !isValidSessionId(sessionId)) {
    return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
  }

  const customer = getCustomerByStripeSessionId(sessionId);
  if (!customer) {
    return res.status(404).json({ ok: false, error: 'Session not found.' });
  }

  return res.json({
    username: customer.username,
    botName: customer.bot_name,
    provisionStatus: customer.provision_status,
    provisionStage: customer.provision_stage,
    authStatus: customer.auth_status,
    webchatUrl: customer.dns_hostname ? `https://${customer.dns_hostname}` : null,
  });
});
```

**Rewrite `POST /api/onboarding/quiz/:sessionId`:**
```js
app.post('/api/onboarding/quiz/:sessionId', async (req, res) => {
  const sessionId = parseSessionId(req.params.sessionId);
  if (!sessionId || !isValidSessionId(sessionId)) {
    return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
  }

  const session = getOnboardingSession(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found.' });
  }

  updateOnboardingSession(sessionId, {
    quiz_results: JSON.stringify({
      traits: req.body.traits || {},
      dimensionScores: req.body.dimensionScores || {},
      tags: req.body.tags || [],
      freeText: req.body.freeText || {},
      answers: req.body.answers || {},
      perQuestionContext: req.body.perQuestionContext || {},
    }),
    step: 'profile',
  });

  return res.json({ ok: true });
});
```

**Rewrite `POST /api/onboarding/generate-profile/:sessionId`:**
Same logic as current but reads/writes via `getOnboardingSession` / `updateOnboardingSession` instead of the JSON store. Check for cached profile via `session.generated_files`. Store result in `updateOnboardingSession(sessionId, { generated_files: JSON.stringify({...}), step: 'auth' })`.

**Modify `deployFilesToInstance()`:**
Keep all SCP/chmod/docker-restart logic. Change data source: read `server_ip` and `ssh_key_path` from `getCustomerByStripeSessionId(sessionId)` instead of JSON store. Read `generated_files` from `getOnboardingSession(sessionId).generated_files` (parse JSON). Add guard: `if (customer.provision_status !== 'ready') return { ok: false, error: 'Instance not provisioned yet.' };`

**Replace auth endpoint stubs with real ones:**

```js
// POST /api/onboarding/auth/start
app.post('/api/onboarding/auth/start', async (req, res) => {
  const { stripeSessionId, provider } = req.body || {};

  if (!stripeSessionId || !isValidSessionId(stripeSessionId)) {
    return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
  }
  if (!['anthropic', 'openai'].includes(provider)) {
    return res.status(400).json({ ok: false, error: 'Provider must be "anthropic" or "openai".' });
  }

  const customer = getCustomerByStripeSessionId(stripeSessionId);
  if (!customer) {
    return res.status(404).json({ ok: false, error: 'Customer not found.' });
  }
  if (customer.provision_status !== 'ready') {
    return res.status(409).json({ ok: false, error: 'Instance not provisioned yet.' });
  }

  try {
    const { authSessionId, oauthUrl } = await startAuth(provider, customer.server_ip, customer.ssh_key_path);
    return res.json({ ok: true, authSessionId, oauthUrl });
  } catch (error) {
    console.error(`Auth start failed for ${stripeSessionId}: ${error.message}`);
    const status = error.message.includes('Timed out') ? 504 : 502;
    return res.status(status).json({ ok: false, error: error.message });
  }
});

// POST /api/onboarding/auth/complete
app.post('/api/onboarding/auth/complete', async (req, res) => {
  const { authSessionId, code } = req.body || {};

  if (!authSessionId || !code) {
    return res.status(400).json({ ok: false, error: 'authSessionId and code are required.' });
  }

  try {
    const result = await completeAuth(authSessionId, code);

    // Update customer auth status in DB
    // Find customer from the onboarding context (auth session doesn't carry stripeSessionId)
    // The frontend sends stripeSessionId too for this purpose
    const stripeSessionId = req.body.stripeSessionId;
    if (stripeSessionId) {
      const customer = getCustomerByStripeSessionId(stripeSessionId);
      if (customer) {
        updateAuth(customer.id, { authStatus: 'complete', authProvider: result.provider });
        updateOnboardingSession(stripeSessionId, { step: 'complete' });
      }
    }

    return res.json(result);
  } catch (error) {
    console.error(`Auth complete failed: ${error.message}`);
    const status = error.message.includes('not found') ? 404
      : error.message.includes('Timed out') ? 504
      : 400;
    return res.status(status).json({ ok: false, error: error.message });
  }
});
```

**Remove old stub endpoints:**
- Delete `GET /api/onboarding/auth-url/:sessionId`
- Delete `POST /api/onboarding/auth-complete/:sessionId`
- Delete `GET /api/onboarding/ready/:sessionId` (functionality merged into status endpoint)

**Step 2: Verify server starts**

```bash
cd api && node -e "require('./onboarding-server.js')"
```

Expected: Server starts on port 3848, DB initialized.

**Step 3: Commit**

```bash
git add api/onboarding-server.js
git commit -m "feat: rewrite onboarding server — SQLite, drop provisioning, wire real auth endpoints"
```

---

## Task 5: Frontend — Rewrite Onboarding UI

**Files:**
- Modify: `onboarding/index.html`

**Step 1: Remove Step 1 (Your Info) HTML and JS**

Delete:
- The `#step-1` container div (lines ~728-787 in current file)
- All Step 1 JS: `usernameInput`, `botNameInput`, `usernameCheck`, `subdomainPreview`, `step1Form`, `step1Submit`, `step1Error` references and event listeners
- `checkUsername()`, `updateSubdomainPreview()`, Step 1 form submit handler

**Step 2: Update page load initialization**

Replace the Step 1 initialization with an API call to load customer data:

```js
// After session validation, fetch customer data
async function initOnboarding() {
  try {
    const response = await fetch(`${API_BASE}/api/onboarding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    const payload = await readJson(response);

    if (!response.ok || !payload.ok) {
      if (response.status === 404) {
        state.initRetries = (state.initRetries || 0) + 1;
        if (state.initRetries >= 10) {
          // ~30s of retries — bail with support message
          document.getElementById('welcome-screen').querySelector('p').textContent =
            'We couldn\'t find your account. Please contact hello@clawdaddy.sh for help.';
          return;
        }
        document.getElementById('welcome-screen').querySelector('p').textContent =
          'Setting up your account... This may take a moment after payment.';
        setTimeout(initOnboarding, 3000); // retry
        return;
      }
      throw new Error(payload.error || 'Failed to load onboarding data.');
    }

    state.username = payload.username;
    state.botName = payload.botName;
    state.serverStatus = payload.provisionStatus;
    state.serverReady = payload.provisionStatus === 'ready';

    // Update UI with customer info
    document.getElementById('session-preview').textContent = `${payload.username}`;
  } catch (error) {
    console.error('Init failed:', error);
  }
}

// Welcome screen "Start Setup" goes straight to quiz
document.getElementById('start-setup-btn').addEventListener('click', async () => {
  document.getElementById('welcome-screen').style.display = 'none';
  document.getElementById('wizard-content').style.display = '';
  showStep(2); // Skip step 1, go straight to quiz
  startPolling();
  renderQuestion();
});

initOnboarding();
```

**Step 3: Rewrite Step 3 (Auth) HTML and JS**

Replace the `renderStep3` and `selectProvider` functions:

```js
function renderStep3() {
  // Check if provisioning is ready
  if (!state.serverReady) {
    step3Content.innerHTML = `
      <div class="waiting-state">
        <div class="provision-chip">
          <span class="pulse-dot"></span>
          <span>Waiting for your server to finish setting up...</span>
        </div>
        <p style="color: var(--text-muted);">This usually takes 2-3 minutes. We'll continue automatically when it's ready.</p>
      </div>
    `;
    const checkInterval = setInterval(() => {
      if (state.serverReady) {
        clearInterval(checkInterval);
        renderStep3();
      }
    }, 1000);
    return;
  }

  step3Content.innerHTML = `
    <p class="copy">Connect your AI provider so your assistant can think.</p>
    <div class="provider-buttons" id="provider-buttons">
      <button class="provider-btn anthropic" data-provider="anthropic">
        Connect Claude (Anthropic)
      </button>
      <button class="provider-btn openai" data-provider="openai">
        Connect OpenAI
      </button>
    </div>
    <div id="auth-flow-area" class="hidden"></div>
    <p id="auth-error" class="error"></p>
  `;

  step3Content.querySelectorAll('.provider-btn').forEach(btn => {
    btn.addEventListener('click', () => selectProvider(btn.dataset.provider));
  });
}

async function selectProvider(provider) {
  const providerButtons = document.getElementById('provider-buttons');
  const flowArea = document.getElementById('auth-flow-area');
  const authError = document.getElementById('auth-error');

  // Disable buttons while starting
  providerButtons.querySelectorAll('.provider-btn').forEach(b => b.disabled = true);
  authError.textContent = '';

  try {
    const response = await fetch(`${API_BASE}/api/onboarding/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ stripeSessionId: sessionId, provider })
    });
    const payload = await readJson(response);

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Failed to start auth.');
    }

    state.authSessionId = payload.authSessionId;

    // Hide provider buttons, show auth flow
    providerButtons.classList.add('hidden');
    flowArea.classList.remove('hidden');

    const isAnthropic = provider === 'anthropic';
    const instructions = isAnthropic
      ? `Click the link below to sign in with Anthropic. After authorizing, you'll see a code that looks like <code>ABC123#xyz789</code>. Copy the <strong>full code including the # part</strong> and paste it below.`
      : `Click the link below to sign in with OpenAI. After authorizing, your browser will try to load a page that won't work — that's expected. Copy the <strong>full URL from your address bar</strong> and paste it below.`;

    const placeholder = isAnthropic
      ? 'Paste your CODE#STATE here'
      : 'Paste the full redirect URL here';

    flowArea.innerHTML = `
      <div style="margin: 1.2rem 0;">
        <p class="copy" style="margin-bottom: 1rem;">${instructions}</p>
        <a href="${escapeHtml(payload.oauthUrl)}" target="_blank" rel="noopener"
           class="button" style="display: inline-block; text-decoration: none; text-align: center; width: 100%;">
          Sign in with ${isAnthropic ? 'Anthropic' : 'OpenAI'} →
        </a>
      </div>
      <div class="field" style="margin-top: 1.2rem;">
        <label class="label" for="auth-code-input">${isAnthropic ? 'Authorization code' : 'Redirect URL'}</label>
        <input class="input" id="auth-code-input" type="text" placeholder="${placeholder}" autocomplete="off" />
      </div>
      <button class="button" id="auth-submit-btn" style="margin-top: 0.8rem;" disabled>
        Complete Setup
      </button>
      <div class="auth-status hidden" id="auth-progress">
        <span class="pulse-dot"></span>
        <span id="auth-progress-text">Verifying...</span>
      </div>
    `;

    const codeInput = document.getElementById('auth-code-input');
    const submitBtn = document.getElementById('auth-submit-btn');

    codeInput.addEventListener('input', () => {
      submitBtn.disabled = !codeInput.value.trim();
    });

    submitBtn.addEventListener('click', () => submitAuthCode(provider));
  } catch (error) {
    authError.textContent = error.message;
    providerButtons.querySelectorAll('.provider-btn').forEach(b => b.disabled = false);
  }
}

async function submitAuthCode(provider) {
  const codeInput = document.getElementById('auth-code-input');
  const submitBtn = document.getElementById('auth-submit-btn');
  const progress = document.getElementById('auth-progress');
  const authError = document.getElementById('auth-error');

  const code = codeInput.value.trim();
  if (!code) return;

  submitBtn.disabled = true;
  codeInput.disabled = true;
  progress.classList.remove('hidden');
  authError.textContent = '';

  try {
    const response = await fetch(`${API_BASE}/api/onboarding/auth/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        authSessionId: state.authSessionId,
        code,
        stripeSessionId: sessionId
      })
    });
    const payload = await readJson(response);

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Authorization failed.');
    }

    // Success
    document.getElementById('auth-progress-text').textContent = `${provider === 'anthropic' ? 'Claude' : 'OpenAI'} connected!`;
    progress.classList.add('confirmed');

    setTimeout(() => {
      state.authComplete = true;
      showStep(4);
      renderSetupComplete();
    }, 1500);
  } catch (error) {
    authError.textContent = error.message + ' Please try again.';
    submitBtn.disabled = false;
    codeInput.disabled = false;
    progress.classList.add('hidden');
  }
}
```

**Step 4: Update quiz submission to transition to Step 3**

In `submitQuiz()`, after profile generation succeeds, change `showStep(4)` to:
```js
showStep(3);
renderStep3();
```

**Step 5: Update Step 4 (success screen) to show portal password**

In `renderSetupComplete()`, add the portal password display. The password comes from the onboarding session (generated during provisioning). Fetch it from the status endpoint or include it in the auth/complete response.

**Step 6: Verify frontend loads**

Open `onboarding/index.html?session_id=cs_test_123` in a browser. Verify:
- Welcome screen appears
- Click "Start Setup" → goes to quiz (step 2), not step 1
- No JS errors in console

**Step 7: Commit**

```bash
git add onboarding/index.html
git commit -m "feat: rewrite onboarding frontend — drop step 1, inline auth flow, provider instructions"
```

---

## Task 6: Integration Verification

**Step 1: Verify both servers start cleanly**

```bash
cd api && node -e "require('./onboarding-server.js')" &
cd script/webhook-server && node -e "import('./server.js')" &
```

Check: both start without errors, `data/clawdaddy.db` created with both tables.

**Step 2: Run all tests**

```bash
cd api && node --test lib/db.test.js lib/ssh-auth.test.js
```

**Step 3: Verify SQLite migration**

If `customers.json` or `onboarding-data.json` exist, verify records migrated correctly:
```bash
sqlite3 data/clawdaddy.db "SELECT count(*) FROM customers; SELECT count(*) FROM onboarding_sessions;"
```

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: integration verification pass"
```

---

## Execution Notes

- **Task 1 (db.js)** must complete before Tasks 2-4 — everything depends on it
- **Tasks 2 and 3** can be done in parallel (webhook server and onboarding server are independent)
- **Task 3** depends on Task 3's SSH module (ssh-auth.js), so Task 3 (SSH) should be done before Task 4 (onboarding rewrite) — renumbered accordingly above
- **Task 5** (frontend) depends on Task 4's endpoints being in place
- **Task 6** is the integration check — runs after everything else

The `writeAuthProfile()` function in ssh-auth.js will need refinement once we can test against a real Lightsail instance. The auth-profiles.json path and format should be verified against an actual instance's file structure. Reference: `docs/auth-flow-anthropic.md` line 108 and `docs/auth-flow-openai.md` line 86.
