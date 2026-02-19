# Portal Config + Landing Page Cleanup — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Settings section to the portal for managing API keys and model assignments across providers, plus clean up a duplicate row in the landing page comparison table.

**Architecture:** New REST endpoints in `portal/server.js` read/write `auth-profiles.json` (API keys) and `openclaw.json` (agent models). A new `view-config` view in the portal SPA handles the UI. After config writes, the server shells out to `openclaw gateway restart`. The existing settings view (password, single API key) stays untouched.

**Tech Stack:** Vanilla JS, Express (ESM), no new dependencies

---

## Task 1: Landing Page — Remove Duplicate Config Access Row

**Files:**
- Modify: `index.html:501-511` (mobile cards — duplicate Config Access)
- Modify: `index.html:536-537` (desktop table — duplicate Config Access row)

**Step 1: Remove duplicate mobile card**

In the mobile comparison cards section, there are two identical "Config Access" `<article>` blocks. Remove the second one (lines 506-511):

```html
<!-- DELETE this entire block (the second "Config Access" article) -->
<article class="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4">
  <h3 class="font-semibold text-white">Config Access</h3>
  <p class="mt-2 text-sm text-zinc-300"><span class="text-zinc-100">Starter:</span> Standard</p>
  <p class="text-sm text-zinc-300"><span class="text-zinc-100">Pro:</span> Standard + terminal</p>
  <p class="text-sm text-zinc-300"><span class="text-zinc-100">Power:</span> Full file-level access</p>
</article>
```

**Step 2: Remove duplicate desktop table row**

In the desktop comparison table, there are two "Config Access" rows. Remove the second one (line 537):

```html
<!-- DELETE this row -->
<tr class="border-b border-zinc-800/80"><td class="px-4 py-3 text-white">Config Access</td><td class="px-4 py-3">Standard</td><td class="px-4 py-3">Terminal + standard config</td><td class="px-4 py-3">Full file-level access</td></tr>
```

**Step 3: Verify visually**

Open `index.html` in a browser. Confirm comparison table shows exactly one "Config Access" row on both mobile and desktop views.

**Step 4: Commit**

```bash
git add index.html
git commit -m "fix: remove duplicate Config Access row from comparison table"
```

---

## Task 2: Server — Config Path Constants and File Helpers

**Files:**
- Modify: `portal/server.js:16-26` (add new path constants after existing ones)

**Step 1: Add path constants**

After the existing `GATEWAY_PORT` constant (line 24), add:

```javascript
const OPENCLAW_CONFIG_PATH =
  process.env.OPENCLAW_CONFIG_PATH ||
  '/home/clawd/.openclaw/openclaw.json';
const AUTH_PROFILES_PATH =
  process.env.AUTH_PROFILES_PATH ||
  '/home/clawd/.openclaw/agents/main/agent/auth-profiles.json';
```

**Step 2: Add read/write helpers for auth-profiles.json**

After the existing `writeConfig` helper, add:

```javascript
// ---------------------------------------------------------------------------
// Auth-profiles helpers
// ---------------------------------------------------------------------------

async function readAuthProfiles() {
  try {
    const raw = await fs.readFile(AUTH_PROFILES_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { version: 1, profiles: {}, order: {} };
    }
    throw err;
  }
}

async function writeAuthProfiles(data) {
  await fs.mkdir(path.dirname(AUTH_PROFILES_PATH), { recursive: true });
  await fs.writeFile(AUTH_PROFILES_PATH, JSON.stringify(data, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}
```

**Step 3: Add read/write helpers for openclaw.json**

```javascript
// ---------------------------------------------------------------------------
// OpenClaw config helpers
// ---------------------------------------------------------------------------

async function readOpenClawConfig() {
  const raw = await fs.readFile(OPENCLAW_CONFIG_PATH, 'utf-8');
  return JSON.parse(raw);
}

async function writeOpenClawConfig(data) {
  await fs.writeFile(
    OPENCLAW_CONFIG_PATH,
    JSON.stringify(data, null, 2),
    'utf-8'
  );
}
```

**Step 4: Add gateway restart helper**

```javascript
import { exec } from 'node:child_process';

// ---------------------------------------------------------------------------
// Gateway restart
// ---------------------------------------------------------------------------

function restartGateway() {
  exec('openclaw gateway restart', (err, stdout, stderr) => {
    if (err) {
      console.error('Gateway restart failed:', err.message);
      return;
    }
    if (stdout) console.log('Gateway restart:', stdout.trim());
    if (stderr) console.error('Gateway restart stderr:', stderr.trim());
  });
}
```

Note: The `exec` import should be added to the top of the file alongside the existing imports.

**Step 5: Add key format validators**

```javascript
// ---------------------------------------------------------------------------
// API key validation
// ---------------------------------------------------------------------------

const KEY_PREFIXES = {
  anthropic: 'sk-ant-',
  openai: 'sk-',
  openrouter: 'sk-or-',
  google: 'AI',
};

function validateKeyFormat(provider, key) {
  const prefix = KEY_PREFIXES[provider];
  if (!prefix) return { valid: false, error: `Unknown provider: ${provider}` };
  if (!key || typeof key !== 'string') return { valid: false, error: 'Key is required' };
  if (!key.startsWith(prefix)) {
    return { valid: false, error: `Key must start with "${prefix}"` };
  }
  if (key.length < 10) return { valid: false, error: 'Key is too short' };
  return { valid: true };
}

function maskKey(key) {
  if (!key || key.length < 8) return '****';
  return key.slice(0, 7) + '...' + key.slice(-4);
}
```

**Step 6: Commit**

```bash
git add portal/server.js
git commit -m "feat: add config file helpers for auth-profiles and openclaw.json"
```

---

## Task 3: Server — API Key Endpoints

**Files:**
- Modify: `portal/server.js` (add routes after existing portal settings routes, before chat routes)

**Step 1: GET /portal/api/config/keys — list providers with masked keys**

Add before the chat routes section:

```javascript
// ---------------------------------------------------------------------------
// Config: API Key management (auth required)
// ---------------------------------------------------------------------------

app.get('/portal/api/config/keys', requireAuth, async (_req, res) => {
  try {
    const profiles = await readAuthProfiles();
    const providers = {};

    for (const [profileId, profile] of Object.entries(profiles.profiles || {})) {
      const prov = profile.provider;
      if (!providers[prov]) {
        providers[prov] = {
          provider: prov,
          configured: true,
          masked: maskKey(profile.token),
          profileId,
        };
      }
    }

    // Include unconfigured providers
    for (const prov of ['anthropic', 'openai', 'openrouter', 'google']) {
      if (!providers[prov]) {
        providers[prov] = { provider: prov, configured: false, masked: null, profileId: null };
      }
    }

    return res.json({ ok: true, providers: Object.values(providers) });
  } catch (err) {
    console.error('Failed to read auth profiles:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to read API keys' });
  }
});
```

**Step 2: POST /portal/api/config/keys — add/update key**

```javascript
app.post('/portal/api/config/keys', requireAuth, async (req, res) => {
  const { provider, key } = req.body || {};

  const validation = validateKeyFormat(provider, key);
  if (!validation.valid) {
    return res.status(400).json({ ok: false, error: validation.error });
  }

  try {
    const profiles = await readAuthProfiles();
    const profileId = `${provider}:manual`;

    profiles.profiles[profileId] = {
      type: 'token',
      provider,
      token: key,
    };

    // Update order
    if (!profiles.order[provider]) {
      profiles.order[provider] = [];
    }
    if (!profiles.order[provider].includes(profileId)) {
      profiles.order[provider].push(profileId);
    }

    await writeAuthProfiles(profiles);
    restartGateway();

    return res.json({ ok: true, masked: maskKey(key) });
  } catch (err) {
    console.error('Failed to save API key:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to save API key' });
  }
});
```

**Step 3: POST /portal/api/config/keys/test — test key without saving**

```javascript
app.post('/portal/api/config/keys/test', requireAuth, async (req, res) => {
  const { provider, key } = req.body || {};

  const validation = validateKeyFormat(provider, key);
  if (!validation.valid) {
    return res.status(400).json({ ok: false, error: validation.error });
  }

  // Lightweight provider-specific validation: hit a cheap endpoint
  try {
    let testUrl, testOpts;

    if (provider === 'anthropic') {
      testUrl = 'https://api.anthropic.com/v1/models';
      testOpts = {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
      };
    } else if (provider === 'openai') {
      testUrl = 'https://api.openai.com/v1/models';
      testOpts = {
        headers: { Authorization: `Bearer ${key}` },
      };
    } else if (provider === 'openrouter') {
      testUrl = 'https://openrouter.ai/api/v1/models';
      testOpts = {
        headers: { Authorization: `Bearer ${key}` },
      };
    } else if (provider === 'google') {
      testUrl = `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(key)}`;
      testOpts = {};
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown provider' });
    }

    const testRes = await fetch(testUrl, testOpts);
    if (testRes.ok) {
      return res.json({ ok: true, message: 'Key is valid' });
    }

    const body = await testRes.text();
    return res.json({ ok: false, error: `Key rejected by ${provider} (HTTP ${testRes.status})` });
  } catch (err) {
    return res.json({ ok: false, error: `Connection failed: ${err.message}` });
  }
});
```

**Step 4: DELETE /portal/api/config/keys/:provider — remove a key**

```javascript
app.delete('/portal/api/config/keys/:provider', requireAuth, async (req, res) => {
  const { provider } = req.params;

  try {
    const profiles = await readAuthProfiles();
    const profileId = `${provider}:manual`;

    if (!profiles.profiles[profileId]) {
      return res.status(404).json({ ok: false, error: 'Key not found' });
    }

    delete profiles.profiles[profileId];

    // Clean up order
    if (profiles.order[provider]) {
      profiles.order[provider] = profiles.order[provider].filter(
        (id) => id !== profileId
      );
      if (profiles.order[provider].length === 0) {
        delete profiles.order[provider];
      }
    }

    await writeAuthProfiles(profiles);
    restartGateway();

    return res.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete API key:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to delete key' });
  }
});
```

**Step 5: Commit**

```bash
git add portal/server.js
git commit -m "feat: add API key management endpoints (CRUD + test)"
```

---

## Task 4: Server — Agent Model Endpoints

**Files:**
- Modify: `portal/server.js` (add routes after key management routes)

**Step 1: GET /portal/api/config/agents — list agents with models**

```javascript
// ---------------------------------------------------------------------------
// Config: Agent model management (auth required)
// ---------------------------------------------------------------------------

app.get('/portal/api/config/agents', requireAuth, async (_req, res) => {
  try {
    const oc = await readOpenClawConfig();
    const agents = oc.agents?.list || [];
    return res.json({
      ok: true,
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name || a.id,
        model: a.model || null,
      })),
    });
  } catch (err) {
    console.error('Failed to read openclaw config:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to load agents' });
  }
});
```

**Step 2: PATCH /portal/api/config/agents/:id — update agent model**

```javascript
app.patch('/portal/api/config/agents/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { model } = req.body || {};

  if (!model || typeof model !== 'string') {
    return res.status(400).json({ ok: false, error: 'model is required' });
  }

  try {
    const oc = await readOpenClawConfig();
    const agents = oc.agents?.list || [];
    const agent = agents.find((a) => a.id === id);

    if (!agent) {
      return res.status(404).json({ ok: false, error: `Agent "${id}" not found` });
    }

    agent.model = model;
    await writeOpenClawConfig(oc);
    restartGateway();

    return res.json({ ok: true, agent: { id: agent.id, name: agent.name, model: agent.model } });
  } catch (err) {
    console.error('Failed to update agent model:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to update agent' });
  }
});
```

**Step 3: Commit**

```bash
git add portal/server.js
git commit -m "feat: add agent model management endpoints (list + update)"
```

---

## Task 5: UI — Settings Page HTML Structure

**Files:**
- Modify: `portal/public/index.html` (add new view before toast container)

**Step 1: Add "Configuration" quick-link to home view**

In the `.quick-links` grid (after the existing Settings button), add:

```html
<button class="action-card" id="link-config">
  <div class="action-icon">&#x1f527;</div>
  <div class="action-label">Configuration</div>
</button>
```

**Step 2: Add config view HTML**

Before the `<!-- Toast container -->` comment, add the full config view:

```html
<!-- Config View -->
<div id="view-config" class="view" hidden>
  <header class="portal-header">
    <button id="btn-config-back" class="btn-icon" title="Back">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M13 4l-6 6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button>
    <h2 class="settings-title">Configuration</h2>
    <div></div>
  </header>
  <main class="portal-main">

    <!-- API Keys Section -->
    <h3 class="config-section-title">API Keys</h3>
    <div id="keys-container"></div>

    <!-- Model Picker Section -->
    <h3 class="config-section-title" style="margin-top:2rem">Model Assignments</h3>
    <p class="text-muted" style="margin-bottom:1rem">Assign models to each agent. Only providers with configured keys are shown.</p>
    <div id="agents-container"></div>

    <!-- Advanced Section -->
    <details class="config-advanced" style="margin-top:2rem">
      <summary class="config-advanced-toggle">Advanced Settings — for power users</summary>
      <div class="config-advanced-body">
        <div class="card" style="border-color:var(--accent);margin-top:1rem">
          <h4 style="color:var(--text);margin-bottom:0.5rem">Open Dashboard</h4>
          <p class="text-muted" style="margin-bottom:0.75rem">Direct access to raw configuration. Changes here can break your setup.</p>
          <a id="link-raw-dashboard" href="/" class="btn-secondary">Open Dashboard</a>
        </div>
        <div class="card" style="margin-top:1rem">
          <h4 style="color:var(--text);margin-bottom:0.5rem">Download Config</h4>
          <p class="text-muted" style="margin-bottom:0.75rem">Export your current openclaw.json configuration.</p>
          <button id="btn-download-config" class="btn-secondary">Download Config</button>
        </div>
        <div class="card" style="margin-top:1rem;opacity:0.5">
          <h4 style="color:var(--text);margin-bottom:0.5rem">Terminal Access</h4>
          <p class="text-muted">Coming soon.</p>
        </div>
      </div>
    </details>

  </main>
</div>
```

**Step 3: Commit**

```bash
git add portal/public/index.html
git commit -m "feat: add config view HTML structure with keys, models, and advanced sections"
```

---

## Task 6: UI — Styles for Config View

**Files:**
- Modify: `portal/public/styles.css` (add before mobile responsive section)

**Step 1: Add config-specific styles**

Before the `/* Mobile Responsive */` comment, add:

```css
/* Config View */
.config-section-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--text);
  margin-bottom: 1rem;
}

/* Provider key cards */
.key-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1.25rem;
  margin-bottom: 0.75rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.key-card-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.key-card-provider {
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--text);
  text-transform: capitalize;
}

.key-card-status {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.key-card-masked {
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.key-card-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-shrink: 0;
}

.key-card-actions .btn-primary,
.key-card-actions .btn-secondary {
  width: auto;
  padding: 0.5rem 1rem;
  font-size: 0.85rem;
}

/* Key input inline form */
.key-input-row {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
  flex-wrap: wrap;
}

.key-input-row input {
  flex: 1;
  min-width: 200px;
  margin-bottom: 0;
}

.key-input-row button {
  width: auto;
  padding: 0.5rem 1rem;
  flex-shrink: 0;
}

.key-feedback {
  font-size: 0.8rem;
  margin-top: 0.5rem;
}

/* Agent model cards */
.agent-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1.25rem;
  margin-bottom: 0.75rem;
}

.agent-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.agent-card-name {
  font-weight: 600;
  color: var(--text);
}

.agent-card-model {
  font-family: 'SF Mono', Monaco, 'Courier New', monospace;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.agent-model-row {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.75rem;
  align-items: center;
  flex-wrap: wrap;
}

.agent-model-row select,
.agent-model-row input {
  flex: 1;
  min-width: 180px;
  margin-bottom: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  font-size: 0.9rem;
  font-family: inherit;
}

.agent-model-row select:focus,
.agent-model-row input:focus {
  border-color: var(--accent);
  outline: none;
}

.agent-model-row button {
  width: auto;
  padding: 0.5rem 1rem;
  flex-shrink: 0;
}

/* Custom model text input (hidden by default) */
.custom-model-input {
  display: none;
}

.custom-model-input.visible {
  display: block;
}

/* Advanced toggle */
.config-advanced {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.config-advanced-toggle {
  display: block;
  width: 100%;
  padding: 1rem 1.25rem;
  background: var(--surface);
  color: var(--text-muted);
  font-weight: 600;
  font-size: 0.9rem;
  cursor: pointer;
  list-style: none;
}

.config-advanced-toggle::-webkit-details-marker {
  display: none;
}

.config-advanced-toggle::before {
  content: '▸ ';
}

.config-advanced[open] .config-advanced-toggle::before {
  content: '▾ ';
}

.config-advanced-body {
  padding: 0 1.25rem 1.25rem;
  background: var(--surface);
}
```

**Step 2: Add mobile tweaks to the existing `@media (max-width: 768px)` block**

```css
  .key-card {
    flex-direction: column;
    align-items: flex-start;
  }

  .key-card-actions {
    width: 100%;
  }

  .key-card-actions .btn-primary,
  .key-card-actions .btn-secondary {
    flex: 1;
  }
```

**Step 3: Commit**

```bash
git add portal/public/styles.css
git commit -m "feat: add styles for config view (key cards, model picker, advanced toggle)"
```

---

## Task 7: UI — JavaScript Logic for Config View

**Files:**
- Modify: `portal/public/app.js` (add config logic inside the existing IIFE)

**Step 1: Add curated models list and state**

After the `let profile = null;` line at the top of the IIFE, add:

```javascript
let configuredProviders = [];

const CURATED_MODELS = [
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', provider: 'anthropic' },
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'anthropic' },
  { value: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
  { value: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'openai' },
  { value: 'o1', label: 'o1', provider: 'openai' },
  { value: 'o3-mini', label: 'o3-mini', provider: 'openai' },
];
```

**Step 2: Add loadKeys function**

```javascript
async function loadKeys() {
  const container = document.getElementById('keys-container');
  container.innerHTML = '';

  const data = await api('GET', '/portal/api/config/keys');
  if (!data.ok) {
    container.innerHTML = '<p class="text-muted">Failed to load API keys.</p>';
    return;
  }

  configuredProviders = data.providers.filter(p => p.configured).map(p => p.provider);

  for (const prov of data.providers) {
    const card = document.createElement('div');
    card.className = 'key-card';
    card.dataset.provider = prov.provider;

    const info = document.createElement('div');
    info.className = 'key-card-info';

    const name = document.createElement('span');
    name.className = 'key-card-provider';
    name.textContent = prov.provider;
    info.appendChild(name);

    if (prov.configured) {
      const masked = document.createElement('span');
      masked.className = 'key-card-masked';
      masked.textContent = prov.masked;
      info.appendChild(masked);

      const dot = document.createElement('span');
      dot.className = 'status-dot status-online';
      dot.style.marginLeft = '0.5rem';
      info.appendChild(dot);
    } else {
      const status = document.createElement('span');
      status.className = 'key-card-status';
      status.textContent = 'Not configured';
      info.appendChild(status);
    }

    card.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'key-card-actions';

    if (prov.configured) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-text';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => removeKey(prov.provider));
      actions.appendChild(removeBtn);
    }

    const addBtn = document.createElement('button');
    addBtn.className = prov.configured ? 'btn-secondary' : 'btn-primary';
    addBtn.textContent = prov.configured ? 'Update Key' : 'Add API Key';
    addBtn.addEventListener('click', () => toggleKeyInput(card, prov.provider));
    actions.appendChild(addBtn);

    card.appendChild(actions);
    container.appendChild(card);
  }
}
```

**Step 3: Add key input toggle, test, save, remove functions**

```javascript
function toggleKeyInput(card, provider) {
  // Remove any existing input row
  const existing = card.querySelector('.key-input-row');
  if (existing) {
    existing.remove();
    const fb = card.querySelector('.key-feedback');
    if (fb) fb.remove();
    return;
  }

  const row = document.createElement('div');
  row.className = 'key-input-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = provider === 'anthropic' ? 'sk-ant-...' :
                      provider === 'openai' ? 'sk-...' :
                      provider === 'openrouter' ? 'sk-or-...' : 'AI...';
  input.autocomplete = 'off';

  const testBtn = document.createElement('button');
  testBtn.className = 'btn-secondary';
  testBtn.textContent = 'Test';
  testBtn.addEventListener('click', () => testKey(card, provider, input.value));

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-primary';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => saveKey(card, provider, input.value));

  row.appendChild(input);
  row.appendChild(testBtn);
  row.appendChild(saveBtn);
  card.appendChild(row);
  input.focus();
}

async function testKey(card, provider, key) {
  setKeyFeedback(card, 'Testing...', '');
  const data = await api('POST', '/portal/api/config/keys/test', { provider, key });
  if (data.ok) {
    setKeyFeedback(card, data.message, 'feedback-success');
  } else {
    setKeyFeedback(card, data.error, 'feedback-error');
  }
}

async function saveKey(card, provider, key) {
  setKeyFeedback(card, 'Saving...', '');
  const data = await api('POST', '/portal/api/config/keys', { provider, key });
  if (data.ok) {
    toast(provider + ' key saved');
    loadKeys();
    loadAgents(); // refresh model dropdowns
  } else {
    setKeyFeedback(card, data.error, 'feedback-error');
  }
}

async function removeKey(provider) {
  const data = await api('DELETE', '/portal/api/config/keys/' + provider);
  if (data.ok) {
    toast(provider + ' key removed');
    loadKeys();
    loadAgents();
  } else {
    toast(data.error || 'Failed to remove key');
  }
}

function setKeyFeedback(card, message, className) {
  let fb = card.querySelector('.key-feedback');
  if (!fb) {
    fb = document.createElement('div');
    fb.className = 'key-feedback';
    card.appendChild(fb);
  }
  fb.textContent = message;
  fb.className = 'key-feedback ' + (className || '');
}
```

**Step 4: Add loadAgents and model update functions**

```javascript
async function loadAgents() {
  const container = document.getElementById('agents-container');
  container.innerHTML = '';

  const data = await api('GET', '/portal/api/config/agents');
  if (!data.ok) {
    container.innerHTML = '<p class="text-muted">Failed to load agents.</p>';
    return;
  }

  for (const agent of data.agents) {
    const card = document.createElement('div');
    card.className = 'agent-card';

    const header = document.createElement('div');
    header.className = 'agent-card-header';

    const name = document.createElement('span');
    name.className = 'agent-card-name';
    name.textContent = agent.name;
    header.appendChild(name);

    const currentModel = document.createElement('span');
    currentModel.className = 'agent-card-model';
    currentModel.textContent = agent.model || 'not set';
    header.appendChild(currentModel);

    card.appendChild(header);

    const row = document.createElement('div');
    row.className = 'agent-model-row';

    const select = document.createElement('select');
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '— select model —';
    select.appendChild(defaultOpt);

    // Group by provider, only show providers with configured keys
    const available = CURATED_MODELS.filter(
      (m) => configuredProviders.includes(m.provider)
    );

    let currentProvider = '';
    for (const m of available) {
      if (m.provider !== currentProvider) {
        const group = document.createElement('optgroup');
        group.label = m.provider.charAt(0).toUpperCase() + m.provider.slice(1);
        for (const gm of available.filter((x) => x.provider === m.provider)) {
          const opt = document.createElement('option');
          opt.value = gm.value;
          opt.textContent = gm.label;
          if (gm.value === agent.model) opt.selected = true;
          group.appendChild(opt);
        }
        select.appendChild(group);
        currentProvider = m.provider;
      }
    }

    // Custom option
    const customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = 'Custom...';
    select.appendChild(customOpt);

    // If current model isn't in curated list, select custom
    const isCurated = CURATED_MODELS.some((m) => m.value === agent.model);
    if (agent.model && !isCurated) {
      customOpt.selected = true;
    }

    const customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.className = 'custom-model-input';
    customInput.placeholder = 'model-name';
    if (agent.model && !isCurated) {
      customInput.classList.add('visible');
      customInput.value = agent.model;
    }

    select.addEventListener('change', () => {
      if (select.value === '__custom__') {
        customInput.classList.add('visible');
        customInput.focus();
      } else {
        customInput.classList.remove('visible');
        customInput.value = '';
      }
    });

    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn-primary';
    applyBtn.textContent = 'Apply';
    applyBtn.addEventListener('click', async () => {
      const model = select.value === '__custom__' ? customInput.value : select.value;
      if (!model) return;
      applyBtn.textContent = 'Saving...';
      applyBtn.disabled = true;
      const result = await api('PATCH', '/portal/api/config/agents/' + agent.id, { model });
      if (result.ok) {
        toast(agent.name + ' model updated');
        currentModel.textContent = model;
      } else {
        toast(result.error || 'Failed to update');
      }
      applyBtn.textContent = 'Apply';
      applyBtn.disabled = false;
    });

    row.appendChild(select);
    row.appendChild(customInput);
    row.appendChild(applyBtn);
    card.appendChild(row);
    container.appendChild(card);
  }
}
```

**Step 5: Add config download function**

```javascript
async function downloadConfig() {
  const data = await api('GET', '/portal/api/config/agents');
  if (!data.ok) {
    toast('Failed to download config');
    return;
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'openclaw.json';
  a.click();
  URL.revokeObjectURL(url);
}
```

**Step 6: Wire up navigation in `init()`**

Add to the `init()` function, alongside existing navigation listeners:

```javascript
// Config view navigation
document.getElementById('link-config').addEventListener('click', () => {
  showView('config');
  loadKeys();
  loadAgents();
});
document.getElementById('btn-config-back').addEventListener('click', () => showView('home'));

// Advanced section
document.getElementById('link-raw-dashboard').href = '/#token=' + (profile?.gatewayToken || '');
document.getElementById('btn-download-config').addEventListener('click', downloadConfig);
```

**Step 7: Commit**

```bash
git add portal/public/app.js
git commit -m "feat: add config view JS — key management, model picker, download"
```

---

## Task 8: Integration Verification

**Step 1: Start the portal server locally**

```bash
cd portal && node server.js
```

Verify no import errors and server starts on port 3847.

**Step 2: Verify API endpoints with curl**

Test each new endpoint:

```bash
# Get keys (will return empty/defaults without real auth-profiles.json)
curl -s http://localhost:3847/portal/api/config/keys -H "Cookie: portal_session=<token>"

# Get agents (needs openclaw.json)
curl -s http://localhost:3847/portal/api/config/agents -H "Cookie: portal_session=<token>"
```

**Step 3: Open portal in browser**

Navigate to `http://localhost:3847/portal/`. Login, verify:
- New "Configuration" quick-link appears on home
- Clicking it shows the config view with API Keys, Model Assignments, and Advanced sections
- Key cards render for each provider
- "Add API Key" expands inline input with Test/Save buttons
- Advanced toggle reveals dashboard link, download, and terminal placeholder

**Step 4: Commit all remaining tweaks**

```bash
git add -A
git commit -m "feat: portal config settings — API keys, model picker, advanced toggle"
```

---

## Summary of All Files Changed

| File | Change |
|------|--------|
| `index.html` | Remove duplicate Config Access rows (mobile + desktop) |
| `portal/server.js` | Add config path env vars, file helpers, key validation, 6 new API routes, gateway restart |
| `portal/public/index.html` | Add Configuration quick-link, add `view-config` with keys/models/advanced HTML |
| `portal/public/app.js` | Add config state, loadKeys, loadAgents, key CRUD, model update, download, navigation |
| `portal/public/styles.css` | Add key-card, agent-card, config-advanced, custom-model-input styles + mobile tweaks |
