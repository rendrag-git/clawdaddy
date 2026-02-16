#!/usr/bin/env node

const express = require('express');
const cors = require('cors');
const https = require('https');
const path = require('path');
const { promises: fs } = require('fs');
const { generateProfile } = require('./lib/profile-generator');
const { spawnProvision } = require('./lib/provisioner');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT || 3848);

const STRIPE_KEY_PATH = process.env.STRIPE_KEY_PATH || '/home/ubuntu/clawd/.secrets/stripe-key';
const DATA_FILE = process.env.ONBOARDING_STORE_PATH || path.join(__dirname, 'onboarding-data.json');
const WEBCHAT_BASE_URL = (process.env.WEBCHAT_BASE_URL || 'https://chat.clawdaddy.sh').replace(/\/+$/, '');


const allowedOrigins = new Set([
  'https://clawdaddy.sh',
  'https://www.clawdaddy.sh',
  'https://getclawdaddy.com',
  'https://www.getclawdaddy.com',
  'http://localhost',
  'http://localhost:3000',
  'http://18.209.163.24:3848'
]);

const SESSION_ID_REGEX = /^cs_[a-zA-Z0-9_]+$/;

function isValidIPv4(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
    ip.split('.').every(n => parseInt(n, 10) <= 255);
}

const VALID_REGIONS = new Set([
  'us-east-1', 'us-east-2', 'us-west-2', 'ca-central-1',
  'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1',
  'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'ap-south-1'
]);

const dnsUpdateLastCall = new Map(); // username -> timestamp

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

// Serve onboarding UI
app.use(express.static(path.join(__dirname, '..', 'onboarding')));

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
  if (record.dnsHostname) {
    return `https://${record.dnsHostname}`;
  }
  // Fallback for pre-DNS customers
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


app.post('/api/onboarding', async (req, res) => {
  const timestamp = new Date().toISOString();

  try {
    const displayName = normalizeName(req.body?.displayName);
    const assistantName = normalizeName(req.body?.assistantName);
    const sessionId = parseSessionId(req.body?.sessionId || req.body?.session_id || req.body?.stripeSessionId);

    const region = req.body?.region || 'us-east-1';
    if (!VALID_REGIONS.has(region)) {
      return res.status(400).json({ ok: false, error: 'Invalid region.' });
    }

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
    record.region = region;

    store.sessions[sessionId] = record;
    await saveStore(store);

    // Fire-and-forget: spawn real provisioning in background
    // Tech debt: saveStore() calls in the stage callback and .then() are not
    // serialized. At low volume this is fine. At scale, use a write queue or
    // per-session lock to prevent interleaved JSON writes.
    void spawnProvision({
      email: checkoutSession.customer_details?.email || record.stripeCustomerEmail || '',
      username: record.username,
      tier: 'managed',
      region,
      stripeCustomerId: record.stripeCustomerId || '',
      stripeCheckoutSessionId: sessionId,
    }, (stage) => {
      record.provisionStage = stage;
      record.updatedAt = new Date().toISOString();
      saveStore(store);
    }).then(result => {
      record.status = 'ready';
      record.serverIp = result.serverIp;
      record.sshKeyPath = result.sshKeyPath;
      record.customerId = result.customerId;
      record.vncPassword = result.vncPassword;
      record.dnsHostname = result.dnsHostname;
      record.provisionStage = 'complete';
      record.readyAt = new Date().toISOString();
      record.updatedAt = new Date().toISOString();
      if (result.dnsHostname) {
        record.webchatUrl = `https://${result.dnsHostname}`;
      }
      store.sessions[sessionId] = record;
      saveStore(store);
      console.log(`Provisioning complete for session ${sessionId}: ${result.serverIp}`);
    }).catch(err => {
      record.status = 'failed';
      record.provisionError = err.message;
      record.updatedAt = new Date().toISOString();
      store.sessions[sessionId] = record;
      saveStore(store);
      console.error(`Provisioning failed for session ${sessionId}: ${err.message}`);
    });

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

app.post('/api/dns-update', async (req, res) => {
  try {
    const { username, ip, token } = req.body || {};

    if (!username || !ip || !token) {
      return res.status(400).json({ ok: false, error: 'Missing username, ip, or token.' });
    }

    if (!isValidIPv4(ip)) {
      return res.status(400).json({ ok: false, error: 'Invalid IPv4 address.' });
    }

    // Rate limit: 1 call per username per 60 seconds
    const lastCall = dnsUpdateLastCall.get(username);
    if (lastCall && Date.now() - lastCall < 60_000) {
      return res.status(429).json({ ok: false, error: 'Rate limited. Try again in 60 seconds.' });
    }

    // Validate token against customers.json
    const customersPath = process.env.CUSTOMERS_FILE || path.join(__dirname, '..', 'customers.json');
    const customersRaw = await fs.readFile(customersPath, 'utf8');
    const customers = JSON.parse(customersRaw);
    const customer = customers.customers.find(
      c => c.username === username && c.dns_token === token
    );

    if (!customer) {
      return res.status(401).json({ ok: false, error: 'Invalid credentials.' });
    }

    // Update Route 53
    const hostedZoneId = process.env.ROUTE53_HOSTED_ZONE_ID;
    if (!hostedZoneId) {
      return res.status(502).json({ ok: false, error: 'DNS not configured on server.' });
    }

    const changeBatch = JSON.stringify({
      Changes: [{
        Action: 'UPSERT',
        ResourceRecordSet: {
          Name: `${username}.clawdaddy.sh`,
          Type: 'A',
          TTL: 300,
          ResourceRecords: [{ Value: ip }]
        }
      }]
    });

    const { exec } = require('node:child_process');
    const profileArg = process.env.ROUTE53_AWS_PROFILE ? ` --profile ${process.env.ROUTE53_AWS_PROFILE}` : '';
    await new Promise((resolve, reject) => {
      exec(
        `aws route53 change-resource-record-sets --hosted-zone-id "${hostedZoneId}" --change-batch '${changeBatch}'${profileArg}`,
        { timeout: 15000 },
        (err) => err ? reject(err) : resolve()
      );
    });

    dnsUpdateLastCall.set(username, Date.now());

    console.log(`DNS updated: ${username}.clawdaddy.sh -> ${ip}`);
    return res.json({ ok: true, hostname: `${username}.clawdaddy.sh` });
  } catch (err) {
    console.error('DNS update failed:', err.message);
    return res.status(502).json({ ok: false, error: 'DNS update failed.' });
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

    return res.json({
      status: record.status,
      provisionStage: record.provisionStage || null,
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

    if (record.status !== 'ready' || !record.serverIp || !record.sshKeyPath) {
      return res.status(400).json({ ok: false, error: 'Instance not provisioned yet. Please wait for provisioning to complete.' });
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

    // Validate server IP and SSH key path before SCP
    const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!record.serverIp || !ipPattern.test(record.serverIp)) {
      return res.status(400).json({ ok: false, error: 'Invalid server IP' });
    }
    const keyPathPattern = /^\/[\w\-/.]+$/;
    if (!record.sshKeyPath || !keyPathPattern.test(record.sshKeyPath)) {
      return res.status(400).json({ ok: false, error: 'Invalid SSH key path' });
    }

    // Deploy files to customer instance via SCP
    let filesDeployed = false;
    try {
      // ConnectTimeout=30 because the health check only verifies HTTP :8080,
      // not SSH readiness. SSH may need a few extra seconds after health passes.
      const scpOpts = ['-i', record.sshKeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=30'];
      const remoteBase = `ubuntu@${record.serverIp}:/home/ubuntu/clawd`;

      for (const filename of ['SOUL.md', 'USER.md', 'IDENTITY.md', 'BOOTSTRAP.md']) {
        await execFileAsync('scp', [...scpOpts, path.join(outputDir, filename), `${remoteBase}/${filename}`]);
      }

      await execFileAsync('ssh', [
        '-i', record.sshKeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=30',
        `ubuntu@${record.serverIp}`,
        'chmod 644 /home/ubuntu/clawd/SOUL.md /home/ubuntu/clawd/USER.md /home/ubuntu/clawd/IDENTITY.md /home/ubuntu/clawd/BOOTSTRAP.md'
      ]);

      filesDeployed = true;
      console.log(`Files deployed to ${record.serverIp} for session ${sessionId}`);
    } catch (scpErr) {
      console.error(`SCP deployment failed for ${sessionId}: ${scpErr.message}`);
    }

    record.filesDeployed = filesDeployed;
    record.filesWrittenAt = new Date().toISOString();
    record.updatedAt = new Date().toISOString();

    store.sessions[sessionId] = record;
    await saveStore(store);

    console.log(`Files written for session ${sessionId} to ${outputDir}`);
    return res.json({
      ok: true,
      written: ['SOUL.md', 'USER.md', 'IDENTITY.md', 'BOOTSTRAP.md'],
      deployed: filesDeployed
    });
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
