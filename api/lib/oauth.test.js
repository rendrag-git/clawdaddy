const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateVerifier, generateChallenge, generateState } = require('./oauth');

describe('PKCE helpers', () => {
  it('generateVerifier returns base64url string of expected length', () => {
    const v = generateVerifier();
    assert.ok(v.length >= 40, `verifier too short: ${v.length}`);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(v), 'verifier must be base64url');
  });

  it('generateChallenge returns deterministic SHA-256 of verifier', () => {
    const v = generateVerifier();
    const c1 = generateChallenge(v);
    const c2 = generateChallenge(v);
    assert.equal(c1, c2);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(c1), 'challenge must be base64url');
    assert.notEqual(c1, v, 'challenge should differ from verifier');
  });

  it('generateState returns unique values', () => {
    const s1 = generateState();
    const s2 = generateState();
    assert.notEqual(s1, s2);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(s1), 'state must be base64url');
  });
});

describe('startAuth', () => {
  it('returns a well-formed authorize URL and stores state', () => {
    const stored = {};
    const customer = { id: 'oc_test123' };
    const { startAuth } = require('./oauth');

    const result = startAuth(customer, {
      storeOAuthState: (id, data) => { stored.id = id; stored.data = data; },
    });

    assert.ok(result.url.startsWith('https://claude.ai/oauth/authorize'), 'URL must start with authorize endpoint');
    assert.ok(result.url.includes('code_challenge='), 'URL must include code_challenge');
    assert.ok(result.url.includes('code_challenge_method=S256'), 'URL must include S256 method');
    assert.ok(result.url.includes('state='), 'URL must include state');
    assert.ok(result.url.includes('scope=user%3Ainference'), 'URL must include scope');
    assert.equal(stored.id, 'oc_test123');
    assert.ok(stored.data.oauthVerifier);
    assert.ok(stored.data.oauthState);
  });
});

describe('completeAuth — input validation', () => {
  it('rejects code without # separator', async () => {
    const { completeAuth } = require('./oauth');
    const customer = { id: 'oc_test', oauth_state: 'abc', oauth_verifier: 'def' };
    await assert.rejects(
      () => completeAuth(customer, 'no-hash-here', { clearOAuthState: () => {}, updateAuth: () => {} }),
      { message: /Invalid code format/ }
    );
  });

  it('rejects state mismatch', async () => {
    const { completeAuth } = require('./oauth');
    const customer = { id: 'oc_test', oauth_state: 'expected-state', oauth_verifier: 'def' };
    await assert.rejects(
      () => completeAuth(customer, 'code#wrong-state', { clearOAuthState: () => {}, updateAuth: () => {} }),
      { message: /State mismatch/ }
    );
  });

  it('rejects when no pending auth session', async () => {
    const { completeAuth } = require('./oauth');
    const customer = { id: 'oc_test', oauth_state: null, oauth_verifier: null };
    await assert.rejects(
      () => completeAuth(customer, 'code#state', { clearOAuthState: () => {}, updateAuth: () => {} }),
      { message: /No pending auth session/ }
    );
  });
});
