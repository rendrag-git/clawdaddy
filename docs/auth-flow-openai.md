# OpenAI (Codex) BYOK Auth Flow — Proven E2E

**Tested:** 2026-02-14 on Lightsail `small_3_0` (2GB RAM, Ubuntu 24.04)
**Test instance:** `clawdaddy-auth-test` @ `44.193.2.162`

## Prerequisites on Customer Lightsail Box

- Node.js 22 (`nodejs` via nodesource)
- OpenClaw (`npm install -g openclaw`)
- No additional CLI needed (unlike Anthropic which needs Claude Code)

## Flow (Single Command)

### Step 1: Run OpenClaw onboard with OpenAI Codex auth

```bash
ssh -tt -i <key> ubuntu@<customer-ip> "openclaw onboard --auth-choice openai-codex"
```

**What happens:**
1. OpenClaw onboard wizard starts
2. Security disclaimer → select "Yes" to continue
3. Onboarding mode → select "QuickStart"
4. Config handling → select "Update values" (or "Use existing" if already configured)
5. Detects headless/VPS environment, shows info box:

```
OpenAI Codex OAuth
You are running in a remote/VPS environment.
A URL will be shown for you to open in your LOCAL browser.
After signing in, paste the redirect URL back here.
```

6. Generates OAuth URL (PKCE):

```
https://auth.openai.com/oauth/authorize?response_type=code
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback
&scope=openid+profile+email+offline_access
&code_challenge=<CHALLENGE>&code_challenge_method=S256
&state=<STATE>
&id_token_add_organizations=true
&codex_cli_simplified_flow=true
&originator=pi
```

7. Prompts: `Paste the redirect URL (or authorization code)`

**Automation notes:**
- Requires PTY (`ssh -tt`)
- Must navigate through wizard prompts (security → quickstart → config → auth)
- The wizard flow means multiple interactive prompts before reaching OAuth
- Consider using `openclaw models auth login --provider openai-codex` directly (but this errored with "No provider plugins found" — may need plugin install first)

### Step 2: Customer authorizes in browser

1. Customer opens the OAuth URL in their browser
2. Logs in to their OpenAI/ChatGPT account
3. Authorizes the application
4. Browser redirects to `http://localhost:1455/auth/callback?code=...&scope=...&state=...`
5. Since localhost won't resolve (it's the server, not their machine), the page fails to load
6. **Customer copies the full URL from the browser address bar**

**Example redirect URL:**
```
http://localhost:1455/auth/callback?code=ac_QRaG0gwoQpuuRJRr449YX7gZv3lHwK8c51LR8sT8BJc.9sFL-FHyFd3LbgoDSe_mvZYi0I7IztArxlLfNs3pANM&scope=openid+profile+email+offline_access&state=7d0fc5965c9465c94dff06c5ea7f0f63
```

### Step 3: Paste redirect URL back

Paste the **full redirect URL** into the waiting prompt and press Enter.

**On success, outputs:**
```
✓ Paste the redirect URL (or authorization code)
  http://localhost:1455/auth/callback?code=ac_...

Model configured: Default model set to openai-codex/gpt-5.3-codex
```

**Automation notes:**
- Use bracketed paste for the URL input
- OpenClaw extracts the `code` param, performs PKCE token exchange
- Token exchange happens at `https://auth.openai.com/oauth/token`
- Stores `{ access, refresh, expires, accountId }` in auth-profiles.json
- Refresh is automatic when tokens expire
- After auth, wizard continues to channel selection — Escape/Ctrl+C to exit if only doing auth

### Step 4: Verify (optional)

```bash
ssh -i <key> ubuntu@<customer-ip> "openclaw models status"
```

## Customer-Facing Flow (Web Onboarding)

From the customer's perspective at `<username>.clawdaddy.sh`:

1. Click **"Connect OpenAI Account"**
2. Browser redirects to OpenAI login (we proxy the OAuth URL)
3. Log in and authorize
4. Browser tries to redirect to `localhost:1455/...` → page doesn't load
5. Customer copies the URL from the address bar, pastes into our onboarding text field
6. Backend pipes URL into the waiting onboard process
7. Onboarding UI shows **"OpenAI Connected ✅"**

**Future improvement:** Custom redirect_uri that hits our server instead of localhost, so we can capture the code automatically without customer copy/paste.

## Backend Automation Summary

```
SSH to customer box (PTY required)
  → run `openclaw onboard --auth-choice openai-codex`
  → navigate wizard: Yes → QuickStart → Update values
  → extract OAuth URL from stdout
  → send URL to customer's browser
  → receive redirect URL from customer (full localhost callback URL)
  → paste into prompt, press Enter
  → verify "Model configured" in output
  → Escape to exit wizard (skip channel selection)
  → done ✅
```

## Comparison: Anthropic vs OpenAI

| Aspect | Anthropic | OpenAI |
|--------|-----------|--------|
| CLI tool needed | Claude Code + OpenClaw | OpenClaw only |
| Commands | 2 (`claude setup-token` + `paste-token`) | 1 (`openclaw onboard`) |
| Auth URL format | `claude.ai/oauth/authorize` | `auth.openai.com/oauth/authorize` |
| Customer pastes | `CODE#STATE` string | Full redirect URL |
| Token type | Setup token (1 year, no refresh) | OAuth (access + refresh, auto-renew) |
| Wizard navigation | None (direct command) | Multiple prompts to navigate |
| Token storage | `auth-profiles.json` (`anthropic:manual`) | `auth-profiles.json` (`openai-codex:*`) |

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `No provider plugins found` | Using `models auth login` without onboard | Use `openclaw onboard --auth-choice openai-codex` instead |
| Page doesn't load after auth | Expected — localhost points to server not customer | Customer copies URL from address bar |
| `Setup cancelled` | Escape/Ctrl+C pressed | Re-run command |

## Timing

| Step | Duration |
|------|----------|
| Wizard navigation to OAuth URL | ~5-10 seconds (automated keypresses) |
| Customer auth (browser) | User-dependent |
| Token exchange after URL paste | ~2-3 seconds |
| **Total (automated parts)** | **~15 seconds** |
