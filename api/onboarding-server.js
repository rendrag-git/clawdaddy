#!/usr/bin/env node

const express = require('express');
const cors = require('cors');
const https = require('https');
const path = require('path');
const { promises: fs } = require('fs');
const { generateProfile } = require('./lib/profile-generator');
const { initDb, getCustomerByStripeSessionId, getCustomerByUsername, getOnboardingSession, updateOnboardingSession, updateAuth } = require('./lib/db');
const { startAuth, completeAuth } = require('./lib/ssh-auth');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

initDb();

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
  'http://3.230.7.207:3848'
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
    updateOnboardingSession(sessionId, {
      ...(gatewayToken ? { gateway_token: gatewayToken } : {}),
      ...(portalToken ? { portal_password: portalToken } : {}),
    });
  }

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

  return res.json({
    username: customer.username,
    botName: customer.bot_name,
    provisionStatus: customer.provision_status,
    provisionStage: customer.provision_stage,
    authStatus: customer.auth_status,
    webchatUrl: customer.dns_hostname ? `https://${customer.dns_hostname}` : null,
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

    const taken = !!getCustomerByUsername(raw);

    if (taken) {
      // Suggest alternatives: append numbers
      let suggestion = null;
      for (let i = 1; i <= 99; i++) {
        const candidate = `${raw}${i}`;
        if (candidate.length <= 20 && !getCustomerByUsername(candidate)) {
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

    // Try auto-deploy files (in case provisioning already completed)
    void deployFilesToInstance(sessionId).catch(err =>
      console.error(`Auto-deploy failed for ${sessionId}: ${err.message}`)
    );

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
  const { authSessionId, code, stripeSessionId } = req.body || {};

  if (!authSessionId || !code || !stripeSessionId) {
    return res.status(400).json({ ok: false, error: 'authSessionId, code, and stripeSessionId are required.' });
  }

  try {
    const result = await completeAuth(authSessionId, code);

    // Update customer auth status in DB
    const customer = getCustomerByStripeSessionId(stripeSessionId);
    if (customer) {
      updateAuth(customer.id, { authStatus: 'complete', authProvider: result.provider });
      updateOnboardingSession(stripeSessionId, { step: 'complete' });
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

app.listen(PORT, () => {
  console.log(`ClawDaddy onboarding API listening on port ${PORT}`);
  console.log(`Stripe key path: ${STRIPE_KEY_PATH}`);
  console.log(`ZeptoMail key path: ${ZEPTOMAIL_KEY_PATH}`);
});
