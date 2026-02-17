# Customer Portal: Auth Flow + Deployment Design

**Date:** 2026-02-17
**Status:** Approved

## Goal

Make `username.clawdaddy.sh` a real customer-facing experience: click the email link, land logged in, see your dashboard, set a password.

## Architecture

The portal already exists (`portal/`) as an Express server + vanilla SPA with JWT auth, profile page, settings, and OpenClaw dashboard link. Three things are missing:

1. **First-time auto-login** — email link with portalToken logs the customer in automatically
2. **Password creation prompt** — "Set a password" banner on first login
3. **Deployment** — portal files need to reach customer instances via S3 bundle

## Auth Flow

### First-time experience

1. Provisioning generates `portalToken` (64 hex chars) — already happens
2. Ready email includes link: `https://username.clawdaddy.sh?token=XXX` (portalToken, NOT gateway token)
3. Portal frontend detects `?token=` in URL, auto-submits to `POST /api/auth/login`
4. Customer lands on home page logged in, sees "Set a password" banner
5. Customer creates password via inline form (not a separate setup page)
6. portalToken stays valid forever as backup login — no forgot-password flow needed

### Returning experience

- Customer goes to `username.clawdaddy.sh`, enters password, logs in
- Or clicks original email link again (portalToken still works)

### Security decisions

- **No token expiry or burn-after-use** — portalToken is 64 hex chars, only in email and instance config. Same attack surface as a password reset link.
- **No forgot-password flow** — portalToken IS the recovery method. Build this later if needed.
- **Hash passwords with bcrypt** — existing code stores passwords plaintext. Add bcrypt (one new dependency).
- **JWT sessions** — 7-day expiry, httpOnly cookie, sameSite strict. Already implemented.

## Portal Deployment

### S3 bundle

- `portal-v1.tar.gz` → `s3://clawdaddy-releases/portal-v1.tar.gz`
- Contains: `server.js`, `package.json`, `package-lock.json`, `public/` directory
- Does NOT contain `node_modules/` — npm install runs on instance
- Public-read S3 bucket (same as Docker bundle and API proxy bundle)

### User-data changes (provision.sh)

- New env var: `PORTAL_BUNDLE_URL` (default: `https://clawdaddy-releases.s3.amazonaws.com/portal-v1.tar.gz`)
- Download + extract to `/home/ubuntu/clawdaddy/portal/`
- `cd /home/ubuntu/clawdaddy/portal && npm install --production`
- `systemctl start clawdaddy-portal` (service definition already exists in user-data)

### Path layout on instance

- `/home/ubuntu/clawdaddy/portal/` — code (from S3 bundle, replaceable on upgrade)
- `/home/ubuntu/clawdaddy-portal/config.json` — data (generated at provisioning, persists across upgrades)
- Systemd service: `WorkingDirectory=/home/ubuntu/clawdaddy/portal`, env `PORTAL_CONFIG_PATH=/home/ubuntu/clawdaddy-portal/config.json`

### What already works (don't touch)

- Caddy routes: `/` → portal static files, `/dashboard` → OpenClaw :18789, `/api/*` → portal :3847
- Systemd service definition for `clawdaddy-portal.service`
- Config.json generation with portalToken and gatewayToken

## Email Changes

- Main CTA link: `https://username.clawdaddy.sh?token=PORTAL_TOKEN` (was `https://username.clawdaddy.sh`)
- Remove gateway token from email body (customers don't need it — portal handles it internally)
- Dashboard link in quick-start: `username.clawdaddy.sh` (not `/dashboard` — portal is the front door)
- Subject line and body copy unchanged

## Portal Code Changes

### Frontend (`portal/public/app.js`)

1. **Auto-login from URL token**: On page load, check for `?token=` query param. If present, auto-submit to `/api/auth/login`. Strip token from URL after login (history.replaceState).
2. **"Set a password" banner**: On home view, if profile data indicates no password is set (`config.password === null`), show a prominent card with password creation form. Collapse after password is set.

### Backend (`portal/server.js`)

1. **bcrypt password hashing**: Hash on set, compare on login. One new dependency (`bcrypt`).
2. **Password-set status endpoint**: Add `hasPassword` field to `GET /api/portal/profile` response so frontend knows whether to show the banner.
3. **No other changes** — login, logout, auth check, settings all work as-is.

## What's NOT in scope

- Forgot-password flow
- Token expiry or burn-after-use
- Email verification
- Multi-user accounts
- Portal code hot-reload/update mechanism (future: new S3 bundle + SCP + systemctl restart)
