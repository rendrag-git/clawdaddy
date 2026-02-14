# Anthropic (Claude) BYOK Auth Flow — Proven E2E

**Tested:** 2026-02-14 on Lightsail `small_3_0` (2GB RAM, Ubuntu 24.04)
**Test instance:** `clawdaddy-auth-test` @ `44.193.2.162`

## Prerequisites on Customer Lightsail Box

- Node.js 22 (`nodejs` via nodesource)
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- OpenClaw (`npm install -g openclaw`)

## Flow (2 commands, sequential)

### Step 1: Generate OAuth URL via `claude setup-token`

```bash
ssh -tt -i <key> ubuntu@<customer-ip> "claude setup-token"
```

**What happens:**
1. Claude Code starts, displays ASCII art splash screen
2. Tries to open a browser → fails (headless server, no display)
3. After ~10 seconds, falls back and prints:

```
Browser didn't open? Use the url below to sign in (c to copy)

https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e
&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback
&scope=user%3Ainference&code_challenge=<CHALLENGE>&code_challenge_method=S256&state=<STATE>

Paste code here if prompted >
```

4. Process blocks, waiting for code input

**Automation notes:**
- Must use PTY (`ssh -tt` or equivalent) — raw mode required by Ink (Claude Code's TUI)
- Without PTY: crashes with `Raw mode is not supported on the current process.stdin`
- Parse the OAuth URL from stdout (look for `https://claude.ai/oauth/authorize`)
- The URL contains a unique `code_challenge` and `state` per invocation
- Wait ~10-12 seconds after launch for the fallback URL to appear

### Step 2: Customer authorizes in browser

1. Customer opens the OAuth URL in their browser
2. Logs in to their Anthropic/Claude account
3. Authorizes the application
4. Gets redirected to `https://platform.claude.com/oauth/code/callback`
5. Page displays a code in the format: `CODE#STATE`

**Example:** `pvCE6mCnCGVvoJXC5me5ebJ6PmUHXhxGIjQkWsYbDSRWqNL7#icSHrJyzQ_vgQ5QRKZpYiJM2jdgiVeyft9ly3ncfFE0`

### Step 3: Feed code back to `claude setup-token`

Send the **full `CODE#STATE` string** to the waiting process stdin, followed by Enter.

```
# Via PTY send-keys or stdin write:
<CODE#STATE>\n
```

**Critical:** Must include the `#STATE` suffix. Code-only (before `#`) fails with:
```
OAuth error: Invalid code. Please make sure the full code was copied
```

**On success, outputs:**
```
✓ Long-lived authentication token created successfully!

Your OAuth token (valid for 1 year):

sk-ant-oat01-<TOKEN>

Store this token securely. You won't be able to see it again.
Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>
```

**Automation notes:**
- Parse the `sk-ant-oat01-...` token from stdout
- Token is valid for 1 year
- Process exits with code 0 on success
- On invalid code, offers "Press Enter to retry" (same challenge/state, URL still valid)

### Step 4: Inject token into OpenClaw

```bash
ssh -tt -i <key> ubuntu@<customer-ip> "openclaw models auth paste-token --provider anthropic"
```

**What happens:**
1. OpenClaw TUI prompts: `Paste token for anthropic`
2. Send the `sk-ant-oat01-...` token via paste (not character-by-character typing)
3. Press Enter

**On success, outputs:**
```
✓ Paste token for anthropic
  sk-ant-oat01-...
Updated ~/.openclaw/openclaw.json
Auth profile: anthropic:manual (anthropic/token)
```

**Automation notes:**
- Also requires PTY (interactive TUI prompt)
- Use bracketed paste mode for reliable token input
- Token stored in `~/.openclaw/agents/<agent>/agent/auth-profiles.json`
- Profile name: `anthropic:manual` (type: `anthropic/token`)

## Customer-Facing Flow (Web Onboarding)

From the customer's perspective at `<username>.clawdaddy.sh`:

1. Click **"Connect Claude Account"**
2. Browser redirects to Anthropic login (we proxy the OAuth URL from step 1)
3. Log in and authorize
4. Redirected to callback page showing `CODE#STATE`
5. *(Option A)* Customer copies code, pastes into our onboarding UI text field
6. *(Option B)* We intercept the callback URL and extract code automatically (requires custom redirect_uri — future improvement)
7. Backend completes steps 3-4 automatically
8. Onboarding UI shows **"Claude Connected ✅"**

## Backend Automation Summary

```
SSH to customer box
  → run `claude setup-token` (PTY required)
  → wait ~12s for OAuth URL in stdout
  → extract URL, send to customer's browser
  → receive CODE#STATE from customer
  → pipe into stdin of waiting process
  → parse sk-ant-oat01-* token from stdout
  → run `openclaw models auth paste-token --provider anthropic` (PTY required)
  → paste token, press Enter
  → verify "Auth profile: anthropic:manual" in output
  → done ✅
```

## Error Handling

| Error | Cause | Recovery |
|-------|-------|----------|
| `Raw mode is not supported` | No PTY allocated | Use `ssh -tt` or PTY mode |
| `OAuth error: Invalid code` | Partial code (missing `#STATE`) | Retry with full `CODE#STATE` |
| `Required` (empty field) | Enter pressed before token input | Re-paste token, then Enter |
| OOM kill during npm install | <2GB RAM | Use `small_3_0` (2GB) or larger |

## Timing

| Step | Duration |
|------|----------|
| `claude setup-token` startup → URL | ~10-12 seconds |
| Customer auth (browser) | User-dependent |
| Token exchange after code input | ~3-5 seconds |
| `paste-token` command | ~3-5 seconds |
| **Total (automated parts)** | **~20 seconds** |
