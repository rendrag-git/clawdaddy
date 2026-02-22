# Phase 2 Streams I & J Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire Phase 1 backend modules (profile-generator SSE hooks, multi-provider OAuth, auto-deploy) into the onboarding server and frontend.

**Architecture:** Stream I modifies `api/onboarding-server.js` + `api/lib/db.js` to add SSE profile gen endpoint, multi-provider auth routes, and dual-trigger auto-deploy. Stream J rewrites `onboarding/index.html` to match homepage theme, fix layout stability, add localStorage persistence, SSE progress UI, and a provider grid for auth. I must complete before J.

**Tech Stack:** Express (CommonJS), vanilla JS/HTML/CSS, Tailwind CDN, SQLite (better-sqlite3), SSE (EventSource)

**Design doc:** `docs/plans/2026-02-22-phase2-streams-ij-design.md`

---

## Stream I: Onboarding Server Wiring

### Task 1: DB migration — add `deploy_status` column

**Files:**
- Modify: `api/lib/db.js:42-53` (CREATE TABLE onboarding_sessions)
- Modify: `api/lib/db.js:84-87` (ALTER TABLE migrations block)
- Modify: `api/lib/db.js:192` (updateOnboardingSession allowed list)

**Step 1: Add ALTER TABLE migration for deploy_status**

In `api/lib/db.js`, after line 87 (`ALTER TABLE customers ADD COLUMN dns_token`), add:

```js
try { db.exec("ALTER TABLE onboarding_sessions ADD COLUMN deploy_status TEXT DEFAULT 'pending'"); } catch (_) {}
```

**Step 2: Add `deploy_status` to updateOnboardingSession allowed list**

In `api/lib/db.js` line 192, change:

```js
const allowed = ['quiz_results', 'generated_files', 'gateway_token', 'portal_password', 'step'];
```

to:

```js
const allowed = ['quiz_results', 'generated_files', 'gateway_token', 'portal_password', 'step', 'deploy_status'];
```

**Step 3: Run existing tests**

Run: `node --test api/lib/db.test.js`
Expected: All existing tests pass (migration is additive, doesn't break anything).

**Step 4: Commit**

```bash
git add api/lib/db.js
git commit -m "feat(db): add deploy_status column to onboarding_sessions"
```

---

### Task 2: `tryDeployIfReady()` + Discord alert

**Files:**
- Modify: `api/onboarding-server.js:9` (add `updateOnboardingSession` import if missing — it's already imported)
- Modify: `api/onboarding-server.js:89-90` (insert new function before `deployFilesToInstance`)

**Step 1: Add Discord alert helper and tryDeployIfReady function**

Insert before the `deployFilesToInstance` function (at line 90 in `api/onboarding-server.js`):

```js
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
  const { getDb } = require('./lib/db');
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
```

**Step 2: Update the import line to include `getDb`**

In `api/onboarding-server.js` line 9, add `getDb` to the destructured import:

```js
const { initDb, getDb, getCustomerByStripeSessionId, getCustomerByUsername, getOnboardingSession, updateOnboardingSession, updateAuth, isUsernameAvailable, reserveUsername, sweepExpiredReservations, storeOAuthState, clearOAuthState } = require('./lib/db');
```

Note: `getDb` is already exported from `db.js` (line 362).

**Step 3: Replace the fire-and-forget deploy in generate-profile endpoint**

In the existing `POST /api/onboarding/generate-profile/:sessionId` handler (around line 723-726), replace:

```js
    // Try auto-deploy files (in case provisioning already completed)
    void deployFilesToInstance(sessionId).catch(err =>
      console.error(`Auto-deploy failed for ${sessionId}: ${err.message}`)
    );
```

with:

```js
    // Try auto-deploy (fires if provisioning is also complete)
    void tryDeployIfReady(sessionId);
```

**Step 4: Add deploy trigger to status polling endpoint**

In the `GET /api/onboarding/status/:sessionId` handler (around line 448-467), add the deploy trigger and `deployStatus` field. Replace the handler body:

```js
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
    deployStatus: session?.deploy_status || 'pending',
    authStatus: customer.auth_status,
    webchatUrl: customer.dns_hostname ? `https://${customer.dns_hostname}` : null,
  });
});
```

**Step 5: Commit**

```bash
git add api/onboarding-server.js api/lib/db.js
git commit -m "feat: add tryDeployIfReady with idempotent dual-trigger and Discord alerts"
```

---

### Task 3: SSE Profile Generation Endpoint

**Files:**
- Modify: `api/onboarding-server.js` (insert new GET route before existing POST generate-profile, around line 669)

**Step 1: Add the SSE endpoint**

Insert this new route BEFORE the existing `POST /api/onboarding/generate-profile/:sessionId` handler:

```js
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
```

**Step 2: Verify the existing POST endpoint still works (fallback)**

The existing `POST /api/onboarding/generate-profile/:sessionId` at line 669 should remain unchanged (it's the non-SSE fallback). No modifications needed.

**Step 3: Commit**

```bash
git add api/onboarding-server.js
git commit -m "feat: add SSE endpoint for profile generation with progress events"
```

---

### Task 4: Multi-Provider Auth Routes

**Files:**
- Modify: `api/onboarding-server.js:10` (import `authWithApiKey`, `getProviderList`)
- Modify: `api/onboarding-server.js:769-819` (update existing auth routes, add new ones)

**Step 1: Update imports**

In `api/onboarding-server.js` line 10, change:

```js
const { startAuth, completeAuth } = require('./lib/oauth');
```

to:

```js
const { startAuth, completeAuth, authWithApiKey, getProviderList } = require('./lib/oauth');
```

**Step 2: Add GET /api/providers route**

Insert before the auth routes (around line 769):

```js
// GET /api/providers — list available auth providers
app.get('/api/providers', (_req, res) => {
  return res.json({ ok: true, providers: getProviderList() });
});
```

**Step 3: Update POST /api/onboarding/auth/start to accept provider param**

Replace the existing handler (lines 770-792) with:

```js
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
```

**Step 4: Update POST /api/onboarding/auth/complete to accept provider param**

Replace the existing handler (lines 794-819) with:

```js
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
```

**Step 5: Add POST /api/onboarding/auth/api-key route**

Insert after the auth/complete handler:

```js
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
```

**Step 6: Commit**

```bash
git add api/onboarding-server.js
git commit -m "feat: multi-provider auth routes — provider list, OAuth start/complete, API key"
```

---

### Task 5: Key verification endpoint

**Files:**
- Modify: `api/onboarding-server.js` (add route after api-key route)

**Step 1: Add POST /api/onboarding/auth/verify route**

This does a lightweight API call per provider to verify the key works. Insert after the api-key route:

```js
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
```

**Step 2: Commit**

```bash
git add api/onboarding-server.js
git commit -m "feat: add provider key verification endpoint"
```

---

## Stream J: Onboarding Frontend

### Task 6: Theme alignment — switch to homepage design system

**Files:**
- Modify: `onboarding/index.html:1-680` (head, styles, body structure)

This is the largest task. It replaces the custom purple/blue/cyan theme with the homepage's lobster red + zinc dark theme using Tailwind CDN.

**Step 1: Replace the `<head>` section**

Replace lines 1-16 (head through the Inter font link) with:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ClawDaddy Onboarding</title>
    <meta name="description" content="Complete your ClawDaddy setup and get your OpenClaw webchat URL." />
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
      tailwind.config = {
        theme: {
          extend: {
            colors: {
              lobster: "#E63946",
            },
            boxShadow: {
              glow: "0 0 0 1px rgba(230,57,70,0.25), 0 12px 34px rgba(230,57,70,0.2)",
            },
          },
        },
      };
    </script>
```

**Step 2: Replace the entire `<style>` block**

Replace lines 17-680 (the entire `<style>` tag contents) with a new style block that uses the homepage design tokens. Key changes:

- `body` background: `#090b10` with lobster red radial gradients (matching homepage)
- Remove all CSS custom properties (`--bg`, `--accent`, `--accent-2`, etc.)
- Buttons: lobster red solid, not purple/cyan gradient
- Progress bar: lobster red gradient
- Options: zinc borders/backgrounds, lobster red for selected state
- Panels: `bg-zinc-900/75 border-zinc-800 rounded-2xl` (match homepage cards)
- Keep transitions, animations, and layout CSS but update colors

The complete CSS will be in the implementation — it maps every existing CSS rule to the homepage color palette. The key color substitutions:

| Old | New |
|-----|-----|
| `#050714` (bg) | `#090b10` |
| `rgba(121,103,255,0.35)` (purple gradient) | `rgba(230,57,70,0.2)` (lobster gradient) |
| `rgba(56,180,255,0.32)` (cyan gradient) | `rgba(230,57,70,0.12)` |
| `#7c8cff` (accent purple) | `#E63946` (lobster) |
| `#3ee7ff` (accent cyan) | `#ef4444` (red-500, secondary) |
| `#e6ecff` (text) | `#f4f4f5` (zinc-100) |
| `#a7b3d8` (text-muted) | `#a1a1aa` (zinc-400) |
| `rgba(12,16,38,0.78)` (panel bg) | `rgba(24,24,27,0.75)` (zinc-900/75) |
| `rgba(140,168,255,0.22)` (panel border) | `rgba(63,63,70,0.8)` (zinc-700) |
| `rgba(8,12,30,0.9)` (input bg) | `rgba(24,24,27,0.9)` (zinc-900/90) |
| `rgba(124,140,255,…)` (selected states) | `rgba(230,57,70,…)` (lobster states) |
| `#45e4a5` (success green) | `#4ade80` (green-400 — keep green for success) |
| `#ffb3cb` (error pink) | `#fca5a5` (red-300) |
| `Inter` font | system default (remove import) |

**Step 3: Update the body HTML**

Replace the welcome screen (lines 685-690) to remove orphaned Tailwind classes that don't resolve and use proper Tailwind classes now that CDN is loaded:

```html
<section id="welcome-screen" style="max-width:36rem;margin:0 auto;padding:4rem 1rem;text-align:center">
  <h1 class="text-3xl font-black text-white sm:text-4xl">Welcome to ClawDaddy</h1>
  <p class="mt-4 text-lg text-zinc-300">Thanks for subscribing! Let's set up your personal AI assistant.</p>
  <p class="mt-2 text-sm text-zinc-400">You'll take a quick personality quiz, connect your AI provider, and we'll spin up a dedicated assistant just for you.</p>
  <button id="start-setup-btn" class="mt-8 inline-flex min-h-[46px] items-center justify-center rounded-xl bg-lobster px-8 py-3 font-bold text-white shadow-glow transition hover:-translate-y-0.5 hover:bg-red-500">Start Setup</button>
</section>
```

**Step 4: Test visually — open in browser and compare against homepage**

Run: `open onboarding/index.html` (or use dev server)
Expected: Colors match homepage — lobster red accent, zinc grays, dark `#090b10` background with red glows.

**Step 5: Commit**

```bash
git add onboarding/index.html
git commit -m "feat(frontend): align onboarding theme with homepage design system"
```

---

### Task 7: Layout stability — absolute positioned slides

**Files:**
- Modify: `onboarding/index.html` (CSS quiz-question-area and quiz-slide rules)

**Step 1: Update quiz-question-area CSS**

Ensure the quiz question area uses `position: relative` with a fixed `min-height`, and slides use `position: absolute` to overlap during transitions:

```css
.quiz-question-area {
  position: relative;
  overflow: hidden;
  min-height: 420px;
}

.quiz-slide {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  transition: transform 0.3s ease, opacity 0.3s ease;
}

.quiz-slide.slide-out-left {
  transform: translateX(-30px);
  opacity: 0;
  pointer-events: none;
}

.quiz-slide.slide-in-right {
  transform: translateX(30px);
  opacity: 0;
}

.quiz-slide.slide-out-right {
  transform: translateX(30px);
  opacity: 0;
  pointer-events: none;
}
```

Remove the duplicate `position: absolute` from the `.slide-out-left` and `.slide-out-right` rules that were previously needed (they now inherit from `.quiz-slide`).

**Step 2: Update renderQuestion() to manage slide positioning**

In the JS, when rendering a new question, the slide is initially positioned at `translateX(0)`. The key change is ensuring the container min-height stays stable. Add a resize observer or fixed min-height approach in the render functions.

After `renderQuestion()` inserts HTML, add a micro-delay to measure height:

```js
// In each render function, after setting innerHTML:
requestAnimationFrame(() => {
  const slide = quizQuestionArea.querySelector('.quiz-slide');
  if (slide) {
    const height = slide.offsetHeight;
    quizQuestionArea.style.minHeight = Math.max(420, height) + 'px';
  }
});
```

**Step 3: Test — step through all 17 quiz screens**

Expected: No content jumping. Transitions are smooth overlaps. Container doesn't resize between slides.

**Step 4: Commit**

```bash
git add onboarding/index.html
git commit -m "fix(frontend): stabilize quiz layout with absolute-positioned slides"
```

---

### Task 8: Quiz state persistence (localStorage)

**Files:**
- Modify: `onboarding/index.html` (JS section)

**Step 1: Add save/restore functions**

Add after the state object definition (around line 1013):

```js
// ======== Quiz State Persistence ========
const STORAGE_KEY = `clawdaddy_quiz_${sessionId}`;
const STORAGE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

function saveQuizState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      quizIndex: state.quizIndex,
      answers: state.answers,
      perQuestionContext: state.perQuestionContext,
      savedAt: Date.now(),
    }));
  } catch (_) {} // localStorage may be unavailable
}

function restoreQuizState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (Date.now() - saved.savedAt > STORAGE_MAX_AGE) {
      localStorage.removeItem(STORAGE_KEY);
      return false;
    }
    state.quizIndex = saved.quizIndex || 0;
    state.answers = saved.answers || {};
    state.perQuestionContext = saved.perQuestionContext || {};
    return true;
  } catch (_) {
    return false;
  }
}

function clearQuizState() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
}
```

**Step 2: Call saveQuizState() on every answer change**

In `attachSingleSelectListeners` (around line 1235, the click handler), add after `state.answers[q.id] = optionId;`:

```js
saveQuizState();
```

In `attachMultiSelectListeners` (around line 1268, after `state.answers[q.id] = selected;`):

```js
saveQuizState();
```

In `attachShortTextListeners` (around line 1280, the input handler), add after `state.answers[q.id] = e.target.value.trim();`:

```js
saveQuizState();
```

In `attachContextToggle` (around line 1331, the textarea input handler), add after `state.perQuestionContext[q.id] = e.target.value.trim();`:

```js
saveQuizState();
```

In `attachFinalScreenListeners` (around line 1302, the textarea input handler), add after `state.answers['FINAL_SCREEN'] = e.target.value.trim();`:

```js
saveQuizState();
```

In `nextQuestion()` and `prevQuestion()`, add after changing `state.quizIndex`:

```js
saveQuizState();
```

**Step 3: Restore state on page load**

Modify `initOnboarding()` — after successfully loading customer data and before the function returns, check server-side step and restore:

After `state.serverReady = payload.provisionStatus === 'ready';` (around line 788), add:

```js
// If server says we're past quiz step, don't restore localStorage
if (payload.step && payload.step !== 'quiz') {
  clearQuizState();
  // Show appropriate step
  document.getElementById('welcome-screen').style.display = 'none';
  document.getElementById('wizard-content').style.display = '';
  if (payload.step === 'auth' || payload.step === 'profile') {
    showStep(3);
    startPolling();
    renderStep3();
  } else if (payload.step === 'complete') {
    showStep(4);
    renderSetupComplete();
  }
  return;
}

// Try restoring quiz state from localStorage
state.quizRestored = restoreQuizState();
```

Then in the "Start Setup" button handler, check `state.quizRestored`:

```js
document.getElementById('start-setup-btn').addEventListener('click', async () => {
  document.getElementById('welcome-screen').style.display = 'none';
  document.getElementById('wizard-content').style.display = '';
  showStep(2);
  startPolling();
  renderQuestion(); // Will use restored quizIndex if available
});
```

**Step 4: Clear state on successful quiz submission**

In `submitQuiz()`, after the quiz POST succeeds (around line 1409, after `if (!quizRes.ok) throw`), add:

```js
clearQuizState();
```

**Step 5: Test — answer 5 questions, refresh, verify resume at question 6**

Expected: After refresh, clicking "Start Setup" resumes at question 6 with previous answers intact.

**Step 6: Commit**

```bash
git add onboarding/index.html
git commit -m "feat(frontend): persist quiz state to localStorage with 24h TTL"
```

---

### Task 9: SSE Progress UI for profile generation

**Files:**
- Modify: `onboarding/index.html` (the `submitQuiz()` function and supporting CSS)

**Step 1: Add progress stage CSS**

Add to the `<style>` block:

```css
.profile-progress { text-align: center; padding: 2rem 0; }
.profile-stages { display: flex; justify-content: center; gap: 1.5rem; margin: 1.5rem 0; }
.profile-stage { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; }
.profile-stage-dot {
  width: 12px; height: 12px; border-radius: 50%;
  background: rgba(161,161,170,0.3);
  transition: all 0.4s ease;
}
.profile-stage-dot.active {
  background: #E63946;
  box-shadow: 0 0 12px rgba(230,57,70,0.5);
  animation: stagePulse 1.8s ease-in-out infinite;
}
.profile-stage-dot.done { background: #4ade80; }
.profile-stage-label { font-size: 0.75rem; color: #a1a1aa; white-space: nowrap; }
.profile-stage-label.active { color: #f4f4f5; }
.profile-stage-label.done { color: #4ade80; }
.profile-message { font-size: 1rem; color: #d4d4d8; margin-top: 1rem; }

@keyframes stagePulse {
  0%, 100% { box-shadow: 0 0 12px rgba(230,57,70,0.5); }
  50% { box-shadow: 0 0 24px rgba(230,57,70,0.8); }
}
```

**Step 2: Replace submitQuiz() to use SSE**

Replace the `submitQuiz()` function with:

```js
async function submitQuiz() {
  const scores = calculateScores(state.answers, state.perQuestionContext);

  const anythingElse = state.answers['FINAL_SCREEN'] || '';
  if (anythingElse) {
    scores.freeText.anything_else = anythingElse;
  }

  // Show progress UI
  const stages = ['analyzing', 'generating', 'agents', 'complete'];
  const stageLabels = { analyzing: 'Analyze', generating: 'Generate', agents: 'Agents', complete: 'Done' };

  quizQuestionArea.innerHTML = `
    <div class="profile-progress">
      <p class="profile-message">Submitting quiz...</p>
      <div class="profile-stages">
        ${stages.map(s => `
          <div class="profile-stage" data-stage="${s}">
            <div class="profile-stage-dot"></div>
            <div class="profile-stage-label">${stageLabels[s]}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  function updateStage(currentStage) {
    const msgEl = quizQuestionArea.querySelector('.profile-message');
    stages.forEach(s => {
      const stageEl = quizQuestionArea.querySelector(`[data-stage="${s}"]`);
      if (!stageEl) return;
      const dot = stageEl.querySelector('.profile-stage-dot');
      const label = stageEl.querySelector('.profile-stage-label');
      const idx = stages.indexOf(s);
      const currentIdx = stages.indexOf(currentStage);
      dot.className = 'profile-stage-dot' + (idx < currentIdx ? ' done' : idx === currentIdx ? ' active' : '');
      label.className = 'profile-stage-label' + (idx < currentIdx ? ' done' : idx === currentIdx ? ' active' : '');
    });
  }

  try {
    // Submit quiz results
    const quizRes = await fetch(`${API_BASE}/api/onboarding/quiz/${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        answers: state.answers,
        perQuestionContext: state.perQuestionContext,
        traits: scores.traits,
        dimensionScores: scores.dimensionScores,
        tags: scores.tags,
        freeText: scores.freeText
      })
    });
    if (!quizRes.ok) throw new Error('Failed to save quiz results.');

    clearQuizState();

    // Try SSE for profile generation
    let sseSucceeded = false;
    try {
      await new Promise((resolve, reject) => {
        const url = `${API_BASE}/api/onboarding/generate-profile/${encodeURIComponent(sessionId)}/stream`;
        const es = new EventSource(url);
        let gotFirstEvent = false;

        const timeout = setTimeout(() => {
          if (!gotFirstEvent) {
            es.close();
            reject(new Error('SSE timeout'));
          }
        }, 10000);

        es.onmessage = (event) => {
          gotFirstEvent = true;
          clearTimeout(timeout);
          try {
            const data = JSON.parse(event.data);
            if (data.stage === 'error') {
              es.close();
              reject(new Error(data.message));
              return;
            }
            updateStage(data.stage);
            const msgEl = quizQuestionArea.querySelector('.profile-message');
            if (msgEl) msgEl.textContent = data.message;
            if (data.stage === 'complete') {
              es.close();
              sseSucceeded = true;
              resolve();
            }
          } catch (_) {}
        };

        es.onerror = () => {
          if (!gotFirstEvent) {
            clearTimeout(timeout);
            es.close();
            reject(new Error('SSE connection failed'));
          }
          // If we already got events, EventSource will auto-reconnect
        };
      });
    } catch (sseErr) {
      // Fallback to synchronous POST
      console.warn('SSE failed, falling back to sync:', sseErr.message);
      const msgEl = quizQuestionArea.querySelector('.profile-message');
      if (msgEl) msgEl.textContent = 'Building your profile (this takes about 2 minutes)...';
      updateStage('generating');
      const profileRes = await fetch(`${API_BASE}/api/onboarding/generate-profile/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { Accept: 'application/json' }
      });
      if (!profileRes.ok) throw new Error('Failed to generate profile.');
      sseSucceeded = true;
    }

    if (sseSucceeded) {
      showStep(3);
      renderStep3();
    }
  } catch (error) {
    quizQuestionArea.innerHTML = `
      <div style="text-align:center;padding:2rem 0;">
        <p style="color:#fca5a5;margin-bottom:1rem;">${escapeHtml(error.message || 'Error submitting quiz.')}</p>
        <button class="button" onclick="location.reload()">Try Again</button>
      </div>
    `;
  }
}
```

**Step 3: Commit**

```bash
git add onboarding/index.html
git commit -m "feat(frontend): SSE progress UI for profile generation with sync fallback"
```

---

### Task 10: Multi-provider auth grid

**Files:**
- Modify: `onboarding/index.html` (replace `renderStep3()`, `startAuthFlow()`, and `submitAuthCode()`)

**Step 1: Add provider grid CSS**

Add to the `<style>` block:

```css
.provider-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.75rem;
  margin: 1.2rem 0;
}

.provider-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem;
  border-radius: 12px;
  border: 1px solid rgba(63,63,70,0.8);
  background: rgba(24,24,27,0.75);
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
}

.provider-card:hover { border-color: rgba(113,113,122,0.8); }
.provider-card.active { border-color: #E63946; background: rgba(230,57,70,0.08); }
.provider-card.connected { border-color: #4ade80; }

.provider-icon {
  width: 36px; height: 36px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-weight: 700; font-size: 0.85rem; color: #fff;
  flex-shrink: 0;
}

.provider-name { font-weight: 600; font-size: 0.9rem; }

.provider-badge {
  margin-left: auto;
  font-size: 0.7rem;
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  font-weight: 600;
}
.provider-badge.connected { background: rgba(74,222,128,0.15); color: #4ade80; }
.provider-badge.disconnected { background: rgba(161,161,170,0.1); color: #71717a; }

.provider-detail {
  padding: 1rem;
  border-radius: 12px;
  border: 1px solid rgba(63,63,70,0.6);
  background: rgba(24,24,27,0.6);
  margin-bottom: 0.75rem;
}

.provider-divider {
  display: flex; align-items: center; gap: 0.75rem;
  margin: 0.75rem 0; color: #71717a; font-size: 0.82rem;
}
.provider-divider::before, .provider-divider::after {
  content: ''; flex: 1; height: 1px; background: rgba(63,63,70,0.6);
}

@media (max-width: 480px) {
  .provider-grid { grid-template-columns: 1fr; }
}
```

**Step 2: Replace renderStep3() and auth functions**

Replace the entire `renderStep3()`, `startAuthFlow()`, and `submitAuthCode()` functions with:

```js
// ======== Step 3: Connect Your AI ========
const PROVIDER_COLORS = {
  anthropic: '#D4A373', openai: '#10A37F', openrouter: '#6366F1',
  google: '#4285F4', xai: '#a1a1aa', groq: '#F55036',
};
const connectedProviders = new Set();
let providerList = [];

async function renderStep3() {
  if (!state.serverReady) {
    step3Content.innerHTML = `
      <div style="text-align:center;padding:2rem 0;">
        <div class="provision-chip">
          <span class="pulse-dot"></span>
          <span>Waiting for your server to finish setting up...</span>
        </div>
        <p style="color:#a1a1aa;margin-top:0.5rem;">This usually takes 2-3 minutes.</p>
      </div>
    `;
    const checkInterval = setInterval(() => {
      if (state.serverReady) { clearInterval(checkInterval); renderStep3(); }
    }, 1000);
    return;
  }

  // Fetch providers
  if (providerList.length === 0) {
    try {
      const res = await fetch(`${API_BASE}/api/providers`);
      const data = await res.json();
      providerList = data.providers || [];
    } catch (_) {
      providerList = [
        { id: 'anthropic', name: 'Anthropic', supportsOAuth: true, supportsApiKey: true },
        { id: 'openai', name: 'OpenAI', supportsOAuth: false, supportsApiKey: true },
      ];
    }
  }

  step3Content.innerHTML = `
    <p style="color:#d4d4d8;line-height:1.6;">Connect at least one AI provider so your assistant can think. You can add more later.</p>
    <div class="provider-grid" id="provider-grid"></div>
    <div id="provider-detail-area"></div>
    <button class="button" id="auth-continue-btn" disabled style="margin-top:1rem;width:100%;">Continue</button>
  `;

  renderProviderGrid();

  document.getElementById('auth-continue-btn').addEventListener('click', () => {
    updateOnboardingSession_client();
    showStep(4);
    renderSetupComplete();
  });
}

function renderProviderGrid() {
  const grid = document.getElementById('provider-grid');
  grid.innerHTML = providerList.map(p => {
    const initial = p.name.charAt(0);
    const color = PROVIDER_COLORS[p.id] || '#71717a';
    const isConnected = connectedProviders.has(p.id);
    return `
      <div class="provider-card ${isConnected ? 'connected' : ''}" data-provider="${p.id}">
        <div class="provider-icon" style="background:${color}">${initial}</div>
        <div class="provider-name">${escapeHtml(p.name)}</div>
        <span class="provider-badge ${isConnected ? 'connected' : 'disconnected'}">${isConnected ? 'Connected' : 'Not set'}</span>
      </div>
    `;
  }).join('');

  grid.querySelectorAll('.provider-card').forEach(card => {
    card.addEventListener('click', () => {
      const providerId = card.dataset.provider;
      const provider = providerList.find(p => p.id === providerId);
      if (provider) showProviderDetail(provider);
      grid.querySelectorAll('.provider-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
    });
  });

  // Update continue button
  const btn = document.getElementById('auth-continue-btn');
  if (btn) btn.disabled = connectedProviders.size === 0;
}

function showProviderDetail(provider) {
  const area = document.getElementById('provider-detail-area');
  const isConnected = connectedProviders.has(provider.id);

  let html = `<div class="provider-detail">`;
  html += `<h3 style="font-size:1rem;font-weight:700;margin:0 0 0.75rem;">${escapeHtml(provider.name)}</h3>`;

  if (isConnected) {
    html += `<p style="color:#4ade80;font-size:0.9rem;">Connected</p>`;
    html += `</div>`;
    area.innerHTML = html;
    return;
  }

  if (provider.supportsOAuth) {
    html += `
      <button class="button" id="oauth-start-btn" style="width:100%;">Sign in with ${escapeHtml(provider.name)}</button>
      <div id="oauth-paste-area" class="hidden" style="margin-top:0.75rem;">
        <p style="color:#d4d4d8;font-size:0.88rem;margin-bottom:0.5rem;">
          After authorizing, paste the <strong>CODE#STATE</strong> below:
        </p>
        <input class="input" id="oauth-code-input" type="text" placeholder="Paste CODE#STATE here" autocomplete="off" />
        <button class="button" id="oauth-submit-btn" disabled style="margin-top:0.5rem;width:100%;">Verify</button>
      </div>
    `;
  }

  if (provider.supportsOAuth && provider.supportsApiKey) {
    html += `<div class="provider-divider">or</div>`;
  }

  if (provider.supportsApiKey) {
    html += `
      <div style="margin-top:${provider.supportsOAuth ? '0' : '0'};">
        <input class="input" id="api-key-input" type="password" placeholder="Paste your API key" autocomplete="off" />
        <button class="button" id="api-key-submit-btn" style="margin-top:0.5rem;width:100%;">Save Key</button>
      </div>
    `;
  }

  html += `<p id="provider-feedback" style="min-height:1.4rem;font-size:0.88rem;margin-top:0.5rem;"></p>`;
  html += `</div>`;
  area.innerHTML = html;

  // OAuth flow
  if (provider.supportsOAuth) {
    document.getElementById('oauth-start-btn').addEventListener('click', async () => {
      const btn = document.getElementById('oauth-start-btn');
      btn.disabled = true;
      btn.textContent = 'Opening...';
      try {
        const res = await fetch(`${API_BASE}/api/onboarding/auth/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stripeSessionId: sessionId, provider: provider.id })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        window.open(data.url, '_blank');
        document.getElementById('oauth-paste-area').classList.remove('hidden');
        btn.textContent = 'Link opened — paste code below';
      } catch (err) {
        showFeedback(err.message, true);
        btn.disabled = false;
        btn.textContent = `Sign in with ${provider.name}`;
      }
    });

    const codeInput = document.getElementById('oauth-code-input');
    const submitBtn = document.getElementById('oauth-submit-btn');
    if (codeInput && submitBtn) {
      codeInput.addEventListener('input', () => { submitBtn.disabled = !codeInput.value.trim(); });
      submitBtn.addEventListener('click', async () => {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Verifying...';
        try {
          const res = await fetch(`${API_BASE}/api/onboarding/auth/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stripeSessionId: sessionId, codeState: codeInput.value.trim(), provider: provider.id })
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error);
          markProviderConnected(provider.id);
        } catch (err) {
          showFeedback(err.message, true);
          submitBtn.disabled = false;
          submitBtn.textContent = 'Verify';
        }
      });
    }
  }

  // API key flow
  if (provider.supportsApiKey) {
    const keyInput = document.getElementById('api-key-input');
    const keyBtn = document.getElementById('api-key-submit-btn');
    keyBtn.addEventListener('click', async () => {
      const key = keyInput.value.trim();
      if (!key) return;
      keyBtn.disabled = true;
      keyBtn.textContent = 'Verifying...';
      showFeedback('');

      // Verify key first
      try {
        const verifyRes = await fetch(`${API_BASE}/api/onboarding/auth/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: provider.id, apiKey: key })
        });
        const verifyData = await verifyRes.json();
        if (verifyData.ok && !verifyData.valid) {
          showFeedback(verifyData.error || 'Invalid key — check and try again.', true);
          keyBtn.disabled = false;
          keyBtn.textContent = 'Save Key';
          return;
        }
      } catch (_) {
        // Verification endpoint failed — proceed anyway
      }

      // Save key
      try {
        const res = await fetch(`${API_BASE}/api/onboarding/auth/api-key`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stripeSessionId: sessionId, provider: provider.id, apiKey: key })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error);
        markProviderConnected(provider.id);
      } catch (err) {
        showFeedback(err.message, true);
        keyBtn.disabled = false;
        keyBtn.textContent = 'Save Key';
      }
    });
  }
}

function showFeedback(message, isError) {
  const el = document.getElementById('provider-feedback');
  if (el) {
    el.textContent = message;
    el.style.color = isError ? '#fca5a5' : '#4ade80';
  }
}

function markProviderConnected(providerId) {
  connectedProviders.add(providerId);
  renderProviderGrid();
  showProviderDetail(providerList.find(p => p.id === providerId));
}

async function updateOnboardingSession_client() {
  // Signal to server that auth step is complete
  try {
    await fetch(`${API_BASE}/api/onboarding/auth/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stripeSessionId: sessionId, skipAuth: true })
    });
  } catch (_) {}
}
```

Note: The `updateOnboardingSession_client` function is a convenience — the step is already set to `'complete'` by each individual auth call. The Continue button just transitions to step 4 without an extra server call. Remove `updateOnboardingSession_client` and its call, since auth routes already set `step: 'complete'`.

**Step 3: Commit**

```bash
git add onboarding/index.html
git commit -m "feat(frontend): multi-provider auth grid with OAuth + API key support"
```

---

### Task 11: Integration smoke test

**Files:** None (testing only)

**Step 1: Start the onboarding server locally (if possible)**

Run: `node api/onboarding-server.js`
Expected: Server starts on port 3848 without errors.

If it fails due to missing Stripe key file, that's expected on a dev machine. The code changes can be verified by reading through them.

**Step 2: Verify no syntax errors in onboarding/index.html**

Open `onboarding/index.html` in a browser. Even without a valid session ID, the JS should parse without errors (check browser console).

**Step 3: Run DB tests**

Run: `node --test api/lib/db.test.js`
Expected: All tests pass.

**Step 4: Final commit with all Stream I + J changes**

If there are any uncommitted changes from the above tasks:

```bash
git add -A
git commit -m "chore: final cleanup for Phase 2 Streams I & J"
```

---

## Summary

| Task | File | What |
|------|------|------|
| 1 | `api/lib/db.js` | `deploy_status` column + allowed list |
| 2 | `api/onboarding-server.js` | `tryDeployIfReady()` + Discord alerts + dual trigger |
| 3 | `api/onboarding-server.js` | SSE profile gen endpoint |
| 4 | `api/onboarding-server.js` | Multi-provider auth routes |
| 5 | `api/onboarding-server.js` | Key verification endpoint |
| 6 | `onboarding/index.html` | Theme alignment to homepage |
| 7 | `onboarding/index.html` | Layout stability (absolute slides) |
| 8 | `onboarding/index.html` | localStorage quiz persistence |
| 9 | `onboarding/index.html` | SSE progress UI |
| 10 | `onboarding/index.html` | Multi-provider auth grid |
| 11 | (all) | Integration smoke test |
