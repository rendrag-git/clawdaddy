import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3847;
const CONFIG_PATH =
  process.env.PORTAL_CONFIG_PATH ||
  '/home/ubuntu/clawdaddy-portal/config.json';
const SOUL_MD_PATH =
  process.env.SOUL_MD_PATH || '/home/ubuntu/clawd/SOUL.md';
const CLAWD_DIR = process.env.CLAWD_DIR || '/home/ubuntu/clawd';
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || '18789', 10);
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'portal_session';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL = 5000; // 5 seconds

async function readConfig() {
  const now = Date.now();
  if (_configCache && now - _configCacheTime < CONFIG_CACHE_TTL) {
    return _configCache;
  }
  const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
  _configCache = JSON.parse(raw);
  _configCacheTime = now;
  return _configCache;
}

async function writeConfig(config) {
  await fs.writeFile(
    CONFIG_PATH,
    JSON.stringify(config, null, 2) + '\n',
    'utf-8',
  );
  // Invalidate cache after write
  _configCache = config;
  _configCacheTime = Date.now();
}

async function readSoulMd() {
  try {
    const content = await fs.readFile(SOUL_MD_PATH, 'utf-8');
    // Extract the bold opening summary paragraph from SOUL.md
    const match = content.match(/\*\*(.+?)\*\*/s);
    if (match) {
      return match[1].trim();
    }
    return 'Personality not configured yet.';
  } catch {
    return 'Personality not configured yet.';
  }
}

async function checkHealth() {
  try {
    const res = await fetch('http://localhost:18789', {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Input sanitization
// ---------------------------------------------------------------------------

function sanitizeAgentId(value) {
  const id = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return id || 'main';
}

// ---------------------------------------------------------------------------
// Agent helpers
// ---------------------------------------------------------------------------

async function readAgents() {
  const config = await readConfig();
  const agents = [];

  // Main agent — parse from IDENTITY.md
  try {
    const identityMd = await fs.readFile(
      path.join(CLAWD_DIR, 'IDENTITY.md'),
      'utf-8',
    );
    const headerMatch = identityMd.match(
      /^#\s+IDENTITY\.md\s+(?:—|-)\s+(.+)/m,
    );
    const emojiMatch = identityMd.match(
      /\*\*Signature emoji:\*\*\s*(.+)/m,
    );
    agents.push({
      id: 'main',
      name: headerMatch ? headerMatch[1].trim() : config.botName || 'Assistant',
      emoji: emojiMatch ? emojiMatch[1].trim() : '\u{1F916}',
      isMain: true,
    });
  } catch {
    agents.push({
      id: 'main',
      name: config.botName || 'Assistant',
      emoji: '\u{1F916}',
      isMain: true,
    });
  }

  // Sub-agents — scan agents/ directory
  try {
    const agentsDir = path.join(CLAWD_DIR, 'agents');
    const dirs = await fs.readdir(agentsDir);
    for (const dir of dirs) {
      // Validate directory name (prevent traversal)
      if (!/^[a-zA-Z0-9_-]+$/.test(dir)) continue;
      try {
        const soulPath = path.join(agentsDir, dir, 'agent', 'SOUL.md');
        const soulMd = await fs.readFile(soulPath, 'utf-8');
        // Header format: # SOUL.md — DisplayName Emoji
        const match = soulMd.match(
          /^#\s+SOUL\.md\s+(?:—|-)\s+(\S+)\s+(\S+)/m,
        );
        if (match) {
          agents.push({
            id: dir,
            name: match[1].trim(),
            emoji: match[2].trim(),
            isMain: false,
          });
        }
      } catch {
        /* skip invalid agent dirs */
      }
    }
  } catch {
    /* no agents directory */
  }

  return agents;
}

async function getAgentSystemPrompt(agentId) {
  try {
    // Validate agent ID
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) return 'You are a helpful assistant.';

    if (agentId === 'main') {
      return await fs.readFile(path.join(CLAWD_DIR, 'SOUL.md'), 'utf-8');
    }
    return await fs.readFile(
      path.join(CLAWD_DIR, 'agents', agentId, 'agent', 'SOUL.md'),
      'utf-8',
    );
  } catch {
    return 'You are a helpful assistant.';
  }
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { username: payload.username };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.use(express.json());
app.use(cookieParser());

// Dynamic PWA manifest (before static middleware so it takes precedence)
app.get('/portal/manifest.json', async (_req, res) => {
  let botName = 'Clawd';
  try {
    const config = await readConfig();
    botName = config.botName || botName;
  } catch { /* use default */ }

  res.json({
    name: botName + ' Chat',
    short_name: botName,
    description: 'Chat with your ' + botName + ' AI assistant team',
    start_url: '/portal/chat/',
    scope: '/portal/',
    display: 'standalone',
    background_color: '#0f0f0f',
    theme_color: '#0f0f0f',
    icons: [
      { src: '/portal/logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
    ],
  });
});

// Protect chat routes — redirect to login if not authenticated
app.use('/portal/chat', (req, res, next) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.redirect('/portal/');
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.redirect('/portal/');
  }
});

// Serve static files from ./public under /portal/
const publicDir = path.join(__dirname, 'public');
app.use('/portal', express.static(publicDir));

// Redirect /portal to /portal/ so relative paths work
app.get('/portal', (_req, res) => res.redirect('/portal/'));

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.post('/portal/api/auth/login', async (req, res) => {
  const { token, password } = req.body || {};

  let config;
  try {
    config = await readConfig();
  } catch (err) {
    console.error('Failed to read config:', err.message);
    return res
      .status(500)
      .json({ ok: false, error: 'Server configuration error' });
  }

  const tokenMatch = token && config.portalToken && token === config.portalToken;
  let passwordMatch = false;
  if (password && config.password) {
    // Support both bcrypt hashes and legacy plaintext passwords
    if (config.password.startsWith('$2')) {
      passwordMatch = await bcrypt.compare(password, config.password);
    } else {
      passwordMatch = password === config.password;
    }
  }

  if (!tokenMatch && !passwordMatch) {
    return res.status(401).json({ ok: false, error: 'Invalid credentials' });
  }

  const signed = jwt.sign({ username: config.username }, JWT_SECRET, {
    expiresIn: '7d',
  });

  const isProduction = process.env.NODE_ENV === 'production';

  res.cookie(COOKIE_NAME, signed, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isProduction,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/portal',
  });

  return res.json({ ok: true });
});

app.get('/portal/api/auth/check', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.json({ authenticated: false });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return res.json({ authenticated: true, username: payload.username });
  } catch {
    return res.json({ authenticated: false });
  }
});

app.post('/portal/api/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/portal' });
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Portal routes (auth required)
// ---------------------------------------------------------------------------

app.get('/portal/api/portal/profile', requireAuth, async (_req, res) => {
  try {
    const [config, personality, instanceHealthy] = await Promise.all([
      readConfig(),
      readSoulMd(),
      checkHealth(),
    ]);

    return res.json({
      username: config.username,
      botName: config.botName,
      tier: config.tier,
      personality,
      apiKeyConfigured: config.apiKeyConfigured,
      apiKeyMasked: config.apiKeyMasked,
      discordConnected: config.discordConnected,
      telegramConnected: config.telegramConnected,
      instanceHealthy,
      gatewayToken: config.gatewayToken,
      hasPassword: config.password !== null && config.password !== undefined,
    });
  } catch (err) {
    console.error('Failed to load profile:', err.message);
    return res.status(500).json({ error: 'Server configuration error' });
  }
});

app.post('/portal/api/portal/settings/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    return res
      .status(400)
      .json({ ok: false, error: 'Password must be at least 6 characters' });
  }

  let config;
  try {
    config = await readConfig();
  } catch (err) {
    console.error('Failed to read config:', err.message);
    return res
      .status(500)
      .json({ ok: false, error: 'Server configuration error' });
  }

  // If a password already exists, verify currentPassword matches
  if (config.password !== null && config.password !== undefined) {
    let currentMatch = false;
    if (currentPassword) {
      if (config.password.startsWith('$2')) {
        currentMatch = await bcrypt.compare(currentPassword, config.password);
      } else {
        currentMatch = currentPassword === config.password;
      }
    }
    if (!currentMatch) {
      return res
        .status(401)
        .json({ ok: false, error: 'Current password is incorrect' });
    }
  }

  config.password = await bcrypt.hash(newPassword, 10);

  try {
    await writeConfig(config);
  } catch (err) {
    console.error('Failed to write config:', err.message);
    return res
      .status(500)
      .json({ ok: false, error: 'Failed to save password' });
  }

  return res.json({ ok: true });
});

app.post('/portal/api/portal/settings/api-key', requireAuth, async (req, res) => {
  const { apiKey } = req.body || {};

  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ ok: false, error: 'API key is required' });
  }

  if (!apiKey.startsWith('sk-ant-')) {
    return res
      .status(400)
      .json({ ok: false, error: 'API key must start with "sk-ant-"' });
  }

  let config;
  try {
    config = await readConfig();
  } catch (err) {
    console.error('Failed to read config:', err.message);
    return res
      .status(500)
      .json({ ok: false, error: 'Server configuration error' });
  }

  // Mask: first 7 chars + "..." + last 4 chars
  const masked = apiKey.slice(0, 7) + '...' + apiKey.slice(-4);

  config.apiKeyConfigured = true;
  config.apiKeyMasked = masked;

  try {
    await writeConfig(config);
  } catch (err) {
    console.error('Failed to write config:', err.message);
    return res
      .status(500)
      .json({ ok: false, error: 'Failed to save API key configuration' });
  }

  return res.json({ ok: true, message: 'API key updated in portal config.' });
});

// ---------------------------------------------------------------------------
// Chat routes (auth required)
// ---------------------------------------------------------------------------

app.get('/portal/api/chat/agents', requireAuth, async (_req, res) => {
  try {
    const agents = await readAgents();
    return res.json({ agents });
  } catch (err) {
    console.error('Failed to read agents:', err.message);
    return res.status(500).json({ error: 'Failed to load agents' });
  }
});

app.post('/portal/api/chat/send', requireAuth, async (req, res) => {
  const { agent, messages } = req.body || {};

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const agentId = sanitizeAgentId(agent);

  let config;
  try {
    config = await readConfig();
  } catch (err) {
    console.error('Failed to read config:', err.message);
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Sanitize messages — only pass role + content
  const cleanMessages = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: String(m.content) }));

  if (cleanMessages.length === 0) {
    return res.status(400).json({ error: 'No valid messages provided' });
  }

  // Use OpenAI chat completions format for OpenClaw gateway
  const requestBody = JSON.stringify({
    model: 'openclaw:' + agentId,
    messages: cleanMessages,
    max_tokens: 4096,
    stream: true,
    user: config.username || undefined,
  });

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Proxy request to OpenClaw gateway
  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: GATEWAY_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (config.gatewayToken || ''),
      },
    },
    (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        let errBody = '';
        proxyRes.on('data', (chunk) => { errBody += chunk; });
        proxyRes.on('end', () => {
          const errMsg = errBody || 'Gateway returned ' + proxyRes.statusCode;
          res.write('data: ' + JSON.stringify({ type: 'error', error: errMsg }) + '\n\n');
          res.end();
        });
        return;
      }

      // Pipe SSE stream from gateway to client
      proxyRes.on('data', (chunk) => {
        res.write(chunk);
      });

      proxyRes.on('end', () => {
        res.end();
      });

      proxyRes.on('error', (err) => {
        res.write('data: ' + JSON.stringify({ type: 'error', error: err.message }) + '\n\n');
        res.end();
      });
    },
  );

  proxyReq.on('error', (err) => {
    console.error('Gateway proxy error:', err.message);
    res.write(
      'data: ' +
        JSON.stringify({ type: 'error', error: 'Could not connect to AI gateway' }) +
        '\n\n',
    );
    res.end();
  });

  proxyReq.setTimeout(120000, () => {
    proxyReq.destroy();
    res.write('data: ' + JSON.stringify({ type: 'error', error: 'Request timed out' }) + '\n\n');
    res.end();
  });

  // Handle client disconnect
  req.on('close', () => {
    proxyReq.destroy();
  });

  proxyReq.write(requestBody);
  proxyReq.end();
});

// ---------------------------------------------------------------------------
// SPA fallback
// ---------------------------------------------------------------------------

app.get('/portal/*', (req, res) => {
  if (req.path.startsWith('/portal/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }

  // Chat SPA fallback — serve chat/index.html for /portal/chat/* routes
  if (req.path.startsWith('/portal/chat')) {
    const chatIndex = path.join(publicDir, 'chat', 'index.html');
    return res.sendFile(chatIndex, (err) => {
      if (err) {
        res.status(404).send('Not found');
      }
    });
  }

  const indexPath = path.join(publicDir, 'index.html');
  return res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).send('Not found');
    }
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`ClawDaddy portal server listening on port ${PORT}`);
});
