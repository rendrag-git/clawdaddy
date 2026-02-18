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
    assert.match(id, /^oc_[a-f0-9]{16}$/);
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

  it('updateCustomer sets stripe_subscription_id, status, and destroy_scheduled_at', () => {
    const id = db.createCustomer({ username: 'eve', email: 'eve@test.com' });
    db.updateCustomer(id, {
      stripe_subscription_id: 'sub_abc123',
      status: 'active',
      destroy_scheduled_at: '2026-12-31T00:00:00Z',
    });
    const c = db.getCustomerById(id);
    assert.equal(c.stripe_subscription_id, 'sub_abc123');
    assert.equal(c.status, 'active');
    assert.equal(c.destroy_scheduled_at, '2026-12-31T00:00:00Z');
  });

  it('rejects duplicate username', () => {
    db.createCustomer({ username: 'frank2', email: 'frank2@test.com' });
    assert.throws(() => {
      db.createCustomer({ username: 'frank2', email: 'frank2b@test.com' });
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
