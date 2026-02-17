import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
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
  process.env.SOUL_MD_PATH || '/home/ubuntu/clawd/SOUL.md';
const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH || '/home/clawd/.openclaw/openclaw.json';
const OPENCLAW_WORKSPACE_PATH =
  process.env.OPENCLAW_WORKSPACE_PATH || '/home/ubuntu/clawd';
const OPENCLAW_GATEWAY_URL =
  process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789';
const COOKIE_NAME = 'portal_session';
const JWT_SECRET = crypto.randomBytes(32).toString('hex');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _configCache = null;
let _configCacheTime = 0;
const CONFIG_CACHE_TTL = 5000; // 5 seconds

let _openClawConfigCache = null;
let _openClawConfigCacheTime = 0;
const OPENCLAW_CONFIG_CACHE_TTL = 5000;

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
  _configCache = config;
  _configCacheTime = Date.now();
}

async function readOpenClawConfig() {
  const now = Date.now();
  if (
    _openClawConfigCache &&
    now - _openClawConfigCacheTime < OPENCLAW_CONFIG_CACHE_TTL
  ) {
    return _openClawConfigCache;
  }
  try {
    const raw = await fs.readFile(OPENCLAW_CONFIG_PATH, 'utf-8');
    _openClawConfigCache = JSON.parse(raw);
    _openClawConfigCacheTime = now;
    return _openClawConfigCache;
  } catch {
    return null;
  }
}

function extractEmoji(input) {
  if (!input) return null;
  const match = input.match(/\p{Extended_Pictographic}(?:\uFE0F)?/u);
  return match ? match[0] : null;
}

function formatAgentName(agentId) {
  if (!agentId || agentId === 'main') {
    return 'Main Agent';
  }
  return agentId
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function sanitizeAgentId(value) {
  const id = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
  return id || 'main';
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveHostWorkspacePath(workspacePath) {
  if (!workspacePath || typeof workspacePath !== 'string') {
    return OPENCLAW_WORKSPACE_PATH;
  }

  if (await pathExists(workspacePath)) {
    return workspacePath;
  }

  const rewrites = [
    ['/home/clawd/clawd', OPENCLAW_WORKSPACE_PATH],
    ['/home/clawd', '/home/ubuntu'],
  ];

  for (const [fromPrefix, toPrefix] of rewrites) {
    if (!workspacePath.startsWith(fromPrefix)) continue;
    const candidate = toPrefix + workspacePath.slice(fromPrefix.length);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return workspacePath;
}

function parseIdentityContent(content, fallbackName, fallbackEmoji) {
  let name = fallbackName;
  let emoji = fallbackEmoji;

  const nameBullet = content.match(/^\s*-\s*Name:\s*(.+)$/im);
  if (nameBullet) {
    name = nameBullet[1].trim();
  }

  const identityHeading = content.match(/^#\s*IDENTITY\.md\s*[—-]\s*(.+)$/im);
  if (identityHeading && !nameBullet) {
    name = identityHeading[1].trim();
  }

  const archetypeHeading = content.match(/^##\s*Archetype:\s*(.+)$/im);
  if (archetypeHeading && !nameBullet && !identityHeading) {
    name = archetypeHeading[1].trim();
  }

  const signatureEmoji = content.match(/\*\*Signature emoji:\*\*\s*([^\n]+)/i);
  if (signatureEmoji) {
    emoji = extractEmoji(signatureEmoji[1]) || emoji;
  }

  if (!emoji) {
    emoji = extractEmoji(content);
  }

  if (name) {
    name = name.replace(/[\-\s]+$/, '').trim();
  }

  if (name && !emoji) {
    emoji = extractEmoji(name) || emoji;
  }

  if (name) {
    name = name.replace(/\p{Extended_Pictographic}(?:\uFE0F)?/gu, '').trim();
  }

  return {
    name: name || fallbackName,
    emoji: emoji || fallbackEmoji,
  };
}

function parseSoulContent(content, fallbackName, fallbackEmoji) {
  const titleMatch = content.match(/^#\s*SOUL\.md\s*[—-]\s*(.+)$/im);
  if (!titleMatch) {
    return {
      name: fallbackName,
      emoji: fallbackEmoji,
    };
  }

  const title = titleMatch[1].trim();
  const emoji = extractEmoji(title) || fallbackEmoji;
  const name = title
    .replace(/\p{Extended_Pictographic}(?:\uFE0F)?/gu, '')
    .trim() || fallbackName;

  return { name, emoji };
}

async function readAgentIdentity(workspacePath, fallbackName, fallbackEmoji) {
  const identityPath = path.join(workspacePath, 'IDENTITY.md');
  if (await pathExists(identityPath)) {
    try {
      const raw = await fs.readFile(identityPath, 'utf-8');
      return parseIdentityContent(raw, fallbackName, fallbackEmoji);
    } catch {
      // fall through
    }
  }

  const soulPath = path.join(workspacePath, 'SOUL.md');
  if (await pathExists(soulPath)) {
    try {
      const raw = await fs.readFile(soulPath, 'utf-8');
      return parseSoulContent(raw, fallbackName, fallbackEmoji);
    } catch {
      // fall through
    }
  }

  return { name: fallbackName, emoji: fallbackEmoji };
}

async function discoverAgents(botName) {
  const openClawConfig = await readOpenClawConfig();
  const defaultsWorkspace =
    openClawConfig?.agents?.defaults?.workspace || OPENCLAW_WORKSPACE_PATH;
  const declaredAgents = Array.isArray(openClawConfig?.agents?.list)
    ? openClawConfig.agents.list
    : [];

  const registry = new Map();

  for (const entry of declaredAgents) {
    if (!entry || typeof entry !== 'object') continue;
    const id = sanitizeAgentId(entry.id || entry.name || entry.agentId || '');
    const workspace =
      typeof entry.workspace === 'string' && entry.workspace.trim().length > 0
        ? entry.workspace
        : defaultsWorkspace;
    registry.set(id, { id, workspace });
  }

  if (!registry.has('main')) {
    registry.set('main', { id: 'main', workspace: defaultsWorkspace });
  }

  if (declaredAgents.length === 0) {
    const hostRoot = await resolveHostWorkspacePath(defaultsWorkspace);
    const agentsDir = path.join(hostRoot, 'agents');
    if (await pathExists(agentsDir)) {
      try {
        const entries = await fs.readdir(agentsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const id = sanitizeAgentId(entry.name);
          if (id === 'main') continue;
          if (registry.has(id)) continue;
          registry.set(id, {
            id,
            workspace: path.join(defaultsWorkspace, 'agents', entry.name),
          });
        }
      } catch {
        // no-op
      }
    }
  }

  const channels = [];
  for (const [, agent] of registry) {
    const isMain = agent.id === 'main';
    const fallbackName = isMain ? botName || 'Assistant' : formatAgentName(agent.id);
    const fallbackEmoji = isMain ? '🦞' : '🤖';
    const hostWorkspace = await resolveHostWorkspacePath(agent.workspace);
    const identity = await readAgentIdentity(
      hostWorkspace,
      fallbackName,
      fallbackEmoji,
    );

    channels.push({
      id: agent.id,
      name: identity.name || fallbackName,
      emoji: identity.emoji || fallbackEmoji,
      isMain,
    });
  }

  channels.sort((a, b) => {
    if (a.isMain && !b.isMain) return -1;
    if (!a.isMain && b.isMain) return 1;
    return a.name.localeCompare(b.name);
  });

  return channels;
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (block && typeof block.text === 'string') return block.text;
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((message) => {
      const role = message?.role === 'assistant' ? 'assistant' : 'user';
      const content = normalizeMessageContent(message?.content);
      return { role, content };
    })
    .filter((message) => message.content.length > 0);
}

function buildGatewayHeaders(token, channelId, threadId) {
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': '2023-06-01',
  };

  if (token) {
    headers.authorization = `Bearer ${token}`;
    headers['x-api-key'] = token;
    headers['x-gateway-token'] = token;
    headers['x-openclaw-token'] = token;
  }

  if (channelId) {
    headers['x-openclaw-agent'] = channelId;
    headers['x-agent-id'] = channelId;
    headers['x-channel-id'] = channelId;
  }

  if (threadId) {
    headers['x-thread-id'] = threadId;
  }

  return headers;
}

async function readSoulMd() {
  try {
    const content = await fs.readFile(SOUL_MD_PATH, 'utf-8');
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
    const res = await fetch(OPENCLAW_GATEWAY_URL, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function getSessionPayload(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;

  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function requireAuth(req, res, next) {
  const payload = getSessionPayload(req);
  if (!payload) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.user = { username: payload.username };
  next();
}

function requireAuthRedirect(req, res, next) {
  const payload = getSessionPayload(req);
  if (!payload) {
    return res.redirect('/portal/');
  }
  req.user = { username: payload.username };
  next();
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const publicDir = path.join(__dirname, 'public');

// Redirect /portal to /portal/ so relative paths work
app.get('/portal', (_req, res) => res.redirect('/portal/'));

// Protect chat app shell and assets using existing portal session cookie.
app.use('/portal/chat', requireAuthRedirect);

// Dynamic manifest so install name reflects customer's bot name.
app.get('/portal/manifest.webmanifest', async (_req, res) => {
  let botName = 'ClawDaddy Chat';
  try {
    const config = await readConfig();
    if (typeof config.botName === 'string' && config.botName.trim()) {
      botName = `${config.botName.trim()} Chat`;
    }
  } catch {
    // Keep default manifest values.
  }

  const manifest = {
    name: botName,
    short_name: botName.slice(0, 12),
    description: 'ClawDaddy customer chat interface',
    start_url: '/portal/chat/',
    scope: '/portal/',
    display: 'standalone',
    background_color: '#090b10',
    theme_color: '#f97316',
    icons: [
      {
        src: '/portal/logo.svg',
        sizes: '192x192',
        type: 'image/svg+xml',
        purpose: 'any maskable',
      },
      {
        src: '/portal/logo.svg',
        sizes: '512x512',
        type: 'image/svg+xml',
        purpose: 'any maskable',
      },
    ],
  };

  res.type('application/manifest+json');
  return res.send(JSON.stringify(manifest));
});

// Serve static files from ./public under /portal/
app.use('/portal', express.static(publicDir));

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
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/portal',
  });

  return res.json({ ok: true });
});

app.get('/portal/api/auth/check', (req, res) => {
  const payload = getSessionPayload(req);
  if (!payload) {
    return res.json({ authenticated: false });
  }
  return res.json({ authenticated: true, username: payload.username });
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
// Chat API routes (auth required)
// ---------------------------------------------------------------------------

app.get('/portal/api/chat/bootstrap', requireAuth, async (_req, res) => {
  try {
    const config = await readConfig();
    const channels = await discoverAgents(config.botName || 'Assistant');
    const mainChannel = channels.find((channel) => channel.isMain);

    return res.json({
      botName: config.botName || 'Assistant',
      channels,
      defaultChannelId: mainChannel?.id || channels[0]?.id || 'main',
    });
  } catch (err) {
    console.error('Failed to bootstrap chat:', err.message);
    return res.status(500).json({ error: 'Failed to load chat channels' });
  }
});

app.post('/portal/api/chat/stream', requireAuth, async (req, res) => {
  const {
    messages,
    channelId = 'main',
    threadId = null,
    maxTokens = 2048,
    model,
  } = req.body || {};

  const normalizedMessages = normalizeMessages(messages);
  if (normalizedMessages.length === 0) {
    return res.status(400).json({ error: 'At least one message is required' });
  }

  let config;
  try {
    config = await readConfig();
  } catch (err) {
    console.error('Failed to read portal config:', err.message);
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const openClawConfig = await readOpenClawConfig();
  const resolvedModel =
    model ||
    openClawConfig?.agents?.defaults?.model?.primary ||
    'anthropic/claude-sonnet-4-20250514';

  const token =
    config.gatewayToken || openClawConfig?.gateway?.auth?.token || '';

  const payload = {
    model: resolvedModel,
    max_tokens:
      Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0
        ? Math.min(Number(maxTokens), 8192)
        : 2048,
    stream: true,
    messages: normalizedMessages,
    metadata: {
      channel_id: sanitizeAgentId(channelId),
      thread_id: threadId || undefined,
    },
    channel: sanitizeAgentId(channelId),
    thread_id: threadId || undefined,
    agent: sanitizeAgentId(channelId),
  };

  const upstreamUrl = new URL('/v1/messages', OPENCLAW_GATEWAY_URL);
  if (token) {
    upstreamUrl.searchParams.set('token', token);
  }

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers: buildGatewayHeaders(token, sanitizeAgentId(channelId), threadId),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });

    if (!upstreamRes.ok) {
      const errorText = await upstreamRes.text();
      return res.status(upstreamRes.status).json({
        error: 'Gateway request failed',
        detail: errorText.slice(0, 2000),
      });
    }

    const contentType =
      upstreamRes.headers.get('content-type') || 'text/event-stream';
    res.status(upstreamRes.status);
    res.setHeader('content-type', contentType);
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');

    if (!upstreamRes.body) {
      return res.end();
    }

    for await (const chunk of upstreamRes.body) {
      res.write(Buffer.from(chunk));
    }

    return res.end();
  } catch (err) {
    console.error('Gateway streaming proxy failed:', err.message);
    if (!res.headersSent) {
      return res.status(502).json({
        error: 'Failed to reach OpenClaw gateway',
        detail: err.message,
      });
    }
    return res.end();
  }
});

// ---------------------------------------------------------------------------
// SPA fallback
// ---------------------------------------------------------------------------

app.get('/portal/*', (req, res) => {
  if (req.path.startsWith('/portal/api/')) {
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
