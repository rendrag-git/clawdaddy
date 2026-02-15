# Onboarding Personality Quiz & Full Flow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate a personality quiz and 4-step onboarding flow into ClawDaddy's post-checkout page — quiz runs while server provisions, generates personalized AI config files via Claude API.

**Architecture:** Single-page progressive-reveal flow (vanilla HTML/CSS/JS). Frontend steps reveal in place via JS. Backend gets new Express endpoints for quiz storage, profile generation (Claude API), auth stubs, and username validation. Profile generator is a standalone Node module.

**Tech Stack:** Vanilla HTML/CSS/JS (no frameworks), Express.js backend, Anthropic SDK (claude-sonnet-4-20250514), existing CSS variables/dark theme.

---

## Task Map (4 parallelizable tasks)

| Task | File(s) | Depends On | Estimated Size |
|------|---------|------------|----------------|
| 1 | `templates/BOOTSTRAP.md` | Nothing | Tiny (copy from spec) |
| 2 | `api/lib/profile-generator.js` | Nothing | Medium |
| 3 | `api/onboarding-server.js` | Task 2 (import) | Medium-Large |
| 4 | `onboarding/index.html` | API contracts (specified) | Large |

**Parallelization strategy:** Tasks 1, 2, and 4 are fully independent. Task 3 imports from Task 2 but can be written in parallel since the export interface is known: `generateProfile(quizResults, username, botName) → { soulMd, userMd, identityMd }`. All 4 tasks can run concurrently.

---

### Task 1: BOOTSTRAP.md Template

**Files:**
- Create: `templates/BOOTSTRAP.md`

**Step 1:** Write the template file exactly as specified in requirements. This is static content — no logic.

The content is provided verbatim in the spec (the "Welcome to Life" template).

**Step 2: Commit**
```bash
git add templates/BOOTSTRAP.md
git commit -m "feat: add BOOTSTRAP.md template for customer instances"
```

---

### Task 2: Profile Generator Module

**Files:**
- Create: `api/lib/profile-generator.js`

**What it does:**
- Exports `generateProfile(quizResults, username, botName)`
- Calls Claude API (`claude-sonnet-4-20250514`) with a meta-prompt containing quiz results
- Returns `{ soulMd: string, userMd: string, identityMd: string }`
- Falls back to template-based generation if API call fails

**Implementation details:**

1. Read Anthropic API key from env var `ANTHROPIC_API_KEY` or fallback file `/home/ubuntu/clawd/.secrets/anthropic-onboarding-key`

2. Build meta-prompt that includes:
   - Full scoring/dimension context from quiz-design.json (the trait dimensions, scoring logic, template structures)
   - The user's computed dimension scores, tags, free-text responses
   - Username and bot name
   - Instructions to write natural, personalized SOUL.md, USER.md, IDENTITY.md
   - IDENTITY.md must include: bot name, creature/character description fitting personality, vibe line

3. Parse Claude's response to extract three markdown files

4. Fallback: implement template-based generation using the pseudocode from quiz-design.json's `profile_generation_logic` and `templates` sections — compute dials (casualness, humor, proactivity, verbosity, structure, autonomy, disagreement_mode, humor_style) and fill templates

5. Use `@anthropic-ai/sdk` npm package for the API call

**Step 1:** Write `api/lib/profile-generator.js` with:
- `generateProfile(quizResults, username, botName)` async function
- `generateWithClaude(quizResults, username, botName)` internal
- `generateFallback(quizResults, username, botName)` template-based fallback
- `buildMetaPrompt(quizResults, username, botName)` prompt builder

**Step 2: Commit**
```bash
git add api/lib/profile-generator.js
git commit -m "feat: add profile generator module with Claude API + fallback"
```

---

### Task 3: Backend Endpoints

**Files:**
- Modify: `api/onboarding-server.js` (add 6 new endpoints after existing routes)

**New endpoints to add:**

1. **GET `/api/onboarding/check-username/:username`**
   - Validate format: lowercase, alphanumeric + hyphens, 3-20 chars, no leading/trailing hyphens
   - Check uniqueness against existing onboarding records (scan store.sessions for matching displayName slugified)
   - Return `{ available: true/false, suggestion: "..." }` — if taken, suggest `username1`, `username2`, etc.

2. **POST `/api/onboarding/quiz/:sessionId`**
   - Validate sessionId exists in store
   - Accept JSON body: `{ scores, dimensionScores, tags, freeText, answers, perQuestionContext }`
   - Store as `record.quizResults` alongside onboarding record
   - Return `{ ok: true }`

3. **POST `/api/onboarding/generate-profile/:sessionId`**
   - Load quiz results + username + bot name from store
   - Call `generateProfile()` from `api/lib/profile-generator.js`
   - Store generated files in record: `record.generatedFiles = { soulMd, userMd, identityMd }`
   - Return `{ ok: true, files: ['SOUL.md', 'USER.md', 'IDENTITY.md'] }`

4. **POST `/api/onboarding/write-files/:sessionId`**
   - Read generated files from record
   - Read BOOTSTRAP.md template from `templates/BOOTSTRAP.md`
   - Stub: write to local directory `./generated/<username>/` for now
   - Mark `// TODO: SSH to customer instance`
   - Return `{ ok: true, written: [...filenames] }`

5. **GET `/api/onboarding/auth-url/:sessionId`**
   - Stub: return `{ status: "pending" }` until record.status === 'ready'
   - When ready: return `{ status: "ready", url: "https://auth.clawdaddy.sh/oauth/...", provider: "anthropic" }`
   - Mark `// TODO: wire to real OAuth provider URLs`

6. **POST `/api/onboarding/auth-complete/:sessionId`**
   - Stub: set `record.authComplete = true`, update store
   - Return `{ ok: true }`
   - Mark `// TODO: wire to real OAuth callback`

7. **GET `/api/onboarding/ready/:sessionId`**
   - Return `{ status: "pending" }` until: files written + auth done + server ready
   - When all complete: `{ status: "ready", webchatUrl: "<username>.clawdaddy.sh" }`

**Also modify** the existing `POST /api/onboarding` handler:
- After saving the record, also store the username (slugified displayName) for username availability checks
- Add `record.username` field

**Step 1:** Add `require` for profile-generator at top of file
**Step 2:** Add all endpoint handlers
**Step 3: Commit**
```bash
git add api/onboarding-server.js
git commit -m "feat: add quiz, profile generation, auth, and username check endpoints"
```

---

### Task 4: Frontend — Full Onboarding Flow

**Files:**
- Modify: `onboarding/index.html` (major rewrite of the single file)

**What changes:**

The page becomes a 4-step progressive flow. Existing Step 1 form is enhanced. Steps 2-4 are new HTML sections that reveal via JS.

#### Step 1: Your Info (enhance existing)
- Add "Bot name" field (already exists as "assistant name")
- Add username availability checking:
  - Debounce input on display-name field (300ms)
  - GET `/api/onboarding/check-username/:username` on each change
  - Show inline indicator: green checkmark "available" / red X "taken" with suggestion
  - Disable submit button if username is taken
  - Auto-slugify the display name for subdomain preview: show `<username>.clawdaddy.sh` preview below the field
- On submit: POST to existing `/api/onboarding`, then immediately reveal Step 2
- Start background provisioning status polling (existing logic, but now shown as a small chip/indicator rather than full-page)

#### Step 2: Personality Quiz (NEW)
- Small provisioning status chip in top-right corner (shows "Setting up..." with pulse dot, updates via existing polling)
- Quiz engine:
  - Render one question at a time from quiz-design.json data (embedded in JS)
  - Section A questions (A1-A11): single-select radio-style buttons
  - Section B questions: B1-B2 multi-select checkboxes, B3 single-select, B4-B5 short text inputs
  - Progress bar showing question N of total
  - Smooth slide-left/fade transitions between questions (CSS transitions, no libraries)
  - Each question has a collapsed "+ Add context" button that reveals a small textarea
  - "Back" button on each question (except first)
  - Section break screen between Section A and Section B with section title + instructions
- Final screen: free-text textarea "Anything else your assistant should know?" with placeholder examples
- Quiz submit:
  - Calculate trait scores using scoring logic from quiz-design.json
  - POST to `/api/onboarding/quiz/:sessionId`
  - POST to `/api/onboarding/generate-profile/:sessionId`
  - POST to `/api/onboarding/write-files/:sessionId`
  - Reveal Step 3

#### Step 3: Connect Your AI (NEW)
- If server not ready yet: show waiting state "Almost ready, setting up your server..."
- If server ready: show provider picker (Anthropic / OpenAI buttons)
- Clicking provider button: GET `/api/onboarding/auth-url/:sessionId` → opens OAuth URL in new tab
- Poll for auth confirmation: check via polling or POST `/api/onboarding/auth-complete/:sessionId`
- Show checkmark when auth is confirmed
- Reveal Step 4

#### Step 4: You're All Set! (NEW)
- Big animated success state (scale-in animation, gradient glow)
- "Your assistant is ready at:" with prominent link to `<username>.clawdaddy.sh`
- Copy-to-clipboard button for the URL
- "Bookmark this — it's your assistant's home"
- Auto-redirect countdown: "Redirecting in 5...4...3..." → redirects to webchat URL

#### CSS additions (within existing `<style>` block):
- Quiz option buttons: 44px+ min-height for touch targets, hover/selected states matching existing gradient style
- Progress bar: thin gradient bar at top of quiz panel
- Slide transitions: `.quiz-question` with transform/opacity transitions
- Multi-select checkboxes: styled to match dark theme
- Status chip: small fixed-position indicator
- Section break screen styling
- Success animation: keyframe scale + glow
- Copy button styling
- All responsive at 640px breakpoint (existing pattern)

#### JS additions (within existing `<script>` block):
- Quiz data: embed all questions from quiz-design.json as a JS const
- Quiz state machine: currentQuestion index, answers object, navigation
- Scoring engine: implement the pseudocode from quiz-design.json scoring_logic
- Debounced username check function
- Step transition manager: show/hide steps with transitions
- Copy-to-clipboard function
- Countdown timer for redirect

**Step 1:** Rewrite the HTML structure with all 4 steps
**Step 2:** Add all new CSS within existing style block
**Step 3:** Rewrite JS to handle full flow + quiz engine + scoring
**Step 4: Commit**
```bash
git add onboarding/index.html
git commit -m "feat: add personality quiz and full 4-step onboarding flow"
```

---

## Execution Order

All 4 tasks can run in parallel via subagents:
- **Agent A:** Task 1 (BOOTSTRAP.md) — trivial, done in seconds
- **Agent B:** Task 2 (profile-generator.js) — medium complexity
- **Agent C:** Task 3 (backend endpoints) — medium-large, can reference Task 2's export signature
- **Agent D:** Task 4 (frontend) — largest task, uses API contracts from spec

After all agents complete: review integration points, run a final consistency check.
