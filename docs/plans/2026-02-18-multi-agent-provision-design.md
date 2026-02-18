# Multi-Agent Provisioning Pipeline Design

> **Goal:** Make sub-agents work end-to-end — Opus-quality generation, proper file layout, OpenClaw registration, auth propagation.
> **Branch:** `feat/multi-agent-provision`
> **Date:** 2026-02-18

---

## Problem

1. Sub-agent SOUL.md files are template-based (low quality vs Opus-generated main agent)
2. No AGENTS.md (behavioral instructions) exists for any agent
3. No per-sub-agent HEARTBEAT.md
4. Sub-agents don't have USER.md
5. Entrypoint doesn't discover or register sub-agents with OpenClaw
6. Sub-agents have no auth-profiles.json — can't make API calls

## Directory Structure (on instance)

```
/home/ubuntu/clawd/                   # host path (bind-mounted to /home/clawd/clawd/)
  SOUL.md                             # main agent personality (Opus)
  USER.md                             # user profile (Opus)
  IDENTITY.md                         # archetype (Opus)
  HEARTBEAT.md                        # main recurring checks (Opus)
  BOOTSTRAP.md                        # first-contact message (Opus)
  AGENTS.md                           # NEW: main behavioral instructions (Opus)
  MULTI-AGENT.md                      # team overview
  agents/
    scout/
      SOUL.md                         # NEW: Opus-generated (was template)
      AGENTS.md                       # NEW: Opus-generated behavioral rules
      HEARTBEAT.md                    # NEW: templated from role tags
      USER.md                         # NEW: copy of main's USER.md
    dispatch/
      SOUL.md
      AGENTS.md
      HEARTBEAT.md
      USER.md
    abacus/
      ...same...
```

Main agent files stay at workspace root. Only sub-agents live under `agents/<name>/`.

## OpenClaw Config (`openclaw.json`)

`agents.list` is merged alongside existing `agents.defaults`:

```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "anthropic/claude-sonnet-4-20250514" },
      "workspace": "/home/clawd/clawd",
      "userTimezone": "America/New_York"
    },
    "list": [
      { "id": "main", "default": true, "workspace": "/home/clawd/clawd", "model": { "primary": "anthropic/claude-sonnet-4-20250514" } },
      { "id": "scout", "workspace": "/home/clawd/clawd/agents/scout", "model": { "primary": "anthropic/claude-sonnet-4-20250514" } }
    ]
  }
}
```

## Component Changes

### 1. Profile Generator (`api/lib/profile-generator.js`)

**Main agent AGENTS.md:**
- Add `---AGENTS.MD---` marker to the existing Opus prompt
- AGENTS.md = operational behavioral instructions ("how to act" vs SOUL.md "who you are")
- Bump max_tokens from 8000 to 10000 to accommodate the extra file

**Sub-agent SOUL.md upgrade:**
- Replace template-based `generateSubAgents()` with per-agent Opus API calls
- Each call receives: main SOUL.md + USER.md as context, agent role/focus from AGENT_MAP
- Each call produces both SOUL.md and AGENTS.md (two files per call, separated by markers)
- All sub-agent calls run in parallel via `Promise.all`
- Timeout per call: 120s (up from 60s)

**Sub-agent HEARTBEAT.md:**
- Templated (not Opus) — filter existing heartbeat tag mappings to only the sub-agent's domain tags
- Same frequency logic as main agent

**Sub-agent USER.md:**
- Copy of main's USER.md (handled at SCP deployment time)

**Return structure:**
```javascript
{
  soulMd, userMd, identityMd, heartbeatMd, bootstrapMd, agentsMd,  // main
  agents: [{ name, soulMd, agentsMd, heartbeatMd }],                // sub-agents
  multiAgentMd
}
```

### 2. Docker Entrypoint (`docker/entrypoint.sh`)

New section after writing main's auth-profiles.json:

1. Scan `${WORKSPACE}/agents/*/` directories (skip anything that's not a directory)
2. Build `agents.list` JSON array:
   - Always include main: `{ "id": "main", "default": true, "workspace": "${WORKSPACE}", "model": { "primary": "${MODEL}" } }`
   - For each discovered `agents/<name>/` dir: `{ "id": "<name>", "workspace": "${WORKSPACE}/agents/<name>", "model": { "primary": "${MODEL}" } }`
3. Inject `agents.list` into openclaw.json alongside `agents.defaults`
4. For each sub-agent:
   - Create `${CONFIG_DIR}/agents/<name>/agent/` directory
   - Copy main's `auth-profiles.json` into it
   - Create `${CONFIG_DIR}/agents/<name>/sessions/sessions.json`
5. Set `skipBootstrap: true` in agents config so OpenClaw doesn't overwrite SCP'd files
6. Agent name validation: only `[a-zA-Z0-9-]` directory names accepted

### 3. SCP Deployment (`api/onboarding-server.js` — `deployFilesToInstance()`)

**Main agent files** (unchanged paths):
- SCP to `/home/ubuntu/clawd/SOUL.md`, `USER.md`, `IDENTITY.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`
- NEW: also SCP `AGENTS.md` to `/home/ubuntu/clawd/AGENTS.md`

**Sub-agent files:**
- `mkdir -p` each `/home/ubuntu/clawd/agents/<name>/`
- SCP `SOUL.md`, `AGENTS.md`, `HEARTBEAT.md` to each agent dir
- Copy main's `USER.md` into each agent dir

**MULTI-AGENT.md:** stays at `/home/ubuntu/clawd/MULTI-AGENT.md`

## Cost & Timing

| Component | Calls | Wall time | Cost |
|-----------|-------|-----------|------|
| Main profile (5 files + AGENTS.md) | 1 Opus | ~2 min | ~$0.50 |
| Sub-agents (SOUL.md + AGENTS.md each) | up to 3 Opus (parallel) | ~2 min | ~$1.50 |
| **Total** | **up to 4** | **~4 min** | **~$2.00** |

## What Stays the Same

- Sub-agent cap at 3 (existing AGENT_MAP + work-first priority logic)
- Fallback template generation (no sub-agents in fallback mode — too expensive without API)
- MULTI-AGENT.md format
- Gateway token, device identity, VNC setup
- DNS callback system
- Main agent file paths (workspace root)

## Constraints

- Sub-agent names discovered from directories, never hardcoded
- Container paths: workspace `/home/clawd/clawd/`, config `/home/clawd/.openclaw/`
- Host paths: workspace `/home/ubuntu/clawd/`
- Agent name validation: `[a-zA-Z0-9-]` only (already enforced in profile-generator.js)
