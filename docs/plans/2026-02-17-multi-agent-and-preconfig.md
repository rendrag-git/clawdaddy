# Multi-Agent Setup & Instance Preconfig — Issues and Next Steps

> 2026-02-17 — Working notes from pgardner deployment testing

## Context

After deploying the portal to pgardner.clawdaddy.sh and getting the dashboard working under the `/portal/*` prefix, we hit two issues:

1. **EACCES on TOOLS.md** — OpenClaw couldn't write to its workspace because `provision.sh` was setting ownership to uid 1000 (node) instead of 1001 (clawd). Fixed.
2. **Multi-agent setup is incomplete** — The onboarding pipeline generates sub-agent files but doesn't register them with OpenClaw's agent system.

## How OpenClaw Multi-Agent Actually Works

Based on inspecting a working personal setup and OpenClaw docs:

### Per-agent requirements:
| Component | Location | Purpose |
|-----------|----------|---------|
| Config entry | `openclaw.json` → `agents.list[]` | Registers agent with model, workspace path |
| Workspace | `~/clawd/agents/<name>/` | AGENTS.md, SOUL.md, MEMORY.md, etc. |
| Agent state | `~/.openclaw/agents/<name>/agent/` | `auth-profiles.json` (API auth) |
| Sessions | `~/.openclaw/agents/<name>/sessions/` | Chat history, routing state |
| Bindings | `openclaw.json` → `bindings[]` | Maps channels → agent IDs |

### Core file trio per agent:
- **AGENTS.md** — Behavioral instructions (how to operate)
- **SOUL.md** — Personality (who you are)
- **MEMORY.md** — Accumulated knowledge about the user (starts empty, grows over time)

### Key rules:
- Never reuse `agentDir` across agents (causes auth/session collisions)
- Credentials can be shared by symlinking `auth-profiles.json` to main's copy
- `agents.defaults.workspace` is the fallback if no per-agent workspace is set
- Bindings route inbound messages from specific channels/peers to specific agents

## What Our Pipeline Currently Generates

### Main agent (via Opus API call):
- SOUL.md — Personalized personality (good)
- USER.md — User profile (good)
- IDENTITY.md — Archetype/identity (nice-to-have, not core)
- HEARTBEAT.md — Recurring check-in rules (good)
- BOOTSTRAP.md — First-contact message (good)

### Sub-agents (via template in `generateSubAgents()`):
- SOUL.md only — Basic template with inherited personality traits and domain behaviors

### What's missing entirely:
- **AGENTS.md** — Neither main agent nor sub-agents get behavioral instructions. The main agent's AGENTS.md is a generic Docker default placeholder, not personalized.
- **MEMORY.md** — Not generated (expected to be empty at start, but directory/file should exist)
- **OpenClaw agent registration** — Sub-agents aren't added to `openclaw.json` `agents.list`
- **Per-agent auth** — No `.openclaw/agents/<name>/agent/auth-profiles.json` for sub-agents
- **Per-agent workspace paths** — Not configured in `openclaw.json`

## Current State on pgardner Instance

```
/home/clawd/clawd/                    (main workspace, mounted from host)
├── SOUL.md                           (personalized from quiz - good)
├── USER.md                           (personalized from quiz - good)
├── IDENTITY.md                       (personalized from quiz)
├── HEARTBEAT.md                      (personalized from quiz)
├── BOOTSTRAP.md                      (personalized from quiz)
├── MULTI-AGENT.md                    (team structure doc)
├── AGENTS.md                         (generic Docker default - NOT personalized)
└── agents/
    ├── dispatch/SOUL.md              (template - basic)
    ├── scout/SOUL.md                 (template - basic)
    └── scribe/SOUL.md               (template - basic)

/home/clawd/.openclaw/
├── openclaw.json                     (only has agents.defaults, no agents.list)
└── agents/
    └── main/                         (only main agent registered)
        ├── agent/auth-profiles.json
        └── sessions/
```

## What Needs to Happen

### 1. Fix the file generation pipeline (`profile-generator.js`)

- **Add AGENTS.md generation** to the Opus prompt (or template fallback) — this is the behavioral instruction file that tells each agent how to operate
- **Generate per-agent AGENTS.md** for sub-agents — domain-specific behavioral instructions
- **Ensure sub-agents get richer SOUL.md** — current templates are very thin compared to the Opus-generated main SOUL.md
- Consider whether sub-agents need their own USER.md, HEARTBEAT.md

### 2. Fix the entrypoint/provisioning (`entrypoint.sh` or post-deploy script)

- **Discover sub-agent directories** in the workspace after onboarding SCP
- **Register sub-agents in `openclaw.json`** → `agents.list` with correct workspace paths
- **Create `.openclaw/agents/<name>/` directories** with auth-profiles.json (symlinked to main's) and sessions/
- **Set up bindings** if channels are configured (Discord, Telegram, etc.)

### 3. Fix workspace ownership

- Already fixed: `chown -R 1001:1001` instead of `1000:1000` (the `clawd` user is uid 1001, not `node` at uid 1000)

## Open Questions

- Should the Opus call generate AGENTS.md alongside SOUL.md, or should AGENTS.md be templated?
- Do sub-agents need their own USER.md / HEARTBEAT.md, or just AGENTS.md + SOUL.md?
- Should sub-agent SOUL.md generation also use the Opus call (more expensive but higher quality)?
- How should channel bindings work for ClawDaddy customers? (Discord channel → specific sub-agent?)
- Does the `clawd` Linux user need to be dynamic (customer's bot name) or is hardcoded fine? (Decided: hardcoded is fine, bot name is cosmetic in portal config.json)

## Related Files

- `api/lib/profile-generator.js` — Quiz → file generation pipeline
- `api/onboarding-server.js` — Orchestrates generation + SCP deployment
- `docker/entrypoint.sh` — Container startup, writes openclaw.json
- `docker/Dockerfile` — Base image with clawd user + default files
- `docker/files/AGENTS.md` — Generic default AGENTS.md (needs replacement)
- `script/provision.sh` — Lightsail instance provisioning
