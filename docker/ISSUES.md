# Docker Image — Known Issues & Fixes Needed

*Last updated: 2026-02-12*

Status: **Image builds and runs. Gateway starts. Webchat serves HTML.** But customer can't actually use it yet due to auth/pairing issues.

---

## 🔴 P0 — Blocking Customer Use

### 1. Webchat requires HTTPS for non-localhost connections
**Symptom:** Browser shows `disconnected (1008): control ui requires HTTPS or localhost (secure context)`
**Cause:** OpenClaw's control UI (webchat) enforces secure context. Raw HTTP over public IP gets rejected.
**Workaround:** SSH tunnel (`ssh -L 18789:localhost:18789`) makes it appear as localhost.
**Real fix:** Put Cloudflare (or nginx + Let's Encrypt) in front with HTTPS. Every customer instance needs a subdomain + SSL cert.
**Options:**
  - Cloudflare Tunnel per instance (zero-config SSL, no port exposure)
  - Wildcard cert on `*.clawdaddy.sh` + nginx reverse proxy
  - Caddy (auto-HTTPS) as a sidecar container
**Effort:** ~2-4 hours to implement, decision needed on approach

### 2. Gateway token mismatch on webchat connect
**Symptom:** `disconnected (1008): unauthorized: gateway token mismatch`
**Cause:** The gateway generates a random auth token at startup. The webchat UI needs this token but the customer has no way to know it or enter it.
**Workaround:** Append `?token=<token>` to the URL — but token is random each restart.
**Real fix options:**
  - Set a deterministic token derived from customer ID (so it survives restarts)
  - Pass the token to customer in their welcome email / dashboard
  - Set `gateway.auth.mode` to `"none"` (if supported — needs testing)
  - Embed token in a custom landing page that auto-injects it
**Effort:** ~1 hour once we pick an approach

### 3. Webchat pairing requirement
**Symptom:** `disconnected (1008): pairing required`
**Cause:** Even with the correct token, OpenClaw's webchat requires a "pairing" handshake (security feature for personal assistants). Not appropriate for a hosted SaaS product.
**Real fix:** Need to find the config key that sets webchat DM policy to `"open"` instead of `"pairing"`. Candidates:
  - Some channel-level `dmPolicy: "open"` setting
  - A gateway-level `controlUi` config option
  - May need to run `openclaw configure` interactively to set it up properly
**Effort:** ~1-2 hours (research + test)

---

## 🟡 P1 — Should Fix Before Launch

### 4. VNC doesn't start (tigervncpasswd missing)
**Symptom:** `⚠️ VNC password setup failed (non-fatal)` → `⚠️ VNC failed to start (non-fatal)`
**Cause:** `tigervncpasswd` binary doesn't exist in Debian bookworm's `tigervnc-common` or `tigervnc-standalone-server` packages.
**Impact:** VNC is needed for browser automation (Outlook email checks, web scraping). Without it, OpenClaw's browser tools won't work.
**Fix options:**
  - Install `tigervnc-tools` package (if it exists in bookworm)
  - Use `expect` to pipe password through `tigervncserver`'s interactive prompt
  - Pre-generate the VNC password file with raw byte encoding (DES-mangled)
  - Switch to `x11vnc` or `Xvfb` + `novnc` instead
**Effort:** ~1-2 hours

### 5. Channel config uses python3 (not in container)
**Symptom:** Discord/Telegram channel injection silently fails.
**Cause:** The entrypoint uses `python3` to build the channels JSON, but the `node:22-slim` base image doesn't include python3 and we didn't install it.
**Impact:** Customers who pass `DISCORD_TOKEN`/`TELEGRAM_TOKEN` env vars won't get those channels configured.
**Fix:** Rewrite channel JSON building in bash (jq) or node (already available).
**Effort:** ~30 min

### 6. Entrypoint overwrites config on every restart
**Symptom:** Any manual config changes (like disabling auth) are lost on `docker restart`.
**Cause:** Entrypoint unconditionally writes openclaw.json and auth-profiles.json.
**Impact:** Can't persist runtime config changes.
**Fix:** Only write config if it doesn't exist (first boot), or merge rather than overwrite.
**Effort:** ~30 min

### 7. Gateway token randomizes on every restart
**Symptom:** Token changes every time the container restarts. Any bookmarked URL with `?token=` breaks.
**Cause:** `GW_TOKEN` defaults to random if `OPENCLAW_GATEWAY_TOKEN` env var not set.
**Impact:** Customer's webchat URL breaks on restart unless they set a fixed token.
**Fix:** Either require `OPENCLAW_GATEWAY_TOKEN` env var, or derive deterministically from `CUSTOMER_ID`.
**Effort:** ~15 min

---

## 🟢 P2 — Nice to Have

### 8. Image size is 1.38GB
**Cause:** Chromium (~400MB), X11/VNC deps (~300MB), npm packages (~200MB), base image (~200MB).
**Impact:** Slow to build on small instances (~10 min on Lightsail small). Slow to pull from registry.
**Fix options:**
  - Multi-stage build (build deps in one stage, copy only runtime)
  - Strip Chromium if VNC not needed for the tier
  - Use Alpine base instead of Debian slim
  - Pre-build and push to ECR (customers pull, don't build)
**Effort:** ~2-4 hours

### 9. No resource limits on container
**Cause:** Docker run doesn't set `--memory` or `--cpus`.
**Impact:** Container could OOM the host or starve other processes.
**Fix:** Add `--memory=1.5g --cpus=1` (or appropriate per tier) to docker run.
**Effort:** ~5 min

### 10. Health check may not reflect actual readiness
**Cause:** `curl http://localhost:18789/health` — not sure if this endpoint exists or what it returns.
**Impact:** Docker may report "healthy" before the gateway is actually ready.
**Fix:** Verify the health endpoint exists; if not, check for the websocket port or a known endpoint.
**Effort:** ~15 min

### 11. Build on Lightsail is slow (~10 min)
**Cause:** 1 vCPU + 2GB RAM on small_3_0. npm install and docker export are CPU/IO bound.
**Impact:** Provisioning a new customer takes 10+ min.
**Fix:** Pre-build image and push to ECR/Docker Hub. Customer instances just `docker pull`.
**Effort:** ~1 hour (ECR setup + push script)

---

## Priority Order for Fixing

1. **#2 + #7** — Fix gateway token (deterministic or passed via env) — 30 min
2. **#3** — Solve pairing requirement (research + config) — 1-2 hrs
3. **#1** — HTTPS solution (Cloudflare tunnel or Caddy sidecar) — 2-4 hrs
4. **#5** — Fix channel config (rewrite in node) — 30 min
5. **#6** — Don't overwrite config on restart — 30 min
6. **#4** — Fix VNC — 1-2 hrs
7. **#11** — Push pre-built image to ECR — 1 hr
8. **#8** — Slim image size — 2-4 hrs
9. **#9 + #10** — Resource limits + health check — 20 min

**Estimated total to production-ready: ~8-12 hours**

---

## What Works Today

- ✅ Image builds (Dockerfile, 13 steps)
- ✅ OpenClaw installs and starts (`openclaw gateway`)
- ✅ Config schema correct (auth-profiles.json, openclaw.json)
- ✅ Gateway listens on port 18789, binds to all interfaces
- ✅ Webchat HTML serves (HTTP 200)
- ✅ Heartbeat starts
- ✅ Browser service initializes
- ✅ Container health check runs
- ✅ Env var injection works (API key, customer ID, model)
- ✅ Runs on Lightsail small_3_0 ($10/mo, 2GB RAM)
