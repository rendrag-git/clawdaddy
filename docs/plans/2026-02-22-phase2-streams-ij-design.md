# Phase 2 Design: Streams I & J — Integration Wiring

## Context

Phase 1 shipped 8 parallel streams (A-H) building backend modules. Phase 2 wires those modules into the two bottleneck files:

- **Stream I**: `api/onboarding-server.js` — SSE profile gen, multi-provider auth routes, auto-deploy coordination
- **Stream J**: `onboarding/index.html` — theme alignment, layout stability, state persistence, SSE progress UI, provider auth grid

Stream I must complete before Stream J (frontend consumes SSE endpoints and provider routes that I creates).

---

## Stream I: Onboarding Server Wiring

### I-1. SSE Profile Generation Endpoint

**New route**: `GET /api/onboarding/generate-profile/:sessionId/stream`

- Validate `sessionId` via `getOnboardingSession()` — 404 if not found or session not in profile step
- Set SSE headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
- **Reconnect handling**: Before starting generation, check if `session.generated_files` already has `soulMd`. If so, immediately send `{"stage":"complete"}` and close — prevents zombie SSE connections after brief disconnects (EventSource auto-reconnects)
- Call `generateProfile(quizResults, username, botName, { onProgress })` where `onProgress` writes SSE events
- 4 stages: `analyzing` → `generating` → `agents` → `complete`
- SSE event format: `data: {"stage":"analyzing","message":"Analyzing your responses..."}\n\n`
- On completion: store files in DB, call `tryDeployIfReady(sessionId)`, send final event, `res.end()`
- On error: send `{"stage":"error","message":"..."}`, close
- Keep existing synchronous `POST /api/onboarding/generate-profile/:sessionId` as fallback

### I-2. Multi-Provider Auth Routes

| Route | Type | Description |
|---|---|---|
| `GET /api/providers` | New | Returns `getProviderList()` — 6 providers with id, name, supportsOAuth, supportsApiKey |
| `POST /api/onboarding/auth/start` | Update | Accept `provider` param in body (default `'anthropic'`). Pass to `startAuth()`. |
| `POST /api/onboarding/auth/complete` | Update | Accept `provider` param in body. Pass to `completeAuth()`. |
| `POST /api/onboarding/auth/api-key` | New | Accept `{provider, apiKey, stripeSessionId}`. Call `authWithApiKey()`. Validate session + provision_status first. |
| `POST /api/onboarding/auth/verify` | New | Lightweight provider key validation. Makes a minimal API call (list-models or similar) to confirm the key works before marking "Connected". |

All auth routes validate:
1. `stripeSessionId` is valid
2. `customer.provision_status === 'ready'` (can't write auth to an instance that doesn't exist)

### I-3. Auto-Deploy Coordination

**Problem**: Files can only deploy when BOTH profile generation AND provisioning are complete. Either can finish first.

**DB migration**: `ALTER TABLE onboarding_sessions ADD COLUMN deploy_status TEXT DEFAULT 'pending'`

**`tryDeployIfReady(sessionId)`** function:
1. Load customer + session from DB
2. Check both: `customer.provision_status === 'ready'` AND `session.generated_files` exists
3. If either missing → no-op (other completion point will trigger later)
4. **Idempotency**: `UPDATE onboarding_sessions SET deploy_status = 'deploying' WHERE stripe_session_id = ? AND deploy_status = 'pending'` — only proceed if `this.changes === 1`
5. On success → `SET deploy_status = 'deployed'`
6. On failure → `SET deploy_status = 'failed'`, log error, POST to Discord ops webhook:
   - URL: `https://discord.com/api/webhooks/1472970106089898016/hl88EjM5QcO7NpDCtTc17NbYcvyNXFvv3cb0CckcxS8zBj6uV0-KleMQBSGTsbm2-c7V`
   - Message: `Deploy failed for {username} (session {sessionId}): {error.message}`
7. No automated retry — manual retry via existing `POST /api/onboarding/write-files/:sessionId`

**Trigger points**:
1. After profile gen completes (in SSE endpoint, after storing `generated_files`)
2. In status polling endpoint (`GET /api/onboarding/status/:sessionId`): when `provisionStatus === 'ready'`, also fire `tryDeployIfReady()` — frontend already polls this, catches "provision finished after profile gen" without cross-process communication between webhook server and onboarding server

### I-4. Status Endpoint Enrichment

Add `deployStatus` field to `GET /api/onboarding/status/:sessionId` response:
```json
{
  "username": "...",
  "provisionStatus": "ready",
  "deployStatus": "deployed",
  "authStatus": "pending",
  "webchatUrl": "https://..."
}
```

Values: `pending` | `deploying` | `deployed` | `failed`

---

## Stream J: Onboarding Frontend

### J-1. Theme Alignment — Match Homepage

The quiz currently uses a custom dark blue-black theme that looks like a separate app. Must match the homepage (`index.html` at root).

**Homepage design tokens** (copy verbatim from homepage's inline `tailwind.config`):
- Background: `#090b10` with `radial-gradient(circle at 10% 0%, rgba(230,57,70,0.2), transparent 34%), radial-gradient(circle at 90% 20%, rgba(230,57,70,0.12), transparent 30%)`
- Accent: lobster `#E63946`
- Shadow: `glow: "0 0 0 1px rgba(230,57,70,0.25), 0 12px 34px rgba(230,57,70,0.2)"`
- Text: zinc-100 (primary), zinc-300 (secondary), zinc-400 (muted)
- Cards: `bg-zinc-900/75` with `border border-zinc-800` and `rounded-2xl`
- Buttons: `bg-lobster rounded-xl font-bold shadow-glow` with `hover:bg-red-500`
- Font: Tailwind defaults (remove Inter import)

**Changes**:
- Add Tailwind CDN `<script>` with exact same config as homepage
- Replace all custom CSS variables (`--bg`, `--accent`, `--accent-2`, etc.) with Tailwind classes
- Restyle quiz panels to use `bg-zinc-900/75 border-zinc-800 rounded-2xl`
- Restyle buttons to use lobster red
- Restyle progress bar gradient from purple/cyan → lobster red gradient
- Remove orphaned Tailwind-like classes on welcome screen that don't resolve

### J-2. Layout Stability

**Slide transition fix**: Use `position: absolute` within `position: relative` container with fixed `min-height`. Outgoing and incoming slides overlap during transition without container resizing. Without this, `transform: translateX()` on slides in normal flow causes container height to snap between slides of different heights.

**Specific fixes**:
- Quiz viewport container: `position: relative; min-height: 420px; overflow: hidden`
- Each question slide: `position: absolute; inset: 0; width: 100%` — transitions via `transform: translateX()` + `opacity`
- Progress bar + question counter: fixed position at top of quiz area, never moves
- Option buttons: fixed height cells, no reflow when selected/deselected
- Test all 17 screens for zero layout jumps

### J-3. Quiz State Persistence (localStorage)

**Save**: On every answer change, write to localStorage:
```
Key: clawdaddy_quiz_{sessionId}
Value: JSON.stringify({
  currentQuestion,
  answers,
  traits,
  dimensionScores,
  freeText,
  savedAt: Date.now()
})
```

**Restore on page load**:
1. Read `sessionId` from URL params
2. Check `GET /api/onboarding/status/:sessionId` for server-side step
3. If server says step is past `quiz` (e.g., `auth` or `complete`) → skip localStorage restore, show current step. This handles the multi-tab edge case where quiz was completed in another tab.
4. If server says step is `quiz` → check localStorage for matching session
5. If found and `savedAt` is within 24 hours → restore state, jump to saved question
6. If stale (>24h) → discard, start fresh

**Clear**: On successful quiz submission (server responds 200).

**Security note**: localStorage key contains Stripe session ID (`cs_test_...`). Low risk on personal devices but noted.

### J-4. SSE Progress UI for Profile Generation

Replace static "Generating your profile..." text.

**Implementation**:
1. Connect via `new EventSource('/api/onboarding/generate-profile/{sessionId}/stream')`
2. Parse `data` events, update UI based on `stage`:
   - `analyzing`: "Analyzing your responses..." + step 1/4 indicator
   - `generating`: "Building personality profile..." + step 2/4 + pulsing animation
   - `agents`: "Creating agent configuration..." + step 3/4
   - `complete`: "Profile generation complete!" + step 4/4 → transition to auth step
   - `error`: Show error message + "Try Again" button
3. Stepped progress indicator (4 discrete dots/segments, not a percentage bar)
4. Pulsing/breathing animation on the current stage (smooth, lobster-red glow)
5. **EventSource reconnect**: The browser auto-reconnects on disconnect. Server-side handles this by checking for existing `generated_files` and sending `complete` immediately (see I-1).
6. **Fallback**: If `EventSource` constructor throws or first event doesn't arrive within 5s, fall back to synchronous `POST` with static spinner

### J-5. Multi-Provider Auth Grid

Replace single "Connect Claude (Anthropic)" button.

**Flow**:
1. Fetch `GET /api/providers` → render 6 provider cards in 2-column grid (3 rows on mobile, 3x2 on desktop)
2. Each card: colored initial circle + provider name + status badge (disconnected/verifying/connected)
3. **Provider brand colors** (for initial circles):
   - Anthropic: `#D4A373` (coral/sand)
   - OpenAI: `#10A37F` (green)
   - OpenRouter: `#6366F1` (indigo)
   - Google: `#4285F4` (blue)
   - xAI: `#FFFFFF` on dark (white)
   - Groq: `#F55036` (orange-red)
4. Click card → expand detail panel below:
   - If `supportsOAuth` AND `supportsApiKey`: OAuth button + "or" divider + API key input
   - If `supportsApiKey` only: API key input with "Save Key" button
5. **Key verification**: After saving API key, hit `POST /api/onboarding/auth/verify`. Show 2s "Verifying..." spinner. On success → green "Connected" badge. On failure → inline error "Invalid key — check and try again".
6. **OAuth flow** (Anthropic only): Same CODE#STATE paste UI as current, but within the expanded card panel
7. Connected providers show green check badge on card
8. "Continue" button at bottom — enabled when >= 1 provider connected
9. Multiple providers can be connected before continuing

**Styling**: zinc-900 card bg, zinc-800 borders, lobster-red accents for connected state.

---

## DB Changes

```sql
-- Migration (safe to run repeatedly)
ALTER TABLE onboarding_sessions ADD COLUMN deploy_status TEXT DEFAULT 'pending';
```

## Files Modified

| File | Stream | Changes |
|---|---|---|
| `api/onboarding-server.js` | I | SSE endpoint, provider routes, API key route, verify route, `tryDeployIfReady()`, status enrichment, deploy_status migration |
| `api/lib/db.js` | I | `deploy_status` in `updateOnboardingSession` allowed fields |
| `onboarding/index.html` | J | Theme overhaul, layout fix, localStorage persistence, SSE progress UI, provider auth grid |

## Verification

1. SSE endpoint: start profile gen → observe 4 stage events → verify files stored + deploy triggered
2. Reconnect: disconnect SSE mid-generation → reconnect → get `complete` event (not re-run)
3. Multi-provider: connect Anthropic via OAuth → connect OpenAI via API key → both show "Connected"
4. Key verification: enter bad API key → "Invalid key" error. Enter valid key → "Connected".
5. Auto-deploy: start quiz (provision in progress) → complete quiz + profile gen → provision completes → files auto-deploy → `deployStatus: 'deployed'` in status response
6. Auto-deploy idempotency: both triggers fire near-simultaneously → only one deploy runs
7. Deploy failure: simulate SCP failure → `deployStatus: 'failed'` + Discord webhook fires
8. localStorage: answer 5 questions → refresh page → resume at question 6. Complete in tab A → open tab B → shows auth step (not quiz).
9. Theme: quiz visually matches homepage (same colors, fonts, card styles)
10. Layout: step through all 17 quiz screens → no content jumps
