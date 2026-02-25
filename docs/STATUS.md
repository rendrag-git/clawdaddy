# ClawDaddy — Project Status
> **Last updated:** 2026-02-24 ~9:55 PM ET by Atlas
> **All agents: read this file at session start. This is the single source of truth.**

## Current Phase
Pre-launch. **Phase 1 merged to master. All original ship-blockers resolved. E2E test is the next gate.**

## What's Shipped (As of Today)
- ✅ Stripe checkout → quiz v1.1 → Opus profile gen → Lightsail provision → DNS → Caddy HTTPS → ZeptoMail email
- ✅ Customer portal at `username.clawdaddy.sh/portal/` — auth, settings, agent config, API key management
- ✅ PWA chat app — live at `pgardner.clawdaddy.sh` — browser → portal (3847) → OpenClaw gateway (18789) → Anthropic. Streaming, markdown, multi-turn all working. Shell injection fixed. Merged to master.
- ✅ BYOK auth — full flow: Anthropic + OpenAI key entry → SSH delivery to instance → stored in OpenClaw config. Merged to master.
- ✅ SQLite database — customers + onboarding_sessions tables. Single source of truth (customers.json removed).
- ✅ `fix/remove-customers-json` — removed redundant flat-file customer storage from provision.sh. All persistence via SQLite through webhook server + onboarding server. Merged to master.
- ✅ Onboarding server rewritten — SQLite-backed, inline auth flow, BYOK provider instructions
- ✅ Docker image rebuilt + pushed to ECR (`public.ecr.aws/b0x3t9x7/clawdaddy/openclaw:latest`)
- ✅ Portal bundle → S3 (`s3://clawdaddy-releases/portal-v1.tar.gz`)
- ✅ Stripe custom fields (`username` + `bot_name`) on payment link
- ✅ Control plane deployed — master pulled, both servers running (onboarding:3848, webhook:3000)
- ✅ Opus-quality sub-agent profiles + container agent discovery
- ✅ Quiz: 12 personality + 5 use-case questions, 9 dimensions, multi-agent team generation
- ✅ ZeptoMail transactional email (domain verified, DKIM/SPF/DMARC)
- ✅ bcrypt portal password hashing
- ✅ Config management endpoints (API keys, model picker, advanced settings)

## 🟡 Stripe Webhook — Ready for E2E Test
- **Previous:** Webhook signature verification failures (Feb 16-19)
- **Current:** Webhook server running 20+ hours, signing secret set, signature verification confirmed working (correctly rejects unsigned requests)
- **Status:** Deployed and verified, but no live `checkout.session.completed` event tested end-to-end yet
- **Next:** E2E test will confirm full flow (Stripe checkout → webhook → DB write → provision)
- **Server:** `ubuntu@3.230.7.207`, service: `onboarding`, logs: `sudo journalctl -u onboarding --no-pager -n 50`

## Recent Changes (2026-02-24)
- ✅ **Tailscale mesh deployed** — dev box (`100.85.136.70`), MacBook Pro (`100.87.90.39`), Mac Mini (`100.86.171.99`). SMB share on dev box for Finder access.
- ✅ **OpenClaw updated to v2026.2.23** — per-agent cache params, bootstrap file caching, sessions cleanup hardening.

## Recent Changes (2026-02-23)
- ✅ **Profile gen: Hybrid pipeline validated** — Opus analysis → Sonnet parallel file gen. ~$0.36/profile. Pearson picked hybrid in blind 3-way test (over pure Opus at $0.62 and pure Sonnet at $0.30). Production winner.
- ✅ **Profile gen timeout fix** — removed all `req.setTimeout` calls (commit `d4be367`, deployed to control plane).
- ✅ **B9 fix merged** (`fix/remove-skip-bootstrap`) — removed invalid `skipBootstrap` config key from provision template.
- ✅ **B11 fix merged** (`fix/portal-reads-soul`) — portal reads SOUL.md for personality data instead of config.json.
- ✅ **Agent restructure** — Dave recast as supervised coding agent (propose-only). Soren stood up as read-only architect (Opus 4.6, exec-approvals enforced). Atlas remains PM/coordinator.
- ✅ **Anthropic admin key** stored in AWS Secrets Manager (`anthropic/admin-key`, ClawDaddy account, us-east-1). IP-locked to dev box + control plane + Pearson home.

## Recent Changes (2026-02-22)
- ✅ **Phase 1 merged to master** (`45d9dde`) — 8 parallel streams (A-H) all landed:
  - **A: Entrypoint fix** — `docker/entrypoint.sh` idempotent. Env vars seed first boot only. `.initialized` marker.
  - **B: Price alignment** — `index.html` signup + pricing cards aligned ($19/$35/$79)
  - **C: Profile gen overhaul** — OpenRouter → Anthropic direct (Opus 4.6). Structured outputs. SSE progress stream.
  - **D: OAuth multi-provider** — 6-provider config. Portal provider grid UI. `authWithApiKey`, `writeApiKeyToInstance`, `getProviderList`.
  - **E: Provision.sh fixes** — SCP perms, dns_token full-chain fix, snapshot-based provisioning, DNS boot retry.
  - **F: Ops tooling** — `update.sh`, `manage.sh` (update/update-all/health-all/sync-nginx).
  - **G: nginx sync** — `sync-nginx-map.sh` generates customers.map from SQLite. Self-healing cron.
  - **H: Admin API** — 4 endpoints on webhook server with token auth.
- ✅ **Provider auth reference** compiled — 30+ providers, auth methods, key formats. See `agents/pm/provider-auth-reference.md`.
- ✅ **Plan A finalized** — `agents/pm/plan-a-improved-lightsail.md`. ECS (Plan B) parked for 50+ customers.
- ✅ **Competitive intel** — ClawInit at $99/mo dedicated (75% margin). SimpleClaw at $33.7k MRR.
- ✅ **Beta cap: 40 customers** on $12/mo Small (2GB) Lightsail instances.

## Recent Changes (2026-02-21)
- ✅ **Prompt caching deployed** — cache-proxy.js (systemd service on 127.0.0.1:7891). 99.3% cache hit rate on system prompts. Fixed 3 OpenClaw caching bugs (moving breakpoint, TTL mismatch, Discord snowflake IDs).
- ✅ **Agent model tiering** — Opus (pm/dev/legal), Sonnet (main/marketing/product/compliance), Haiku (support/payments/aws/finance/db/apple/mailroom). Haiku agents on Max subscription (flat rate). api03 key + proxy for cached agents.
- ✅ **Twitter account created** — `@clawdaddysh` (matches domain)
- 🔴 **E2E BLOCKER: Auth code submission** — `claude setup-token` OAuth URL generation works, but stdin pipe can't deliver the auth code through SSH PTY → Docker PTY → Ink TUI. Both `\n` and `\r` fail. **Recommended fix:** Use Anthropic OAuth API server-side (skip SSH for auth entirely) or `openclaw models auth paste-token` via separate SSH call.
- ✅ **Bugs fixed today:** customers.json removed from provision.sh, webhook secrets from .secrets/ files, checkout success_url fixed, pricing CTAs link to #signup, provisioner passes --username, tier mapping, Docker image includes build tools, SSH auth commands exec into Docker, OAuth URL ANSI stripping, writeAuthProfile uses paste-token CLI

## E2E Testing Backlog (2026-02-22)

### 🔴 Ship-blocking (fix before launch)
1. ~~**Auth code submission**~~ — ✅ FIXED (server-side PKCE OAuth, multi-provider)
2. ~~**Price mismatch**~~ — ✅ FIXED (Stream B)
3. ~~**Quiz form layout**~~ — ✅ FIXED (`ede150e` — absolute-positioned slides)
4. ~~**Quiz theme mismatch**~~ — ✅ FIXED (`c8850ca` — aligned with homepage design system)
5. ~~**Model provider list**~~ — ✅ FIXED (Stream D — 6 providers, portal grid UI)
6. ~~**SCP permission denied**~~ — ✅ FIXED (Stream E — chown ubuntu→1001)
7. ~~**Profile gen progress indicator**~~ — ✅ FIXED (Stream C — SSE progress)
8. ~~**Quiz state persistence**~~ — ✅ FIXED (`131d4ff` — localStorage with 24h TTL)
9. ~~**`skipBootstrap` in provision config template**~~ — ✅ FIXED (`6fb89a8` — removed from provision.sh)
10. **🔴 Email template still sends VNC instructions** — `provisioning_complete()` in email.js has old VNC template. Two separate email code paths exist. Ready email should include portal URL with portalToken.
11. ~~**Portal ↔ Profile disconnect**~~ — ✅ FIXED (`7b1b037` — portal reads SOUL.md instead of config.json)

### 🟡 UX improvements (post-launch OK)
- Provisioning status not surfaced to customer (stages emitted server-side only)
- "Instance not provisioned yet" on auth page — should auto-poll and transition
- Server restart kills in-flight auth sessions (in-memory Map)

### 🟡 Backend (pre-launch nice-to-have)
- Admin API endpoints on webhook server (`/api/admin/customers`, `/api/admin/customers/:username`, `/api/admin/instances/:id/reboot`) — eliminates EC2 Instance Connect → SSH → node eval shell quoting hell for DB queries
- `expect`-based auth flow as alternative to tmux for OAuth code submission

### 🟢 Backend cleanup (post-launch)
- Switch profile gen from OpenRouter to Anthropic API direct
- Consider Sonnet over Opus for profile gen (~30s vs ~2min)
- Tier-to-instance-size mapping (starter/pro/power → different Lightsail bundles)
- Docker image update path for existing instances
- `api/lib/provisioner.js` is dead code — delete or wire up
- `generate_user_data()` / `add_customer_record()` positional args → named args
- Clean up old test Lightsail instances + customer records
- `static_ip`/`static_ip_name` fields in schema → rename to `public_ip`
- DNS update oneshot timing issue on first boot
- Old `openclaw-webhook.service` references `/opt/openclaw-webhook` — delete
- Zombie process resilience (onboarding service crashed for 18hrs from port squatter)

## Previous Changes (2026-02-20)
- ✅ **`fix/remove-customers-json`** — removed customers.json flat-file from provision.sh. SQLite is now the only customer store. Merged to master.
- ✅ **Webhook signature verification confirmed** — Dev tested, server correctly rejects unsigned requests
- ✅ **Stripe CLI not installed** on control plane — full E2E test is the next validation step
- ✅ **Dev workflow rule added** — no more live editing on control plane. All changes through repo → branch → deploy.
- ⚠️ **Dev pushed changes to master directly** (again) instead of to branch — need deploy script to enforce workflow

## Previous Changes (2026-02-18 → 02-19)
- ✅ **ECR image updated** — rebuilt from current master on Mac (Apple Silicon + buildx linux/amd64), pushed to ECR
- ✅ **E2E test attempted** — failed on webhook bug. All other pipeline steps untested
- ✅ **`feat/multi-agent-provision` branch** — MERGED to master
- ⚠️ **Git worktree on Mac** — master branch locked to `clawdaddy-portal-config` worktree at `~/Projects/active/clawdaddy-portal-config`

## Internal Hook Pack (Pre-Launch)
Custom hook pack using `agentCommand()` internally instead of `/hooks/agent` HTTP endpoint. Benefits: trusted (no "external untrusted" label), can post Discord acknowledgment in same call at near-zero cost, zero HTTP overhead. **Required before launch** — external label caused agents to refuse legitimate delegations as prompt injection attacks (happened last night with payment task at 1:40AM). Template: `boot-md` hook. Dev has the spec.

## Must Do Before Launch
1. **E2E test** — full provision via Stripe checkout with real persona. Never ran against the current stack. This is the #1 priority.
2. **BOOTSTRAP.md template fix** — reframe fake capability claims as "ready to connect"
4. ~~**Multi-agent provisioning**~~ — ✅ MERGED to master (2026-02-20)
5. ~~**Rotate exposed keys**~~ — non-issue (confirmed by Pearson 2026-02-20)
6. **BYOK key persistence** — strategy for container replacement (Secrets Manager or similar)

## Blocked
- **Stripe payouts** — needs IRS 147C letter (SS-4 confirmation). Doesn't block operations.
- **Outlook email checks** — Playwright auth expired. Needs interactive re-auth.

## Open Branches
- `feat/pwa-chat` — Codex branch (cherry-pick candidate, may have additional polish)
- `feat/landing-v2` — landing page v2
- ~~`feat/multi-agent-provision`~~ — merged to master (2026-02-20)

## Managed Tier (Future — Not Launch)
Finance analysis from archived thread — do not re-litigate these:

- **Flat-rate managed API: dead.** Cache writes alone cost ~$103/mo for a heavy user. No flat price point works.
- **ANTHROPIC_BASE_URL proxy: not needed.** OpenRouter is the routing layer if/when managed tier launches.
- **Viable managed tier model:** Pass-through billing via OpenRouter with 20% markup. Customer loads credits, their usage burns against it, no flat-rate risk.
- **Free model routing is the unlock:** Route heartbeats/background tasks to free models (Gemini Flash 2.0, Llama 3.3 70B, DeepSeek V3). Sonnet only for user-facing conversations. Drops per-customer API cost from ~$128/mo to ~$6/mo. At $15/mo managed add-on: 54.9% margin. ✅
- **3-day BYOK free trial: approved.** Cost: $1.25/trial (Lightsail only, no API exposure). CAC at 50% churn: ~$2.50. Clean.
- **No trial on managed API tier: correct.** Zero revenue + our API key = uncontrolled exposure. Never.
- **"Founding rate forever": rejected.** Permanent margin bleed on loyal customers. One-time launch discount only (30 days, not recurring).

## Key Decisions
- BYOK only at launch (no managed API tier)
- Pricing/tier structure: **NOT LOCKED — still in flux. Do not build against it.**
- Leading candidates: Solo $29/mo (2GB) | Team $49/mo (4GB) — but not confirmed
- Managed API add-on: $15/mo (future) — not confirmed
- Old $19/$39/$69 tiers: dead, do not reference
- PWA chat is the primary customer interface (not OpenClaw dashboard)
- No Supabase yet — mutex for race conditions, SQLite until 30-50 customers
- All agents on Sonnet 4.5 or Opus 4.6 (Sonnet 4.6 broken — avoid)
- **Profile gen: Hybrid pipeline** — Opus analysis → Sonnet parallel file gen (~$0.36/profile). Validated in blind A/B/C test 2026-02-23.

## Agent Channels (New — as of 2026-02-18)
Agents migrated from threads to dedicated channels. Old threads archived (read-only).
- 🔧 Dev: `1473797451839311952`
- 💳 Payments: `1473797470361354332`
- 📣 Marketing: `1473797511180193794`
- 📦 Product: `1473797531791003711`
- 🎧 Support: `1473797547930943673`
- ⚖️ Legal: `1473797564800303105`
- 📋 Compliance: `1473797614808858768`
- ☁️ AWS: `1473797629732192371`
- 🌎 Atlas: `1473797645154910382`
- 💰 Finance: `1473797663072981043`
- 🗄️ Database: `1473797702784651316`
- 🅿️ Parking Lot: `1474513570963263538`

## Architecture Quick Ref
- **Control plane:** `3.230.7.207` (ClawDaddy LLC `087290014567`, `--profile clawdaddy`)
- **Dev box:** `18.209.163.24` (80Mills `730335583521`)
- **Route 53 zone:** `Z02919613KESOD3UW0BNK` (80Mills account)
- **Repo:** github.com/rendrag-git/clawdaddy (master branch)
- **ECR:** `public.ecr.aws/b0x3t9x7/clawdaddy/openclaw:latest`
- **Customer instances:** Lightsail, dynamic IP, boot-time DNS callback to control plane
