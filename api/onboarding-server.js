#!/usr/bin/env node

const express = require('express');
const cors = require('cors');
const https = require('https');
const path = require('path');
const { promises: fs } = require('fs');
const { generateProfile } = require('./lib/profile-generator');

const app = express();
const PORT = Number(process.env.PORT || 3848);

const STRIPE_KEY_PATH = process.env.STRIPE_KEY_PATH || '/home/ubuntu/clawd/.secrets/stripe-key';
const DATA_FILE = process.env.ONBOARDING_STORE_PATH || path.join(__dirname, 'onboarding-data.json');
const WEBCHAT_BASE_URL = (process.env.WEBCHAT_BASE_URL || 'https://chat.clawdaddy.sh').replace(/\/+$/, '');
const QUEUED_TO_PROVISIONING_MS = Number(process.env.QUEUED_TO_PROVISIONING_MS || 15000);
const PROVISIONING_TO_READY_MS = Number(process.env.PROVISIONING_TO_READY_MS || 45000);
const AUTO_PROGRESS = process.env.ONBOARDING_AUTO_PROGRESS !== 'false';

const allowedOrigins = new Set([
  'https://clawdaddy.sh',
  'https://www.clawdaddy.sh',
  'https://getclawdaddy.com',
  'https://www.getclawdaddy.com',
  'http://localhost',
  'http://localhost:3000'
]);

const SESSION_ID_REGEX = /^cs_[a-zA-Z0-9_]+$/;

let cachedStripeKey = null;

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origin not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  credentials: true
}));
app.use(express.json());

function normalizeName(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

function parseSessionId(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function isValidSessionId(sessionId) {
  return SESSION_ID_REGEX.test(sessionId);
}

function slugify(input) {
  const slug = (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || 'assistant';
}

function buildWebchatUrl(record) {
  const suffix = record.sessionId.slice(-8).toLowerCase();
  const slug = slugify(record.assistantName || record.displayName);
  return `${WEBCHAT_BASE_URL}/${slug}-${suffix}`;
}

async function getStripeSecretKey() {
  if (cachedStripeKey) return cachedStripeKey;

  const raw = await fs.readFile(STRIPE_KEY_PATH, 'utf8');
  const key = raw.trim();

  if (!key) {
    throw new Error(`Stripe key file is empty: ${STRIPE_KEY_PATH}`);
  }

  cachedStripeKey = key;
  return cachedStripeKey;
}

function stripeGet(pathname, secretKey) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.stripe.com',
        method: 'GET',
        path: pathname,
        headers: {
          Authorization: `Bearer ${secretKey}`
        }
      },
      (response) => {
        let body = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });

        response.on('end', () => {
          let parsed;
          try {
            parsed = body ? JSON.parse(body) : {};
          } catch (error) {
            reject(new Error('Stripe response was not valid JSON.'));
            return;
          }

          const ok = response.statusCode >= 200 && response.statusCode < 300;
          if (!ok) {
            const message = parsed?.error?.message || `Stripe API request failed with ${response.statusCode}`;
            const stripeError = new Error(message);
            stripeError.statusCode = response.statusCode;
            stripeError.details = parsed;
            reject(stripeError);
            return;
          }

          resolve(parsed);
        });
      }
    );

    request.on('error', (error) => reject(error));
    request.end();
  });
}

function isPaidCheckoutSession(session) {
  return Boolean(
    session
      && session.object === 'checkout.session'
      && session.status === 'complete'
      && (session.payment_status === 'paid' || session.payment_status === 'no_payment_required')
  );
}

async function validateStripeCheckoutSession(sessionId) {
  const stripeKey = await getStripeSecretKey();
  const session = await stripeGet(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, stripeKey);

  if (!isPaidCheckoutSession(session)) {
    const message = 'Checkout session is not complete and paid.';
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }

  return session;
}

async function loadStore() {
  try {
    const content = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(content);

    if (!parsed || typeof parsed !== 'object') {
      return { sessions: {} };
    }

    if (!parsed.sessions || typeof parsed.sessions !== 'object') {
      parsed.sessions = {};
    }

    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { sessions: {} };
    }

    throw error;
  }
}

async function saveStore(store) {
  const directory = path.dirname(DATA_FILE);
  await fs.mkdir(directory, { recursive: true });

  const tmpPath = `${DATA_FILE}.tmp`;
  const payload = `${JSON.stringify(store, null, 2)}\n`;

  await fs.writeFile(tmpPath, payload, 'utf8');
  await fs.rename(tmpPath, DATA_FILE);
}

function advanceStatus(record, nowMs) {
  let changed = false;

  if (record.status === 'queued') {
    const queuedAtMs = Date.parse(record.queuedAt || record.createdAt || '');
    if (Number.isFinite(queuedAtMs) && (nowMs - queuedAtMs) >= QUEUED_TO_PROVISIONING_MS) {
      record.status = 'provisioning';
      record.provisioningAt = new Date(nowMs).toISOString();
      changed = true;
    }
  }

  if (record.status === 'provisioning') {
    const provisioningAtMs = Date.parse(record.provisioningAt || record.updatedAt || record.createdAt || '');
    if (Number.isFinite(provisioningAtMs) && (nowMs - provisioningAtMs) >= PROVISIONING_TO_READY_MS) {
      record.status = 'ready';
      record.readyAt = new Date(nowMs).toISOString();
      if (!record.webchatUrl) {
        record.webchatUrl = buildWebchatUrl(record);
      }
      changed = true;
    }
  }

  if (changed) {
    record.updatedAt = new Date(nowMs).toISOString();
  }

  return changed;
}

app.post('/api/onboarding', async (req, res) => {
  const timestamp = new Date().toISOString();

  try {
    const displayName = normalizeName(req.body?.displayName);
    const assistantName = normalizeName(req.body?.assistantName);
    const sessionId = parseSessionId(req.body?.sessionId || req.body?.session_id || req.body?.stripeSessionId);

    if (!displayName || displayName.length < 2 || displayName.length > 80) {
      return res.status(400).json({ ok: false, error: 'Display name must be 2-80 characters.' });
    }

    if (!assistantName || assistantName.length < 2 || assistantName.length > 80) {
      return res.status(400).json({ ok: false, error: 'Assistant name must be 2-80 characters.' });
    }

    if (!sessionId || !isValidSessionId(sessionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid Stripe session ID.' });
    }

    const checkoutSession = await validateStripeCheckoutSession(sessionId);

    const store = await loadStore();
    const existing = store.sessions[sessionId] || {};

    const nowIso = new Date().toISOString();
    const status = existing.status || 'queued';

    const record = {
      ...existing,
      sessionId,
      displayName,
      assistantName,
      status,
      webchatUrl: existing.webchatUrl || buildWebchatUrl({ sessionId, displayName, assistantName }),
      stripeCustomerId: checkoutSession.customer || null,
      stripeCustomerEmail: checkoutSession.customer_details?.email || null,
      stripePaymentStatus: checkoutSession.payment_status || null,
      stripeStatus: checkoutSession.status || null,
      createdAt: existing.createdAt || nowIso,
      queuedAt: existing.queuedAt || nowIso,
      updatedAt: nowIso
    };

    if (record.status === 'provisioning' && !record.provisioningAt) {
      record.provisioningAt = nowIso;
    }

    if (record.status === 'ready' && !record.readyAt) {
      record.readyAt = nowIso;
    }

    record.username = slugify(displayName);

    store.sessions[sessionId] = record;
    await saveStore(store);

    console.log(`[${timestamp}] Onboarding submitted for session ${sessionId}`);

    return res.json({
      ok: true,
      status: record.status,
      webchatUrl: record.status === 'ready' ? record.webchatUrl : null
    });
  } catch (error) {
    console.error(`[${timestamp}] Failed onboarding submit:`, error.message);

    if (error.statusCode === 404 || error.statusCode === 400) {
      return res.status(400).json({ ok: false, error: 'Invalid or expired Stripe checkout session.' });
    }

    return res.status(500).json({ ok: false, error: 'Unable to process onboarding request.' });
  }
});

app.get('/api/onboarding/status/:sessionId', async (req, res) => {
  const sessionId = parseSessionId(req.params.sessionId);

  try {
    if (!sessionId || !isValidSessionId(sessionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
    }

    const store = await loadStore();
    const record = store.sessions[sessionId];

    if (!record) {
      return res.status(404).json({ ok: false, error: 'Session not found.' });
    }

    if (AUTO_PROGRESS) {
      const nowMs = Date.now();
      const changed = advanceStatus(record, nowMs);
      if (changed) {
        store.sessions[sessionId] = record;
        await saveStore(store);
      }
    }

    return res.json({
      status: record.status,
      webchatUrl: record.status === 'ready' ? record.webchatUrl : null
    });
  } catch (error) {
    console.error(`Status lookup failed for ${sessionId}:`, error.message);
    return res.status(500).json({ ok: false, error: 'Unable to fetch onboarding status.' });
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/onboarding/check-username/:username', async (req, res) => {
  try {
    const raw = (req.params.username || '').toLowerCase().trim();

    // Validate format: lowercase, alphanumeric + hyphens, 3-20 chars, no leading/trailing hyphens
    const usernameRegex = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;
    if (!raw || raw.length < 3 || raw.length > 20 || !usernameRegex.test(raw)) {
      return res.status(400).json({
        available: false,
        error: 'Username must be 3-20 characters, lowercase alphanumeric and hyphens, no leading/trailing hyphens.',
        suggestion: null
      });
    }

    const store = await loadStore();

    // Check against existing usernames in all sessions
    const taken = Object.values(store.sessions).some(
      s => s.username === raw || slugify(s.displayName) === raw
    );

    if (taken) {
      // Suggest alternatives: append numbers
      let suggestion = null;
      for (let i = 1; i <= 99; i++) {
        const candidate = `${raw}${i}`;
        if (candidate.length <= 20) {
          const candidateTaken = Object.values(store.sessions).some(
            s => s.username === candidate || slugify(s.displayName) === candidate
          );
          if (!candidateTaken) {
            suggestion = candidate;
            break;
          }
        }
      }
      return res.json({ available: false, suggestion });
    }

    return res.json({ available: true, suggestion: null });
  } catch (error) {
    console.error('Username check failed:', error.message);
    return res.status(500).json({ available: false, error: 'Unable to check username availability.' });
  }
});

app.post('/api/onboarding/quiz/:sessionId', async (req, res) => {
  const sessionId = parseSessionId(req.params.sessionId);

  try {
    if (!sessionId || !isValidSessionId(sessionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
    }

    const store = await loadStore();
    const record = store.sessions[sessionId];

    if (!record) {
      return res.status(404).json({ ok: false, error: 'Session not found.' });
    }

    // Store quiz results alongside onboarding record
    record.quizResults = {
      traits: req.body.traits || {},
      dimensionScores: req.body.dimensionScores || {},
      tags: req.body.tags || [],
      freeText: req.body.freeText || {},
      answers: req.body.answers || {},
      perQuestionContext: req.body.perQuestionContext || {},
      submittedAt: new Date().toISOString()
    };
    record.updatedAt = new Date().toISOString();

    store.sessions[sessionId] = record;
    await saveStore(store);

    console.log(`Quiz results saved for session ${sessionId}`);
    return res.json({ ok: true });
  } catch (error) {
    console.error(`Quiz save failed for ${sessionId}:`, error.message);
    return res.status(500).json({ ok: false, error: 'Unable to save quiz results.' });
  }
});

app.post('/api/onboarding/generate-profile/:sessionId', async (req, res) => {
  const sessionId = parseSessionId(req.params.sessionId);

  try {
    if (!sessionId || !isValidSessionId(sessionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
    }

    const store = await loadStore();
    const record = store.sessions[sessionId];

    if (!record) {
      return res.status(404).json({ ok: false, error: 'Session not found.' });
    }

    if (!record.quizResults) {
      return res.status(400).json({ ok: false, error: 'Quiz results not found. Submit quiz first.' });
    }

    const username = record.username || slugify(record.displayName);
    const botName = record.assistantName || 'Assistant';

    const { soulMd, userMd, identityMd } = await generateProfile(
      record.quizResults,
      username,
      botName
    );

    record.generatedFiles = { soulMd, userMd, identityMd };
    record.profileGeneratedAt = new Date().toISOString();
    record.updatedAt = new Date().toISOString();

    store.sessions[sessionId] = record;
    await saveStore(store);

    console.log(`Profile generated for session ${sessionId}`);
    return res.json({ ok: true, files: ['SOUL.md', 'USER.md', 'IDENTITY.md'] });
  } catch (error) {
    console.error(`Profile generation failed for ${sessionId}:`, error.message);
    return res.status(500).json({ ok: false, error: 'Unable to generate profile.' });
  }
});

app.post('/api/onboarding/write-files/:sessionId', async (req, res) => {
  const sessionId = parseSessionId(req.params.sessionId);

  try {
    if (!sessionId || !isValidSessionId(sessionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
    }

    const store = await loadStore();
    const record = store.sessions[sessionId];

    if (!record) {
      return res.status(404).json({ ok: false, error: 'Session not found.' });
    }

    if (!record.generatedFiles) {
      return res.status(400).json({ ok: false, error: 'Profile not generated yet.' });
    }

    const username = record.username || slugify(record.displayName);

    // TODO: SSH to customer instance — for now, write to local directory
    const baseDir = path.join(__dirname, 'generated');
    const outputDir = path.resolve(baseDir, username);
    if (!outputDir.startsWith(baseDir)) {
      return res.status(400).json({ ok: false, error: 'Invalid username for file path.' });
    }
    await fs.mkdir(outputDir, { recursive: true });

    // Write generated files
    await fs.writeFile(path.join(outputDir, 'SOUL.md'), record.generatedFiles.soulMd, 'utf8');
    await fs.writeFile(path.join(outputDir, 'USER.md'), record.generatedFiles.userMd, 'utf8');
    await fs.writeFile(path.join(outputDir, 'IDENTITY.md'), record.generatedFiles.identityMd, 'utf8');

    // Write BOOTSTRAP.md template
    const bootstrapPath = path.join(__dirname, '..', 'templates', 'BOOTSTRAP.md');
    let bootstrapContent;
    try {
      bootstrapContent = await fs.readFile(bootstrapPath, 'utf8');
    } catch (_err) {
      bootstrapContent = '# Welcome\nBootstrap template not found.';
    }
    await fs.writeFile(path.join(outputDir, 'BOOTSTRAP.md'), bootstrapContent, 'utf8');

    record.filesWritten = true;
    record.filesWrittenAt = new Date().toISOString();
    record.updatedAt = new Date().toISOString();

    store.sessions[sessionId] = record;
    await saveStore(store);

    console.log(`Files written for session ${sessionId} to ${outputDir}`);
    return res.json({ ok: true, written: ['SOUL.md', 'USER.md', 'IDENTITY.md', 'BOOTSTRAP.md'] });
  } catch (error) {
    console.error(`File write failed for ${sessionId}:`, error.message);
    return res.status(500).json({ ok: false, error: 'Unable to write files.' });
  }
});

app.get('/api/onboarding/auth-url/:sessionId', async (req, res) => {
  const sessionId = parseSessionId(req.params.sessionId);

  try {
    if (!sessionId || !isValidSessionId(sessionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
    }

    const store = await loadStore();
    const record = store.sessions[sessionId];

    if (!record) {
      return res.status(404).json({ ok: false, error: 'Session not found.' });
    }

    // TODO: wire to real OAuth provider URLs
    if (record.status !== 'ready') {
      return res.json({ status: 'pending' });
    }

    const username = record.username || slugify(record.displayName);
    const provider = req.query.provider || 'anthropic';
    return res.json({
      status: 'ready',
      url: `https://auth.clawdaddy.sh/oauth/authorize?provider=${encodeURIComponent(provider)}&instance=${encodeURIComponent(username)}&session=${encodeURIComponent(sessionId)}`,
      provider
    });
  } catch (error) {
    console.error(`Auth URL fetch failed for ${sessionId}:`, error.message);
    return res.status(500).json({ ok: false, error: 'Unable to get auth URL.' });
  }
});

app.post('/api/onboarding/auth-complete/:sessionId', async (req, res) => {
  const sessionId = parseSessionId(req.params.sessionId);

  try {
    if (!sessionId || !isValidSessionId(sessionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
    }

    const store = await loadStore();
    const record = store.sessions[sessionId];

    if (!record) {
      return res.status(404).json({ ok: false, error: 'Session not found.' });
    }

    // TODO: wire to real OAuth callback verification
    record.authComplete = true;
    record.authCompletedAt = new Date().toISOString();
    record.updatedAt = new Date().toISOString();

    store.sessions[sessionId] = record;
    await saveStore(store);

    console.log(`Auth completed for session ${sessionId}`);
    return res.json({ ok: true });
  } catch (error) {
    console.error(`Auth complete failed for ${sessionId}:`, error.message);
    return res.status(500).json({ ok: false, error: 'Unable to complete auth.' });
  }
});

app.get('/api/onboarding/ready/:sessionId', async (req, res) => {
  const sessionId = parseSessionId(req.params.sessionId);

  try {
    if (!sessionId || !isValidSessionId(sessionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
    }

    const store = await loadStore();
    const record = store.sessions[sessionId];

    if (!record) {
      return res.status(404).json({ ok: false, error: 'Session not found.' });
    }

    // Advance status if auto-progress is on
    if (AUTO_PROGRESS) {
      const changed = advanceStatus(record, Date.now());
      if (changed) {
        store.sessions[sessionId] = record;
        await saveStore(store);
      }
    }

    const username = record.username || slugify(record.displayName);
    const allReady = record.status === 'ready'
      && record.filesWritten
      && record.authComplete;

    if (!allReady) {
      return res.json({ status: 'pending' });
    }

    return res.json({
      status: 'ready',
      webchatUrl: `https://${username}.clawdaddy.sh`
    });
  } catch (error) {
    console.error(`Ready check failed for ${sessionId}:`, error.message);
    return res.status(500).json({ ok: false, error: 'Unable to check readiness.' });
  }
});

app.listen(PORT, () => {
  console.log(`ClawDaddy onboarding API listening on port ${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`Stripe key path: ${STRIPE_KEY_PATH}`);
});
