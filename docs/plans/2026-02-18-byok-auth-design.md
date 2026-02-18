# BYOK Auth + Onboarding Pipeline Redesign — Design

**Date:** 2026-02-18
**Branch:** `feat/byok-auth`
**Status:** Approved

## Problem

Customers pay, get provisioned, but can't connect their API key. The OAuth auth flows are documented and tested (`docs/auth-flow-anthropic.md`, `docs/auth-flow-openai.md`) but not wired into the onboarding pipeline. Additionally, the current architecture has a double-provisioning risk (webhook server vs onboarding server) and uses a JSON file store with race conditions.

## Scope

Three workstreams, designed and shipped together:

1. **Webhook server owns all provisioning** — remove the onboarding guard, read Stripe custom fields for username/botName
2. **Onboarding server simplification** — drop Step 1 (username/botName collected at Stripe Checkout), replace JSON store with SQLite
3. **BYOK auth flow** — wire real SSH-based OAuth into Step 3 of the onboarding UI

## Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Data store | SQLite (`better-sqlite3`) | Eliminates JSON race condition between two servers. WAL mode handles concurrent access. Pattern already used in `script/api-proxy/lib/usage-db.js`. |
| SSH auth process | `child_process.spawn` + `ssh -tt` | Matches existing provisioner pattern. No new native deps beyond better-sqlite3. |
| Auth process state | In-memory Map with 5-min TTL | Simplest approach. If server restarts, customers retry. |
| Token injection | Non-interactive SSH write to auth-profiles.json | Avoids a second PTY session. One interactive SSH to get the token, one `ssh exec` to write the file. |
| Onboarding data | Separate `onboarding_sessions` table | Keeps `customers` table clean for long-lived infra/billing use. Quiz/profile data is transient. |

## Data Layer

### Shared SQLite Database

**File:** `data/clawdaddy.db` — both servers open the same file.
**Module:** `api/lib/db.js` — shared access layer with prepared statement wrappers.

```sql
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL,
  bot_name TEXT,
  tier TEXT DEFAULT 'byok',
  stripe_customer_id TEXT,
  stripe_session_id TEXT,
  server_ip TEXT,
  ssh_key_path TEXT,
  dns_hostname TEXT,
  provision_status TEXT DEFAULT 'pending',
  provision_stage TEXT,
  auth_status TEXT DEFAULT 'pending',
  auth_provider TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE onboarding_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_session_id TEXT UNIQUE NOT NULL,
  customer_id TEXT REFERENCES customers(id),
  quiz_results TEXT,        -- JSON blob
  generated_files TEXT,     -- JSON blob (soulMd, userMd, etc.)
  gateway_token TEXT,
  portal_password TEXT,
  step TEXT DEFAULT 'quiz', -- quiz/profile/auth/complete
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

**Access pattern:**
- `db.js` exports: `initDb()`, `createCustomer()`, `getByUsername()`, `getByStripeSessionId()`, `updateProvision()`, `updateAuth()`, `createOnboardingSession()`, `getOnboardingSession()`, `updateOnboardingSession()`
- WAL journal mode for concurrent reads
- Webhook server writes provisioning results to `customers`
- Onboarding server reads `customers` by `stripe_session_id`, writes quiz/profile/auth to `onboarding_sessions`

**Migration:** On `initDb()`, if `customers.json` exists, iterate records and insert into SQLite, then rename to `.json.migrated`.

## Webhook Server Changes

**Files:** `script/webhook-server/lib/stripe-handlers.js`, `script/webhook-server/server.js`, `script/webhook-server/package.json`

1. Remove the `metadata.onboarding === 'true'` guard in `handle_checkout_completed()` — all checkouts now provision
2. Read `session.custom_fields` for `username` and `bot_name`
3. On checkout: `INSERT INTO customers` + `INSERT INTO onboarding_sessions` (with `stripe_session_id` as correlation key)
4. On provision complete: `UPDATE customers SET provision_status = 'ready', server_ip = ?, ssh_key_path = ?, dns_hostname = ?`
5. Add `better-sqlite3` to deps, call `initDb()` on startup

**Unchanged:** provisioner.js, email templates, subscription/payment handlers.

## Onboarding Server Changes

**File:** `api/onboarding-server.js`

### Removed
- `loadStore()` / `saveStore()` / `updateSession()` — replaced by SQL queries
- `spawnProvision()` call in `POST /api/onboarding` — webhook owns provisioning
- Step 1 form validation for username/botName (collected at Stripe Checkout)

### Rewritten endpoints
- `POST /api/onboarding` — lightweight init. Validates Stripe session, looks up customer by `stripe_session_id` in SQLite, returns current state (username, botName, provisionStatus)
- `GET /api/onboarding/status/:sessionId` — reads `provision_status` from `customers` table
- `POST /api/onboarding/quiz/:sessionId` — writes quiz JSON blob to `onboarding_sessions`
- `POST /api/onboarding/generate-profile/:sessionId` — writes generated files to `onboarding_sessions`
- `deployFilesToInstance()` — reads `server_ip` / `ssh_key_path` from `customers` table; checks `provision_status = 'ready'` before attempting SCP

### New auth endpoints (replace stubs)
- `POST /api/onboarding/auth/start` — `{ stripeSessionId, provider }` → starts SSH, returns `{ oauthUrl, authSessionId }`
- `POST /api/onboarding/auth/complete` — `{ authSessionId, code }` → feeds code to SSH, returns `{ ok, provider, profileName }`

## SSH Auth Module

**New file:** `api/lib/ssh-auth.js`

### Exports
```
startAuth(provider, serverIp, sshKeyPath) → { authSessionId, oauthUrl }
completeAuth(authSessionId, code) → { ok, provider, profileName }
cleanupExpired() — called on 30s interval
```

### In-memory state
```js
const sessions = new Map();
// authSessionId → { proc, provider, serverIp, stdout, createdAt, timeoutHandle }
```

5-minute TTL. `setInterval(cleanupExpired, 30_000)` kills stale processes.

### Stdout parsing
Buffer chunks, only match patterns against complete lines (split on `\n`, hold trailing partial). SSH over PTY can split output mid-line.

### Stdin timing
500ms delay after detecting "ready for input" prompt before writing to stdin. PTY CLIs sometimes need a beat.

### Anthropic flow

**startAuth('anthropic', ip, keyPath):**
1. `spawn('ssh', ['-tt', '-i', keyPath, '-o', 'StrictHostKeyChecking=no', 'ubuntu@' + ip, 'claude setup-token'])`
2. Buffer stdout line-by-line
3. Wait for line containing `https://claude.ai/oauth/authorize` (15s timeout)
4. Return `{ authSessionId, oauthUrl }`

**completeAuth(authSessionId, codeWithState):**
1. Wait 500ms after "Paste code here" prompt detected
2. Write `CODE#STATE\n` to stdin
3. Scan for `sk-ant-oat01-*` token in stdout (15s timeout)
4. Kill the interactive process
5. Non-interactive SSH: write `auth-profiles.json` to known path on instance
6. Return `{ ok: true, provider: 'anthropic', profileName: 'anthropic:manual' }`

### OpenAI flow

**startAuth('openai', ip, keyPath):**
1. `spawn('ssh', ['-tt', '-i', keyPath, '-o', 'StrictHostKeyChecking=no', 'ubuntu@' + ip, 'openclaw onboard --auth-choice openai-codex'])`
2. Buffer stdout line-by-line
3. Verify security disclaimer prompt → send Enter
4. Verify onboarding mode prompt → send arrow + Enter for QuickStart
5. Verify config handling prompt → send Enter for Update values
6. **If any step gets unexpected output → abort with descriptive error** (wizard menu ordering may change with OpenClaw updates)
7. Wait for line containing `https://auth.openai.com/oauth/authorize` (20s timeout)
8. Return `{ authSessionId, oauthUrl }`

**completeAuth(authSessionId, redirectUrl):**
1. Wait 500ms after "Paste the redirect URL" prompt detected
2. Write full redirect URL + `\n` to stdin
3. Scan for token data / "Model configured" in stdout (15s timeout)
4. Send Escape, kill process
5. Non-interactive SSH: write `auth-profiles.json` with captured tokens
6. Return `{ ok: true, provider: 'openai', profileName: 'openai-codex:*' }`

## Frontend Changes

**File:** `onboarding/index.html`

### Step 1 — Removed
Username and botName are collected at Stripe Checkout via custom fields. On page load, call `GET /api/onboarding/status/:sessionId` to get `{ username, botName, provisionStatus }`. Jump straight to Step 2 (quiz) after the welcome screen.

### Step 2 — Quiz (mostly unchanged)
Provisioning chip still polls status. Reads from `provisionStatus` field.

### Step 3 — Auth (rewritten)
Appears after quiz + profile generation. Flow:

1. Check `provisionStatus === 'ready'` before enabling provider buttons. If not ready, show "Waiting for your server to finish setting up..." with polling indicator.
2. Customer picks provider → `POST /auth/start` → backend returns `{ oauthUrl, authSessionId }`
3. Page shows **all three elements at once, in order:**
   - **Instructions** (provider-specific, visible before they click):
     - Anthropic: "Click the link below to sign in with Anthropic. After authorizing, you'll see a code that looks like `ABC123#xyz789`. Copy the **full code including the # part** and paste it below."
     - OpenAI: "Click the link below to sign in with OpenAI. After authorizing, your browser will try to load a page that won't work — that's expected. Copy the **full URL from your address bar** and paste it below."
   - **The OAuth link** (clickable, `target="_blank"`)
   - **Paste input + submit button** (already visible, ready for when they return)
4. On submit: `POST /auth/complete { authSessionId, code }` → `{ ok, provider, profileName }`
5. On success → transition to Step 4
6. On error → show error with retry option

### Step 4 — Success
Shows `username.clawdaddy.sh` URL, generated portal password, copy button, redirect countdown.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| SSH connection fails | `/auth/start` returns 502 with "Could not connect to your instance" |
| OAuth URL not found within timeout | `/auth/start` returns 504 with "Auth process timed out" |
| Invalid code/URL pasted | `/auth/complete` returns 400 with provider-specific error from stdout |
| Customer abandons (5-min TTL) | SSH process killed, Map entry cleaned up |
| Server restarts during auth | In-flight sessions lost; customer retries from Step 3 |
| Provisioning not ready when auth attempted | Frontend blocks; backend returns 409 if called anyway |
| OpenAI wizard shows unexpected prompt | Process killed, returns 500 with "Unexpected wizard state" |

## Files Changed

| File | Action |
|------|--------|
| `api/lib/db.js` | New — shared SQLite access layer |
| `api/lib/ssh-auth.js` | New — SSH auth process management |
| `api/onboarding-server.js` | Rewrite — drop JSON store, drop provisioning, wire auth endpoints |
| `api/package.json` | Add `better-sqlite3` dep |
| `onboarding/index.html` | Rewrite — drop Step 1, rewrite Step 3, update Step 4 |
| `script/webhook-server/lib/stripe-handlers.js` | Modify — remove onboarding guard, write to SQLite |
| `script/webhook-server/server.js` | Modify — init DB on startup |
| `script/webhook-server/package.json` | Add `better-sqlite3` dep |
