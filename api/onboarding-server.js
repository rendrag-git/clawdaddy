#!/usr/bin/env node

const express = require('express');
const cors = require('cors');
const https = require('https');
const path = require('path');
const { promises: fs } = require('fs');
const { generateProfile } = require('./lib/profile-generator');
const { initDb, getDb, getCustomerByStripeSessionId, getCustomerByUsername, getOnboardingSession, updateOnboardingSession, updateAuth, isUsernameAvailable, reserveUsername, sweepExpiredReservations, storeOAuthState, clearOAuthState } = require('./lib/db');
const { startAuth, completeAuth, authWithApiKey, getProviderList } = require('./lib/oauth');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

initDb();

// Sweep expired username reservations every 5 minutes
setInterval(() => {
  const swept = sweepExpiredReservations();
  if (swept > 0) console.log(`[reservations] swept ${swept} expired`);
}, 5 * 60 * 1000);

const app = express();
const PORT = Number(process.env.PORT || 3848);

const STRIPE_KEY_PATH = process.env.STRIPE_KEY_PATH || '/home/ubuntu/clawd/.secrets/stripe-key';
const allowedOrigins = new Set([
  'https://clawdaddy.sh',
  'https://www.clawdaddy.sh',
  'https://getclawdaddy.com',
  'https://www.getclawdaddy.com',
  'http://localhost',
  'http://localhost:3000',
  'http://18.209.163.24:3848',
  'http://3.230.7.207',
  'http://3.230.7.207:3848',
  'https://api.clawdaddy.sh'
]);

const SESSION_ID_REGEX = /^cs_[a-zA-Z0-9_]+$/;

function isValidIPv4(ip) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
    ip.split('.').every(n => parseInt(n, 10) <= 255);
}

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

function parseSessionId(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function isValidSessionId(sessionId) {
  return SESSION_ID_REGEX.test(sessionId);
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


const DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1472970106089898016/hl88EjM5QcO7NpDCtTc17NbYcvyNXFvv3cb0CckcxS8zBj6uV0-KleMQBSGTsbm2-c7V';

function sendDiscordAlert(message) {
  const body = JSON.stringify({ content: message });
  const url = new URL(DISCORD_WEBHOOK_URL);
  const req = https.request({
    hostname: url.hostname,
    path: url.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, () => {});
  req.on('error', (err) => console.error('Discord alert failed:', err.message));
  req.write(body);
  req.end();
}

async function tryDeployIfReady(sessionId) {
  const customer = getCustomerByStripeSessionId(sessionId);
  if (!customer || customer.provision_status !== 'ready') return;

  const session = getOnboardingSession(sessionId);
  if (!session || !session.generated_files) return;

  // Idempotent check-and-set: only one caller wins
  const result = getDb().prepare(
    "UPDATE onboarding_sessions SET deploy_status = 'deploying' WHERE stripe_session_id = ? AND deploy_status = 'pending'"
  ).run(sessionId);
  if (result.changes !== 1) return; // Another trigger already claimed it

  try {
    const deployResult = await deployFilesToInstance(sessionId);
    if (deployResult.ok && deployResult.deployed) {
      updateOnboardingSession(sessionId, { deploy_status: 'deployed' });
      console.log(`[auto-deploy] Files deployed for ${customer.username} (session ${sessionId})`);
    } else {
      updateOnboardingSession(sessionId, { deploy_status: 'failed' });
      const errMsg = deployResult.error || 'deploy returned ok=false';
      console.error(`[auto-deploy] Failed for ${customer.username}: ${errMsg}`);
      sendDiscordAlert(`Deploy failed for ${customer.username} (session ${sessionId}): ${errMsg}`);
    }
  } catch (err) {
    updateOnboardingSession(sessionId, { deploy_status: 'failed' });
    console.error(`[auto-deploy] Exception for ${customer.username}: ${err.message}`);
    sendDiscordAlert(`Deploy failed for ${customer.username} (session ${sessionId}): ${err.message}`);
  }
}

async function deployFilesToInstance(sessionId) {
  const customer = getCustomerByStripeSessionId(sessionId);
  if (!customer) return { ok: false, error: 'Session not found.' };

  if (customer.provision_status !== 'ready') {
    return { ok: false, error: 'Instance not provisioned yet.' };
  }
  if (!customer.server_ip || !customer.ssh_key_path) {
    return { ok: false, error: 'Instance not provisioned yet.' };
  }

  const session = getOnboardingSession(sessionId);
  if (!session || !session.generated_files) return { ok: false, error: 'Profile not generated yet.' };

  const generatedFiles = JSON.parse(session.generated_files);
  if (!generatedFiles.soulMd) return { ok: false, error: 'Profile not generated yet.' };

  const username = customer.username;
  const serverIp = customer.server_ip;
  const sshKeyPath = customer.ssh_key_path;

  const baseDir = path.join(__dirname, 'generated');
  const outputDir = path.resolve(baseDir, username);
  if (!outputDir.startsWith(baseDir)) {
    return { ok: false, error: 'Invalid username for file path.' };
  }
  await fs.mkdir(outputDir, { recursive: true });

  await fs.writeFile(path.join(outputDir, 'SOUL.md'), generatedFiles.soulMd, 'utf8');
  await fs.writeFile(path.join(outputDir, 'USER.md'), generatedFiles.userMd, 'utf8');
  await fs.writeFile(path.join(outputDir, 'IDENTITY.md'), generatedFiles.identityMd, 'utf8');
  await fs.writeFile(path.join(outputDir, 'HEARTBEAT.md'), generatedFiles.heartbeatMd || '', 'utf8');
  await fs.writeFile(path.join(outputDir, 'BOOTSTRAP.md'), generatedFiles.bootstrapMd || '', 'utf8');

  if (generatedFiles.multiAgentMd) {
    await fs.writeFile(path.join(outputDir, 'MULTI-AGENT.md'), generatedFiles.multiAgentMd, 'utf8');
  }

  if (generatedFiles.agentsMd) {
    await fs.writeFile(path.join(outputDir, 'AGENTS.md'), generatedFiles.agentsMd, 'utf8');
  }

  if (generatedFiles.agents && generatedFiles.agents.length > 0) {
    for (const agent of generatedFiles.agents) {
      const agentDir = path.join(outputDir, 'agents', agent.name);
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(agentDir, 'SOUL.md'), agent.soulMd, 'utf8');
      if (agent.agentsMd) await fs.writeFile(path.join(agentDir, 'AGENTS.md'), agent.agentsMd, 'utf8');
      if (agent.heartbeatMd) await fs.writeFile(path.join(agentDir, 'HEARTBEAT.md'), agent.heartbeatMd, 'utf8');
      if (agent.userMd) await fs.writeFile(path.join(agentDir, 'USER.md'), agent.userMd, 'utf8');
    }
  }

  const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (!ipPattern.test(serverIp)) {
    return { ok: false, error: 'Invalid server IP.' };
  }
  const keyPathPattern = /^\/[\w\-/.]+$/;
  if (!keyPathPattern.test(sshKeyPath)) {
    return { ok: false, error: 'Invalid SSH key path.' };
  }

  let filesDeployed = false;
  try {
    const scpOpts = ['-i', sshKeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=30'];
    const remoteBase = `ubuntu@${serverIp}:/home/ubuntu/clawd`;

    for (const filename of ['SOUL.md', 'USER.md', 'IDENTITY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md']) {
      await execFileAsync('scp', [...scpOpts, path.join(outputDir, filename), `${remoteBase}/${filename}`]);
    }

    if (generatedFiles.multiAgentMd) {
      await execFileAsync('scp', [...scpOpts, path.join(outputDir, 'MULTI-AGENT.md'), `${remoteBase}/MULTI-AGENT.md`]);
    }

    if (generatedFiles.agentsMd) {
      await execFileAsync('scp', [...scpOpts, path.join(outputDir, 'AGENTS.md'), `${remoteBase}/AGENTS.md`]);
    }

    if (generatedFiles.agents && generatedFiles.agents.length > 0) {
      await execFileAsync('ssh', [
        '-i', sshKeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=30',
        `ubuntu@${serverIp}`,
        'mkdir -p ' + generatedFiles.agents.map(a => `/home/ubuntu/clawd/agents/${a.name}`).join(' ')
      ]);

      for (const agent of generatedFiles.agents) {
        for (const filename of ['SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'USER.md']) {
          const localPath = path.join(outputDir, 'agents', agent.name, filename);
          try {
            await fs.access(localPath);
            await execFileAsync('scp', [...scpOpts, localPath, `ubuntu@${serverIp}:/home/ubuntu/clawd/agents/${agent.name}/${filename}`]);
          } catch (e) { /* file doesn't exist, skip */ }
        }
      }
    }

    let chmodPaths = '/home/ubuntu/clawd/SOUL.md /home/ubuntu/clawd/USER.md /home/ubuntu/clawd/IDENTITY.md /home/ubuntu/clawd/HEARTBEAT.md /home/ubuntu/clawd/BOOTSTRAP.md';
    if (generatedFiles.agentsMd) {
      chmodPaths += ' /home/ubuntu/clawd/AGENTS.md';
    }
    if (generatedFiles.multiAgentMd) {
      chmodPaths += ' /home/ubuntu/clawd/MULTI-AGENT.md';
    }
    if (generatedFiles.agents && generatedFiles.agents.length > 0) {
      for (const agent of generatedFiles.agents) {
        chmodPaths += ` /home/ubuntu/clawd/agents/${agent.name}/SOUL.md`;
        if (agent.agentsMd) chmodPaths += ` /home/ubuntu/clawd/agents/${agent.name}/AGENTS.md`;
        if (agent.heartbeatMd) chmodPaths += ` /home/ubuntu/clawd/agents/${agent.name}/HEARTBEAT.md`;
        if (agent.userMd) chmodPaths += ` /home/ubuntu/clawd/agents/${agent.name}/USER.md`;
      }
    }

    await execFileAsync('ssh', [
      '-i', sshKeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=30',
      `ubuntu@${serverIp}`,
      `chmod 644 ${chmodPaths}`
    ]);

    // Fix ownership so container's clawd user (uid 1001) can read the files
    await execFileAsync('ssh', [
      '-i', sshKeyPath,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      `ubuntu@${serverIp}`,
      'sudo', 'chown', '-R', '1001:1001', '/home/ubuntu/clawd/'
    ], { timeout: 15000 });

    filesDeployed = true;
    console.log(`Files deployed to ${serverIp} for session ${sessionId}`);

    // Restart container so entrypoint re-discovers agents
    try {
      await execFileAsync('ssh', [
        '-i', sshKeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=30',
        `ubuntu@${serverIp}`,
        'sudo docker restart openclaw'
      ]);
      // Wait for gateway to fully initialize before reading token
      await new Promise(resolve => setTimeout(resolve, 15000));
    } catch (restartErr) {
      console.error(`Container restart failed for ${sessionId}: ${restartErr.message}`);
    }
  } catch (scpErr) {
    console.error(`SCP deployment failed for ${sessionId}: ${scpErr.message}`);
  }

  let gatewayToken = '';
  let portalToken = '';
  if (filesDeployed) {
    try {
      const { stdout } = await execFileAsync('ssh', [
        '-i', sshKeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
        `ubuntu@${serverIp}`,
        'sudo docker exec openclaw cat /home/clawd/.openclaw/.gw-token 2>/dev/null || echo ""'
      ]);
      gatewayToken = stdout.trim();
    } catch (err) {
      console.error(`Gateway token read failed for ${sessionId}: ${err.message}`);
    }
    try {
      const { stdout } = await execFileAsync('ssh', [
        '-i', sshKeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
        `ubuntu@${serverIp}`,
        'cat /home/ubuntu/clawdaddy-portal/config.json 2>/dev/null || echo "{}"'
      ]);
      const portalConfig = JSON.parse(stdout.trim());
      portalToken = portalConfig.portalToken || '';
    } catch (err) {
      console.error(`Portal token read failed for ${sessionId}: ${err.message}`);
    }
  }

  if (gatewayToken || portalToken) {
    // Hash portal password before storing — plaintext only exists in memory
    // and is returned once in the HTTP response for the success screen.
    let hashedPassword = null;
    if (portalToken) {
      const bcrypt = require('bcrypt');
      hashedPassword = bcrypt.hashSync(portalToken, 10);
    }
    updateOnboardingSession(sessionId, {
      ...(gatewayToken ? { gateway_token: gatewayToken } : {}),
      ...(hashedPassword ? { portal_password: hashedPassword } : {}),
    });
  }

  // Return plaintext portalToken in response (shown once on success screen, never persisted in plaintext)
  return { ok: true, deployed: filesDeployed, gatewayToken, portalToken };
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

    // Validate token against SQLite
    const customer = getCustomerByUsername(username);
    if (!customer || customer.dns_token !== token) {
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
  if (!sessionId || !isValidSessionId(sessionId)) {
    return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
  }

  const customer = getCustomerByStripeSessionId(sessionId);
  if (!customer) {
    return res.status(404).json({ ok: false, error: 'Session not found.' });
  }

  const session = getOnboardingSession(sessionId);

  // Trigger auto-deploy check when provision is ready (second trigger point)
  if (customer.provision_status === 'ready' && session?.generated_files && (!session.deploy_status || session.deploy_status === 'pending')) {
    void tryDeployIfReady(sessionId);
  }

  return res.json({
    username: customer.username,
    botName: customer.bot_name,
    provisionStatus: customer.provision_status,
    provisionStage: customer.provision_stage,
    authStatus: customer.auth_status,
    webchatUrl: customer.dns_hostname ? `https://${customer.dns_hostname}` : null,
    deployStatus: session?.deploy_status || 'pending',
  });
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

    // Check customers table AND active reservations
    const available = isUsernameAvailable(raw);

    if (!available) {
      // Suggest alternatives: append numbers
      let suggestion = null;
      for (let i = 1; i <= 99; i++) {
        const candidate = `${raw}${i}`;
        if (candidate.length <= 20 && isUsernameAvailable(candidate)) {
          suggestion = candidate;
          break;
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

// Also support query param style: GET /api/check-username?username=alice
app.get('/api/check-username', async (req, res) => {
  const raw = (req.query.username || req.query.u || '').toLowerCase().trim();
  if (!raw) return res.status(400).json({ available: false, error: 'Missing username parameter.' });

  const usernameRegex = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;
  if (raw.length < 3 || raw.length > 20 || !usernameRegex.test(raw)) {
    return res.status(400).json({ available: false, error: 'Invalid username format.', suggestion: null });
  }

  const available = isUsernameAvailable(raw);
  if (!available) {
    let suggestion = null;
    for (let i = 1; i <= 99; i++) {
      const candidate = `${raw}${i}`;
      if (candidate.length <= 20 && isUsernameAvailable(candidate)) { suggestion = candidate; break; }
    }
    return res.json({ available: false, suggestion });
  }
  return res.json({ available: true, suggestion: null });
});

app.post('/api/reserve-username', express.json(), async (req, res) => {
  try {
    const { username, stripeSessionId, email } = req.body || {};

    const raw = (username || '').toLowerCase().trim();
    const usernameRegex = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;
    if (!raw || raw.length < 3 || raw.length > 20 || !usernameRegex.test(raw)) {
      return res.status(400).json({ ok: false, reason: 'invalid', error: 'Invalid username format.' });
    }

    if (!stripeSessionId) {
      return res.status(400).json({ ok: false, reason: 'missing_session', error: 'stripeSessionId is required.' });
    }

    const result = reserveUsername(raw, stripeSessionId, email);

    if (!result.ok) {
      return res.status(409).json({ ok: false, reason: result.reason });
    }

    return res.json({ ok: true, username: raw, expiresInMinutes: 30 });
  } catch (error) {
    console.error('Username reservation failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Unable to reserve username.' });
  }
});

// --- Dynamic Stripe Checkout Session Creation ---
const PRICE_MAP = {
  starter: process.env.STRIPE_PRICE_STARTER || 'price_1T1TecHWqkYCAxbBTBJajC3h',
  pro:     process.env.STRIPE_PRICE_PRO     || 'price_1T2QzwHWqkYCAxbBim5mjoks',
  power:   process.env.STRIPE_PRICE_POWER   || 'price_1T1TehHWqkYCAxbBeh6BPWnm',
};

app.post('/api/create-checkout-session', express.json(), async (req, res) => {
  try {
    const { username, botName, plan, email } = req.body || {};

    // Validate username
    const raw = (username || '').toLowerCase().trim();
    const usernameRegex = /^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$/;
    if (!raw || raw.length < 3 || raw.length > 20 || !usernameRegex.test(raw)) {
      return res.status(400).json({ ok: false, error: 'Invalid username format.' });
    }

    // Check availability
    if (!isUsernameAvailable(raw)) {
      return res.status(409).json({ ok: false, error: 'Username is taken.' });
    }

    // Validate plan
    const priceId = PRICE_MAP[(plan || 'pro').toLowerCase()];
    if (!priceId) {
      return res.status(400).json({ ok: false, error: 'Invalid plan.' });
    }

    const stripeKey = await getStripeSecretKey();

    // Create Stripe checkout session via API
    const params = new URLSearchParams();
    params.append('mode', 'subscription');
    params.append('payment_method_types[0]', 'card');
    params.append('line_items[0][price]', priceId);
    params.append('line_items[0][quantity]', '1');
    params.append('success_url', 'https://clawdaddy.sh/onboarding/?session_id={CHECKOUT_SESSION_ID}');
    params.append('cancel_url', 'https://clawdaddy.sh/#pricing');
    params.append('metadata[username]', raw);
    params.append('metadata[bot_name]', botName || 'Assistant');
    params.append('metadata[tier]', (plan || 'pro').toLowerCase());
    if (email) params.append('customer_email', email);

    const sessionData = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.stripe.com',
        path: '/v1/checkout/sessions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      };
      const request = https.request(options, (response) => {
        let body = '';
        response.on('data', chunk => body += chunk);
        response.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed.error) reject(new Error(parsed.error.message));
            else resolve(parsed);
          } catch (e) { reject(e); }
        });
      });
      request.on('error', reject);
      request.write(params.toString());
      request.end();
    });

    // Reserve username tied to this Stripe session
    const reservation = reserveUsername(raw, sessionData.id, email);
    if (!reservation.ok) {
      // Race condition — someone grabbed it between check and reserve
      return res.status(409).json({ ok: false, error: 'Username was just taken. Try another.' });
    }

    return res.json({ ok: true, url: sessionData.url, sessionId: sessionData.id });
  } catch (error) {
    console.error('Create checkout session failed:', error.message);
    return res.status(500).json({ ok: false, error: 'Unable to create checkout session.' });
  }
});

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

// SSE endpoint for profile generation with progress events
app.get('/api/onboarding/generate-profile/:sessionId/stream', async (req, res) => {
  const sessionId = parseSessionId(req.params.sessionId);
  if (!sessionId || !isValidSessionId(sessionId)) {
    return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
  }

  const session = getOnboardingSession(sessionId);
  if (!session) {
    return res.status(404).json({ ok: false, error: 'Session not found.' });
  }

  if (!session.quiz_results) {
    return res.status(400).json({ ok: false, error: 'Quiz results not found.' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx proxy buffering off
  res.flushHeaders();

  // Reconnect handling: if profile already generated, send complete immediately
  if (session.generated_files) {
    try {
      const existing = JSON.parse(session.generated_files);
      if (existing.soulMd) {
        res.write(`data: ${JSON.stringify({ stage: 'complete', message: 'Profile generation complete!' })}\n\n`);
        res.end();
        return;
      }
    } catch (_) {}
  }

  const customer = getCustomerByStripeSessionId(sessionId);
  const username = customer?.username || 'assistant';
  const botName = customer?.bot_name || 'Assistant';
  const quizResults = JSON.parse(session.quiz_results);

  // Handle client disconnect
  let clientDisconnected = false;
  req.on('close', () => { clientDisconnected = true; });

  function sendEvent(data) {
    if (!clientDisconnected) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  }

  try {
    const { soulMd, userMd, identityMd, heartbeatMd, bootstrapMd, agentsMd, agents, multiAgentMd } = await generateProfile(
      quizResults, username, botName, {
        onProgress: (progress) => sendEvent(progress),
      }
    );

    // Store generated files
    updateOnboardingSession(sessionId, {
      generated_files: JSON.stringify({ soulMd, userMd, identityMd, heartbeatMd, bootstrapMd, agentsMd, agents, multiAgentMd }),
      step: 'auth',
    });

    sendEvent({ stage: 'complete', message: 'Profile generation complete!' });
    res.end();

    // Trigger auto-deploy
    void tryDeployIfReady(sessionId);

    console.log(`[SSE] Profile generated for ${username} (${agents ? agents.length : 0} sub-agents)`);
  } catch (err) {
    console.error(`[SSE] Profile generation failed for ${sessionId}:`, err.message);
    sendEvent({ stage: 'error', message: 'Profile generation failed. Please try again.' });
    res.end();
  }
});

app.post('/api/onboarding/generate-profile/:sessionId', async (req, res) => {
  const sessionId = parseSessionId(req.params.sessionId);

  try {
    if (!sessionId || !isValidSessionId(sessionId)) {
      return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
    }

    const session = getOnboardingSession(sessionId);
    if (!session) {
      return res.status(404).json({ ok: false, error: 'Session not found.' });
    }

    if (!session.quiz_results) {
      return res.status(400).json({ ok: false, error: 'Quiz results not found. Submit quiz first.' });
    }

    const quizResults = JSON.parse(session.quiz_results);

    // Skip regeneration if profile already exists (avoids 2-min Opus call on retry)
    if (session.generated_files) {
      const generatedFiles = JSON.parse(session.generated_files);
      if (generatedFiles.soulMd) {
        console.log(`Profile already generated for session ${sessionId}, skipping regeneration`);
        const fileList = ['SOUL.md', 'USER.md', 'IDENTITY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md'];
        if (generatedFiles.agentsMd) fileList.push('AGENTS.md');
        if (generatedFiles.agents && generatedFiles.agents.length > 0) {
          fileList.push('MULTI-AGENT.md');
          for (const agent of generatedFiles.agents) {
            fileList.push(`agents/${agent.name}/SOUL.md`);
            if (agent.agentsMd) fileList.push(`agents/${agent.name}/AGENTS.md`);
            if (agent.heartbeatMd) fileList.push(`agents/${agent.name}/HEARTBEAT.md`);
            if (agent.userMd) fileList.push(`agents/${agent.name}/USER.md`);
          }
        }
        return res.json({ ok: true, files: fileList, cached: true });
      }
    }

    const customer = getCustomerByStripeSessionId(sessionId);
    const username = customer?.username || 'assistant';
    const botName = customer?.bot_name || 'Assistant';

    const { soulMd, userMd, identityMd, heartbeatMd, bootstrapMd, agentsMd, agents, multiAgentMd } = await generateProfile(
      quizResults,
      username,
      botName
    );

    updateOnboardingSession(sessionId, {
      generated_files: JSON.stringify({ soulMd, userMd, identityMd, heartbeatMd, bootstrapMd, agentsMd, agents, multiAgentMd }),
      step: 'auth',
    });

    // Try auto-deploy (fires if provisioning is also complete)
    void tryDeployIfReady(sessionId);

    const fileList = ['SOUL.md', 'USER.md', 'IDENTITY.md', 'HEARTBEAT.md', 'BOOTSTRAP.md'];
    if (agentsMd) fileList.push('AGENTS.md');
    if (agents && agents.length > 0) {
      fileList.push('MULTI-AGENT.md');
      for (const agent of agents) {
        fileList.push(`agents/${agent.name}/SOUL.md`);
        if (agent.agentsMd) fileList.push(`agents/${agent.name}/AGENTS.md`);
        if (agent.heartbeatMd) fileList.push(`agents/${agent.name}/HEARTBEAT.md`);
        if (agent.userMd) fileList.push(`agents/${agent.name}/USER.md`);
      }
    }

    console.log(`Profile generated for session ${sessionId} (${agents ? agents.length : 0} sub-agents)`);
    return res.json({ ok: true, files: fileList });
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

    const result = await deployFilesToInstance(sessionId);

    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }

    return res.json({ ok: true, deployed: result.deployed });
  } catch (error) {
    console.error(`File write failed for ${sessionId}:`, error.message);
    return res.status(500).json({ ok: false, error: 'Unable to write files.' });
  }
});

// GET /api/providers — list available auth providers
app.get('/api/providers', (_req, res) => {
  return res.json({ ok: true, providers: getProviderList() });
});

// POST /api/onboarding/auth/start
app.post('/api/onboarding/auth/start', async (req, res) => {
  const { stripeSessionId, provider } = req.body || {};

  if (!stripeSessionId || !isValidSessionId(stripeSessionId)) {
    return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
  }

  const customer = getCustomerByStripeSessionId(stripeSessionId);
  if (!customer) {
    return res.status(404).json({ ok: false, error: 'Customer not found.' });
  }
  if (customer.provision_status !== 'ready') {
    return res.status(409).json({ ok: false, error: 'Instance not provisioned yet.' });
  }

  try {
    const { url } = startAuth(customer, provider || 'anthropic', { storeOAuthState });
    return res.json({ ok: true, url });
  } catch (error) {
    console.error(`Auth start failed for ${stripeSessionId}: ${error.message}`);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/onboarding/auth/complete
app.post('/api/onboarding/auth/complete', async (req, res) => {
  const { codeState, stripeSessionId, provider } = req.body || {};

  if (!codeState || !stripeSessionId) {
    return res.status(400).json({ ok: false, error: 'codeState and stripeSessionId are required.' });
  }

  const customer = getCustomerByStripeSessionId(stripeSessionId);
  if (!customer) {
    return res.status(404).json({ ok: false, error: 'Customer not found.' });
  }

  try {
    const result = await completeAuth(customer, codeState, provider || 'anthropic', { clearOAuthState, updateAuth });
    updateOnboardingSession(stripeSessionId, { step: 'complete' });
    return res.json({ ok: true, success: true });
  } catch (error) {
    console.error(`Auth complete failed: ${error.message}`);
    const status = error.message.includes('State mismatch') ? 400
      : error.message.includes('No pending') ? 404
      : error.message.includes('timed out') ? 504
      : 502;
    return res.status(status).json({ ok: false, error: error.message });
  }
});

// POST /api/onboarding/auth/api-key — save API key for a provider
app.post('/api/onboarding/auth/api-key', async (req, res) => {
  const { stripeSessionId, provider, apiKey } = req.body || {};

  if (!stripeSessionId || !isValidSessionId(stripeSessionId)) {
    return res.status(400).json({ ok: false, error: 'Invalid session ID.' });
  }
  if (!provider || !apiKey) {
    return res.status(400).json({ ok: false, error: 'provider and apiKey are required.' });
  }

  const customer = getCustomerByStripeSessionId(stripeSessionId);
  if (!customer) {
    return res.status(404).json({ ok: false, error: 'Customer not found.' });
  }
  if (customer.provision_status !== 'ready') {
    return res.status(409).json({ ok: false, error: 'Instance not provisioned yet.' });
  }

  try {
    await authWithApiKey(customer, provider, apiKey, { updateAuth });
    updateOnboardingSession(stripeSessionId, { step: 'complete' });
    return res.json({ ok: true, success: true });
  } catch (error) {
    console.error(`API key auth failed for ${stripeSessionId}: ${error.message}`);
    return res.status(400).json({ ok: false, error: error.message });
  }
});

// POST /api/onboarding/auth/verify — lightweight key validation
app.post('/api/onboarding/auth/verify', async (req, res) => {
  const { provider, apiKey } = req.body || {};

  if (!provider || !apiKey) {
    return res.status(400).json({ ok: false, error: 'provider and apiKey are required.' });
  }

  // Provider-specific verification endpoints (lightweight list-models or similar)
  const VERIFY_ENDPOINTS = {
    anthropic: { hostname: 'api.anthropic.com', path: '/v1/models', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
    openai: { hostname: 'api.openai.com', path: '/v1/models?limit=1', headers: { 'Authorization': `Bearer ${apiKey}` } },
    openrouter: { hostname: 'openrouter.ai', path: '/api/v1/models?limit=1', headers: { 'Authorization': `Bearer ${apiKey}` } },
    google: { hostname: 'generativelanguage.googleapis.com', path: `/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1`, headers: {} },
    xai: { hostname: 'api.x.ai', path: '/v1/models', headers: { 'Authorization': `Bearer ${apiKey}` } },
    groq: { hostname: 'api.groq.com', path: '/openai/v1/models', headers: { 'Authorization': `Bearer ${apiKey}` } },
  };

  const endpoint = VERIFY_ENDPOINTS[provider];
  if (!endpoint) {
    return res.status(400).json({ ok: false, error: `Unknown provider: ${provider}` });
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const request = https.request({
        hostname: endpoint.hostname,
        path: endpoint.path,
        method: 'GET',
        headers: { ...endpoint.headers, 'Accept': 'application/json' },
        timeout: 8000,
      }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          resolve({ statusCode: response.statusCode, body });
        });
      });
      request.on('error', reject);
      request.on('timeout', () => { request.destroy(); reject(new Error('Verification timed out')); });
      request.end();
    });

    if (result.statusCode >= 200 && result.statusCode < 300) {
      return res.json({ ok: true, valid: true });
    } else if (result.statusCode === 401 || result.statusCode === 403) {
      return res.json({ ok: true, valid: false, error: 'Invalid API key.' });
    } else {
      return res.json({ ok: true, valid: false, error: `Provider returned status ${result.statusCode}.` });
    }
  } catch (err) {
    console.error(`Key verify failed for ${provider}: ${err.message}`);
    return res.json({ ok: true, valid: false, error: 'Could not verify key. Try saving it anyway.' });
  }
});

app.listen(PORT, () => {
  console.log(`ClawDaddy onboarding API listening on port ${PORT}`);
  console.log(`Stripe key path: ${STRIPE_KEY_PATH}`);
  // ZeptoMail key path log removed — constant not defined in this version
});
