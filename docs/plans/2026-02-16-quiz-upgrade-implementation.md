# Quiz Upgrade Implementation Plan
> **Goal:** Upgrade the onboarding quiz to v1.1 (9 dimensions), generate richer profile files (HEARTBEAT.md, BOOTSTRAP.md), and add multi-agent team generation from use-case selections.
> **Reference files:**
> - v1.1 quiz design: `/home/ubuntu/clawd/inbox/quiz-design-3.json` (or latest in inbox)
> - Sample output: `/home/ubuntu/clawd/clawdaddy/docs/sample-profiles/alex-chen/`
> - Current quiz frontend: `/home/ubuntu/clawd/clawdaddy/onboarding/index.html`
> - Current profile generator: `/home/ubuntu/clawd/clawdaddy/api/lib/profile-generator.js`
> - Current CLI wrapper: `/home/ubuntu/clawd/clawdaddy/script/generate-profile.js`
> - Personality research: `/home/ubuntu/clawd/agents/pm/research/personality-quiz-framework.md`
> - Brand voice guide: `/home/ubuntu/clawd/clawdaddy/docs/brand-voice-guide.md`

---

## Task 1: Update Frontend Quiz Questions + Scoring

**Files:**
- Modify: `onboarding/index.html`

**Changes:**

### Step 1: Add new trait poles to `calculateScores()`
The `traits` object (~line 1619) currently has 12 poles. Add 6 new ones:
```js
supportive: 0, challenging: 0, practical: 0, exploratory: 0, analytical: 0, empathetic: 0
```

### Step 2: Add new dimensions to normalization
After the existing 6 dimensions in the scoring logic, add:
```js
supportive_vs_challenging: ['supportive', 'challenging'],
practical_vs_exploratory: ['practical', 'exploratory'],
analytical_vs_empathetic: ['analytical', 'empathetic']
```

### Step 3: Replace/update quiz questions
The quiz questions are hardcoded in the HTML. Update them to match the v1.1 JSON:
- **Keep:** A1, A2, A3, A4, A5, A8, A10, A11 (with updated trait_weights that include new poles)
- **Update:** A6 (add supportive/challenging weights — already partially there in v1.1)
- **Replace A7** (old: cooking dinner) → new: "You bring the assistant a half-baked idea" (measures challenging + exploratory)
- **Replace A9** (old: starting something new) → new: "You're stuck and slightly annoyed" (measures analytical + empathetic)
- **Add A12** (new): "Big decision time" (measures analytical + challenging + exploratory)
- **Keep B1-B5 unchanged**

### Step 4: Update trait_weights on all existing questions
Every question option needs updated weights that include the new 6 poles where relevant. Use the v1.1 JSON as the source of truth for all weights.

### Step 5: Update the style summary generator
Add handling for the 3 new dimensions in the summary output shown to the user after quiz completion.

**Commit:** `feat(onboarding): upgrade quiz to v1.1 — 9 dimensions, 12 personality questions`

---

## Task 2: Update Profile Generator — Claude API Prompt

**Files:**
- Modify: `api/lib/profile-generator.js`

### Step 1: Add new dimensions to the Claude prompt
In `generateWithClaude()`, the `dimensionDescriptions` array (~line 85) has 6 dimensions. Add 3 more:
```js
`supportive_vs_challenging: ${(scores.supportive_vs_challenging || 0.5).toFixed(2)} (0=challenging, 1=supportive)`,
`practical_vs_exploratory: ${(scores.practical_vs_exploratory || 0.5).toFixed(2)} (0=exploratory, 1=practical)`,
`analytical_vs_empathetic: ${(scores.analytical_vs_empathetic || 0.5).toFixed(2)} (0=empathetic, 1=analytical)`
```

### Step 2: Update the prompt to request 5 files instead of 3
Change the prompt to generate:
- SOUL.md (with all 9 dimensions, behavioral rules for challenge/creativity/emotional register)
- USER.md (with challenge preference, creativity preference, emotional register preference)
- IDENTITY.md (with archetype name based on full dimension profile)
- HEARTBEAT.md (populated from use-case tags — personal:email → check inbox, personal:calendar → upcoming events, etc.)
- BOOTSTRAP.md (personalized first-contact message referencing quiz results)

Update the output format markers:
```
---SOUL.MD---
---USER.MD---
---IDENTITY.MD---
---HEARTBEAT.MD---
---BOOTSTRAP.MD---
```

### Step 3: Add HEARTBEAT.md and BOOTSTRAP.md context to the prompt
Include guidance about what makes a good HEARTBEAT.md:
- Map personal:calendar → check calendar events in next 24-48h
- Map personal:health → vitamin/medication reminders (if mentioned)
- Map work:email → check inbox for urgent messages
- Map work:project_management → check task status, upcoming deadlines
- Tune frequency based on usage answer (high → every 30 min, medium → 3x/day, low → 1x/day)

Include guidance about BOOTSTRAP.md:
- First message from the agent
- Reference quiz results directly ("I see you prefer concise responses and want me to push back...")
- Set expectations for the relationship
- Use the brand voice guide tone

### Step 4: Update the response parser
Add parsing for the two new markers (HEARTBEAT.MD and BOOTSTRAP.MD).

### Step 5: Update the return signature
Return `{ soulMd, userMd, identityMd, heartbeatMd, bootstrapMd }` from both `generateWithClaude()` and `generateFallback()`.

**Commit:** `feat(profile): upgrade generator to 9 dimensions + HEARTBEAT.md + BOOTSTRAP.md`

---

## Task 3: Update Profile Generator — Fallback Template

**Files:**
- Modify: `api/lib/profile-generator.js`

### Step 1: Add new dials to `generateFallback()`
After existing dials, add:
```js
const supportiveStrength = clamp(scores.supportive_vs_challenging || 0.5, 0, 1);
const challenge = clamp(1 - supportiveStrength, 0, 1);
const practicalStrength = clamp(scores.practical_vs_exploratory || 0.5, 0, 1);
const creativity = clamp(1 - practicalStrength, 0, 1);
const analyticalStrength = clamp(scores.analytical_vs_empathetic || 0.5, 0, 1);
const emotionalAttunement = clamp(1 - analyticalStrength, 0, 1);
```

### Step 2: Add new behavioral sections to SOUL.md template
- Challenge level section (from disagreement_mode — update to include devils_advocate and cheerleader modes)
- Creativity mode section
- Emotional register section

Use the sample `docs/sample-profiles/alex-chen/SOUL.md` as the target format.

### Step 3: Add HEARTBEAT.md generation
Map use-case tags to heartbeat checks:
```js
const heartbeatChecks = [];
if (tags.includes('work:email')) heartbeatChecks.push('- Check inbox for urgent/unread messages');
if (tags.includes('personal:calendar') || tags.includes('work:meetings')) heartbeatChecks.push('- Review calendar for next 24-48h');
// ... etc for each tag
```

### Step 4: Add BOOTSTRAP.md generation
Template a personalized welcome message incorporating the style summary.

**Commit:** `feat(profile): add fallback templates for 9 dimensions + new files`

---

## Task 4: Update File Writing + SCP Pipeline

**Files:**
- Modify: `script/generate-profile.js` (CLI wrapper)
- Modify: `api/onboarding-server.js` (write-files endpoint)
- Modify: `script/provision.sh` (SCP push section)

### Step 1: Update CLI wrapper to write 5 files
`generate-profile.js` currently writes SOUL.md, USER.md, IDENTITY.md, BOOTSTRAP.md (from template). Update to write HEARTBEAT.md and use the generated BOOTSTRAP.md instead of the template.

### Step 2: Update the write-files API endpoint
The `/api/onboarding/write-files/:sessionId` endpoint needs to SCP all 5 files to the instance.

### Step 3: Update provision.sh SCP section
Ensure the SCP push handles the new files. Check that the Docker volume mount includes paths where HEARTBEAT.md would be read by the agent.

**Commit:** `feat(provision): write and push all 5 profile files to instance`

---

## Task 5: Multi-Agent Team Generation

**Files:**
- Modify: `api/lib/profile-generator.js`
- Modify: `script/generate-profile.js`
- Modify: `api/onboarding-server.js`
- Modify: `script/provision.sh`

### Step 1: Define agent mapping from use-case tags
```js
const AGENT_MAP = {
  'work:email': { name: 'Dispatch', emoji: '📋', focus: 'email triage, drafting, inbox management' },
  'work:research': { name: 'Scout', emoji: '🔍', focus: 'research, summaries, competitive analysis' },
  'work:data_analysis': { name: 'Abacus', emoji: '📊', focus: 'data analysis, spreadsheets, SQL, charts' },
  'work:writing': { name: 'Scribe', emoji: '✍️', focus: 'writing, docs, proposals, briefs' },
  'work:project_management': { name: 'Taskmaster', emoji: '🎯', focus: 'project management, tasks, standups' },
  'work:coding': { name: 'Forge', emoji: '⚒️', focus: 'coding, debugging, code review' },
  // ... personal agents too
};
```

### Step 2: Generate sub-agent SOUL.md files
For each selected use-case tag that maps to an agent:
- Generate a focused SOUL.md with the domain expertise
- Inherit personality dimensions from the main agent (tone, humor, challenge level)
- Add domain-specific behavioral rules

### Step 3: Create agent directory structure
Output structure:
```
agents/
  main/          → SOUL.md, USER.md, IDENTITY.md, HEARTBEAT.md, BOOTSTRAP.md
  dispatch/      → SOUL.md (email-focused)
  scout/         → SOUL.md (research-focused)
  abacus/        → SOUL.md (data-focused)
```

### Step 4: Update SCP to push agent directories
Provision.sh needs to SCP the entire `agents/` directory tree, not just flat files.

### Step 5: Cap at 3 sub-agents
Even if user selects 8 use-cases, only generate the top 3 most impactful sub-agents. Main agent handles everything else.

**Commit:** `feat(profile): generate multi-agent team from use-case selections`

---

## Task 6: Integration Testing

### Test 1: Quiz flow
- Load onboarding page, verify all 12 + 5 questions render
- Complete quiz, verify 9-dimension scores calculate correctly
- Verify new questions (A7, A9, A12) have correct trait weights

### Test 2: Profile generation
- Run `node generate-profile.js sample-quiz.json testuser TestBot ./test-output/`
- Verify 5 files generated: SOUL.md, USER.md, IDENTITY.md, HEARTBEAT.md, BOOTSTRAP.md
- Verify HEARTBEAT.md is populated based on use-case tags
- Verify SOUL.md includes all 9 dimension dials

### Test 3: Multi-agent generation
- Run with use-case tags for email + research + data
- Verify `agents/` directory structure with 3 sub-agent folders
- Verify sub-agent SOUL.md files inherit personality but focus on domain

### Test 4: E2E provision test
- Provision a test instance
- Verify all files SCP'd correctly
- Verify Docker volume mounts include agent directories
- Verify agent boots and reads the generated config

---

## Sequencing
| # | Task | Depends On | Est. Complexity |
|---|------|-----------|-----------------|
| 1 | Frontend quiz upgrade | None | Medium |
| 2 | Profile generator — Claude prompt | None | Medium |
| 3 | Profile generator — fallback template | None | Medium |
| 4 | File writing + SCP pipeline | Tasks 2-3 | Small |
| 5 | Multi-agent team generation | Tasks 2-3 | Large |
| 6 | Integration testing | All above | Medium |

Tasks 1, 2, 3 can run in parallel. Task 4 depends on 2-3. Task 5 depends on 2-3. Task 6 is last.

---

*Created 2026-02-16. Reference sample output: `docs/sample-profiles/alex-chen/`*
