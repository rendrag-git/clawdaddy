import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
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
  process.env.SOUL_MD_PATH || '/home/ubuntu/clawd/agents/main/SOUL.md';
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
    // Extract everything between "## Personality" and the next "##" heading
    const match = content.match(
      /^## Personality\s*\n([\s\S]*?)(?=\n## |\n*$)/m,
    );
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

// Serve static files from ./public
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.post('/api/auth/login', async (req, res) => {
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
  const passwordMatch =
    password && config.password !== null && password === config.password;

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
    path: '/',
  });

  return res.json({ ok: true });
});

app.get('/api/auth/check', (req, res) => {
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

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Portal routes (auth required)
// ---------------------------------------------------------------------------

app.get('/api/portal/profile', requireAuth, async (_req, res) => {
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
      dashboardUrl: '/dashboard',
      gatewayToken: config.gatewayToken,
    });
  } catch (err) {
    console.error('Failed to load profile:', err.message);
    return res.status(500).json({ error: 'Server configuration error' });
  }
});

app.post('/api/portal/settings/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (!newPassword || typeof newPassword !== 'string') {
    return res
      .status(400)
      .json({ ok: false, error: 'New password is required' });
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
    if (!currentPassword || currentPassword !== config.password) {
      return res
        .status(401)
        .json({ ok: false, error: 'Current password is incorrect' });
    }
  }

  config.password = newPassword;

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

app.post('/api/portal/settings/api-key', requireAuth, async (req, res) => {
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
// SPA fallback
// ---------------------------------------------------------------------------

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
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
