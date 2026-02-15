# ClawDaddy Roadmap

*Last updated: 2026-02-13*

---

## What We Have (Done)

### ✅ Landing Page
- Merged page at `~/clawd/clawdaddy/index.html` (449 lines, 30KB)
- Tailwind CSS, dark theme, lobster-red accents
- Hero, social proof, What Is OpenClaw, How It Works, Pricing (3 tiers), Comparison, FAQ, Footer
- Served locally on :8080 for preview

### ✅ Domains
- **clawdaddy.sh** — registered, SUCCESSFUL ✅
- **getclawdaddy.com** — registered, SUCCESSFUL ✅
- DNS configured — both domains live via Amplify + CloudFront

### ✅ Docker Image
- `clawdaddy/openclaw:latest` — builds and runs locally
- OpenClaw gateway starts, webchat serves, config valid
- Entrypoint injects customer config from env vars (API key, model, channels)
- Auth-profiles.json correctly written
- **VNC broken** (non-fatal — `tigervncpasswd` missing in Debian bookworm)

### ✅ Deployment Scripts (from Pearson's original work)
- `install-openclaw.sh` — bare-metal installer (4 known bugs, needs Docker rewrite)
- `manage.sh` — 13-command CLI for managing instances
- `provision.sh` — Lightsail provisioning script
- `webhook-server/` — Stripe webhook → auto-provision (Node.js)
- `api-proxy/` — usage tracking + budget enforcement proxy
- `monitoring/` — health checks, daily metrics, weekly reports, destroy expired

### ✅ Infrastructure
- Docker installed on EC2
- Lightsail SSH key available (`/tmp/lightsail-key.pem`)
- AWS CLI configured (`/snap/bin/aws`)
- Test Anthropic API key available

---

## Phase 1: MVP Launch (Get Money Coming In)
*Goal: Someone can visit the site, pick a tier, pay, and get a working assistant.*

### 1.1 — Host Landing Page ✅
- [x] Deployed via AWS Amplify + CloudFront + S3
- [x] `clawdaddy.sh` resolves — 200 OK
- [x] `getclawdaddy.com` resolves — 200 OK
- [x] SSL/HTTPS working
- **Done:** 2026-02-12

### 1.2 — Email via IMAP/SMTP ✅
- [x] MCP server built at `plugins/imap-email/` (imapflow + nodemailer + mailparser)
- [x] 5 tools: check_inbox, read_email, search_emails, send_email, reply_email
- [x] Config via env vars (IMAP_USER, IMAP_PASS, etc.), Gmail defaults
- [x] Works with any IMAP provider (Gmail app passwords, Outlook, Yahoo, etc.)
- [ ] Onboarding guide: "How to generate an app password" (30-sec walkthrough)
- **Done:** 2026-02-13 (guide still TODO)

### 1.3 — Stripe Setup
- [ ] Create Stripe account (or use existing)
- [ ] Create 3 products/prices:
  - Tier 1: Self-Install — $49 one-time
  - Tier 2: Managed BYOK — $35/mo subscription
  - Tier 3: Fully Managed — $75/mo subscription
- [ ] Generate checkout links for each tier
- [ ] Wire CTA buttons on landing page to Stripe checkout URLs
- [ ] Configure Stripe webhook endpoint URL
- **Effort:** ~1 hour

### 1.4 — Tier 1 Delivery (Self-Install)
- [ ] Create downloadable install package (zip/tar with Docker setup + instructions)
- [ ] OR: create a guided onboarding page post-purchase (enter API key → get docker-compose.yml)
- [ ] Stripe fulfillment: send download link via email on successful payment
- **Effort:** ~2-3 hours
- **Note:** Tier 1 Tauri desktop app is parked for later. MVP = Docker self-install guide.

### 1.5 — Tier 2/3 Auto-Provisioning
- [ ] Adapt `provision.sh` to use Docker image instead of bare-metal install
- [ ] Deploy webhook server on EC2 (receives Stripe events)
- [ ] Flow: Stripe payment → webhook → create Lightsail → pull Docker → inject config → return webchat URL
- [ ] Customer gets email with their webchat URL + gateway token
- [ ] Test full flow end-to-end
- **Effort:** ~4-6 hours

### 1.6 — Tier 3 API Proxy (Budget Enforcement)
- [ ] Deploy `api-proxy/` on each Tier 3 instance
- [ ] Routes customer API calls through proxy with budget caps
- [ ] ClawDaddy-owned Anthropic API key, customer never sees it
- [ ] Alert/pause when budget exceeded
- [ ] Define customer-facing UX at cap hit (error message, upsell prompt, reset countdown)
- **Effort:** ~2-3 hours

### 1.7 — Monitoring & Health
- [ ] Deploy `monitoring/health-check.sh` via cron on EC2
- [ ] Alert (Discord/email) when customer instances go down
- [ ] `destroy-expired.sh` for cancelled subscriptions
- **Effort:** ~1-2 hours

### 1.8 — Managed Setup Add-ons (Launch Day Revenue)
- [ ] Add "Need help setting up?" link on post-checkout page → Calendly or simple form
- [ ] Define add-on menu: Discord bot ($50-100), Telegram ($25-50), Email ($25-50), Full Setup ($250-500)
- [ ] Document setup procedures as repeatable playbooks (you already know how)
- [ ] Manual delivery for first 10 customers — learn what people actually want
- [ ] Optional: Monthly concierge add-on ($50-100/mo) for ongoing tuning
- **Effort:** ~1 hour (form + pricing page), then labor per customer
- **Note:** Pure margin, zero infrastructure cost. Scales via documentation → automation → delegation.

**Phase 1 Total: ~15-20 hours of engineering**

### Launch Channel Stack
| Channel | Method | Setup Needed |
|---------|--------|-------------|
| Webchat | Built-in | None |
| Discord | Bot token | Customer creates bot, provides token |
| Telegram | Bot token | Customer creates bot via BotFather |
| Email | IMAP/SMTP | App password + server settings |
| Browser | Chrome extension relay | Optional power feature |

---

## Phase 2: Polish & Growth
*Goal: Reduce support burden, improve onboarding, add native integrations.*

### 2.1 — Google OAuth App (Native Gmail/Calendar)
- [ ] Create Google Cloud project for ClawDaddy
- [ ] Configure OAuth consent screen (production, not testing)
- [ ] Scopes: `gmail.readonly`, `gmail.send`, `calendar.events`
- [ ] Submit for Google verification (requires privacy policy, demo video, domain verification)
- [ ] Build OAuth flow: customer authorizes → tokens stored per-instance
- [ ] Replaces IMAP for Gmail users (smoother UX, background access without browser)
- **Effort:** ~4 hours dev + 2-6 weeks verification
- **Note:** Submit for verification ASAP — it runs in parallel while IMAP handles email at launch

### 2.2 — Customer Dashboard
- [ ] Simple web UI where customers can: see status, restart, view logs, update API key
- [ ] Manage channels: add/remove Discord, Telegram, email settings
- [ ] **Usage meter:** Show current spend vs $40 cap (data from API proxy)
- [ ] Probably a simple Express/React app behind auth
- **Effort:** ~8-12 hours

### 2.5 — Anthropic Pricing Monitor
- [ ] Monthly check on Anthropic API pricing changes
- [ ] Automated alert if per-token costs change (compare against stored baseline)
- [ ] Margin impact calculator: what does a price change mean for Tier 3 profitability?
- **Effort:** ~2 hours + ongoing vigilance

### 2.3 — SMS Channel (Twilio)
- [ ] Add Twilio SMS as a channel option at signup
- [ ] Customer provides phone number → we provision Twilio number → wire to OpenClaw
- **Effort:** ~4 hours

### 2.4 — Landing Page Refinements
- [ ] Add testimonials (once we have customers)
- [ ] Add demo video / interactive demo
- [ ] Blog / docs section
- **Effort:** Ongoing

---

## Phase 3: Scale & Premium
*Goal: Higher-value offerings, reduce per-customer cost.*

### 3.1 — Tier 1 Desktop App (Tauri)
- [ ] Native Mac .dmg / Windows .exe
- [ ] Drag-to-install, single API key field, webchat in native window
- [ ] System tray integration
- **Effort:** ~3-4 days

### 3.2 — Shared ClawDaddy Discord Bot
- [ ] Single bot invite link for customers
- [ ] Message router proxies to correct customer instance
- [ ] Eliminates need for customers to create their own bots
- **Effort:** ~8 hours
- **Prerequisite:** Auto-provision flow confirmed working

### 3.3 — Usage Analytics & Churn Intelligence
- [ ] Track per-customer usage trends (daily/weekly spend patterns)
- [ ] Flag churn signals: customers consistently hitting cap, declining usage, long idle periods
- [ ] Flag upsell candidates: customers regularly at 90%+ cap utilization
- [ ] Tiered cap options if demand warrants (e.g. $40 base, $80 power user)
- **Effort:** ~8-12 hours

### 3.4 — Multi-Tenant Architecture
- [ ] Move from 1-instance-per-customer to shared infra
- [ ] K8s or ECS with per-customer containers
- [ ] Reduce hosting cost per customer
- **Effort:** ~2-3 weeks

### 3.4 — WhatsApp Business API
- [ ] If demand warrants the Meta Business API pain
- [ ] Deprioritized — revisit based on customer requests

---

## Known Bugs / Tech Debt

| Issue | Severity | Notes |
|-------|----------|-------|
| VNC in Docker — `tigervncpasswd` missing | Low | Gateway works without it; fix by installing `tigervnc-tools` or using expect |
| `install-openclaw.sh` — 4 bugs | Medium | Wrong start command, env file vs JSON, UFW lockout, private IP. Only matters if we offer bare-metal. |
| Docker image size (1.38GB) | Low | Could slim down by removing unnecessary X11/Chromium deps if VNC not needed |
| No container resource limits | Medium | Should set memory/CPU limits per tier |

---

## Key Decisions Log

| Date | Decision |
|------|----------|
| 2026-02-12 | clawdaddy.sh primary domain |
| 2026-02-12 | Webchat + email at launch; SMS fast-follow |
| 2026-02-12 | Docker for Tier 2/3 backend; customer never sees Docker |
| 2026-02-12 | Skip UFW on cloud instances |
| 2026-02-12 | `openclaw gateway` is correct start command |
| 2026-02-12 | Tier 1 MVP = Docker self-install guide (Tauri app parked) |
| 2026-02-12 | Config schema: auth-profiles.json for API keys, openclaw.json for everything else |
| 2026-02-12 | Gateway bind options: auto/lan/loopback/custom/tailnet — use "lan" for Docker |
| 2026-02-13 | Email at launch via IMAP/SMTP (app passwords) — no Google OAuth needed |
| 2026-02-13 | Browser relay as optional power feature for arbitrary web access |
| 2026-02-13 | Google OAuth app = Phase 2 fast-follow, submit for verification early |
| 2026-02-13 | Launch channel stack: Webchat + Discord + Telegram + IMAP email + Browser relay |

---

## Immediate Next Actions (Priority Order)

1. ~~**Host landing page**~~ ✅ Done — both domains live
2. **IMAP/SMTP email plugin** — build it, test with Gmail app password
3. **Stripe setup** — products, prices, checkout links
4. **Wire CTAs** — landing page buttons → Stripe checkout
5. **Adapt provision.sh** — Docker-based instead of bare-metal
6. **Deploy webhook server** — Stripe → auto-provision
7. **Submit Google OAuth app** — start verification clock early
8. **Test full E2E** — pay → provision → webchat + email works

---

## Audit Follow-ups (Open TODOs)

### Revenue-critical
- [ ] **Validate full E2E payment -> provision flow (test mode)**
  - Verify: Stripe checkout -> `script/webhook-server/server.js` webhook -> `script/webhook-server/lib/stripe-handlers.js` -> `script/provision.sh` -> completion email with working access details.
- [ ] **Docker production pass (current-code validation, not doc assumptions)**
  - Resolve launch blockers from `docker/ISSUES.md` that still reproduce in current runtime.
  - Verify customer usability after restart and stable webchat access.

### Ops / security / cleanup
- [ ] **Consolidate waitlist service to one implementation**
  - Keep canonical handler in `script/webhook-server/server.js`.
  - Remove/archive legacy `api/waitlist-server.js` + `api/waitlist.service`.
- [ ] **Harden waitlist security**
  - Remove hardcoded Zoho fallback key/URL from `script/webhook-server/server.js`.
  - Keep Zoho endpoint/credentials in environment only and rotate exposed secrets.
- [ ] **Add analytics + link hygiene on landing page**
  - Add CTA + waitlist conversion instrumentation in `index.html`.
  - Replace placeholder footer links (`href="#"`) with real destinations.
- [ ] **Archive legacy landing page variants**
  - Deprecate `index-codex.html`, `index-original.html`, and `script/index.html` so `index.html` is the single source of truth.

### Completed from this audit thread
- [x] **Persist Stripe identity across provisioning lifecycle**
  - Implemented in `script/webhook-server/lib/stripe-handlers.js`, `script/webhook-server/lib/customers.js`, `script/webhook-server/lib/provisioner.js`, and `script/provision.sh`.
