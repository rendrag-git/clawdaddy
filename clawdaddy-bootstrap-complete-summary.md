# ClawDaddy Bootstrap LLM Strategy — Complete Summary

**Date:** February 14, 2026  
**Purpose:** Cheapest way to give every new ClawDaddy customer a working OpenClaw assistant immediately upon checkout, plus how to get non-technical customers onto their own Claude subscription.

---

## Part 1: Free/Cheap Bootstrap Model

### The Problem

When a customer pays for ClawDaddy hosting, we auto-provision their OpenClaw instance. We need a model running immediately so the assistant works out of the box — before the customer configures their preferred provider.

**Requirements:**
- $0 per instance for light usage (first hour of chatting)
- Model doesn't need to be amazing — just good enough to demonstrate the product works
- Compatible with OpenClaw's provider config

### Recommendation: OpenRouter Free Models

**Primary bootstrap:** Use a single ClawDaddy-owned OpenRouter API key (funded with ≥$10) pointing at free models.

**Why this wins:**
- $0 per token on `:free` models
- 1,000 free-model requests/day (with $10+ account balance)
- 20 requests/minute
- OpenClaw has native first-class OpenRouter support — no custom provider config needed
- `openrouter/free` auto-router picks the best available free model per request
- Available free models include Llama 4 Scout/Maverick, Gemini Flash, DeepSeek V3, Mistral Small — all decent quality

**Bootstrap config injected at provisioning:**
```json
{
  "env": { "OPENROUTER_API_KEY": "sk-or-clawdaddy-shared-key" },
  "agents": {
    "defaults": {
      "model": {
        "primary": "openrouter/meta-llama/llama-4-scout:free",
        "fallbacks": [
          "openrouter/google/gemini-2.0-flash-exp:free",
          "openrouter/deepseek/deepseek-chat-v3-0324:free",
          "openrouter/openrouter/free"
        ]
      }
    }
  }
}
```

### Fallback Options

| Provider | Free Tier Details | Best For |
|----------|-------------------|----------|
| **Groq** | Llama 4 Scout: 30 RPM, 1K RPD, 500K TPD. Llama 3.1 8B: 30 RPM, 14.4K RPD. No credit card needed. | Secondary fallback — fast inference, OpenAI-compatible API |
| **Cloudflare Workers AI** | 10,000 free neurons/day. Llama 3.2 1B–3B models very cheap. OpenAI-compatible endpoint. | Good option given existing CF infrastructure for Kingshot tools |
| **Gemini Flash-Lite (Paid Tier 1)** | $0.10/M input, $0.40/M output. ~$0.002 per conversation. Just enable billing on a GCP project. | Ultra-cheap paid safety net if all free tiers fail |
| **Mistral (La Plateforme)** | Free "Experiment" tier, phone verification only. Mistral Small available. | Another fallback, OpenAI-compatible |

### Why Not These as Primary

| Provider | Problem |
|----------|---------|
| **Gemini Free Tier** | Gutted in Dec 2025. Flash down to 250 RPD. Limits per-project not per-key — can't scale. No EU/EEA/UK/Switzerland on free tier. Data used for training. |
| **Anthropic Claude** | No free API tier at all. Subscriptions (Pro/Max) are separate from API. |
| **Groq** | Limits are per-organization (shared across all customers). 1K RPD on good models is tight for multi-tenant. |

### Cost Model

| Scenario | Cost |
|----------|------|
| Customer bootstraps, adds own key within 1 hour | $0.00 |
| Customer uses free models for a full day (~50 messages) | $0.00 |
| Customer never adds key, uses it for a month | $0.00 (quality-limited) |
| All free models down, fall back to Gemini Flash-Lite paid | ~$0.005/conversation |

---

## Part 2: Getting Customers Onto Their Own Model

### OpenRouter (Recommended Default Path)

**Customer experience:** Get one API key, access Claude + GPT + Gemini + 300 more models.

**Steps:**
1. Go to openrouter.ai → Create account → Add $10+ credits
2. Copy API key
3. Paste into ClawDaddy dashboard

**ClawDaddy injects:**
```json
{
  "env": { "OPENROUTER_API_KEY": "sk-or-customer-key" },
  "agents": {
    "defaults": {
      "model": { "primary": "openrouter/anthropic/claude-sonnet-4-5" }
    }
  }
}
```

**Trade-off:** 5.5% markup on token costs vs direct Anthropic API. Worth it for the simplicity.

### Anthropic API Key (Power Users)

For customers who want direct Anthropic access with prompt caching and lowest cost.

**Steps:**
1. Go to console.anthropic.com → Create account → Add billing
2. Generate API key
3. Paste into ClawDaddy dashboard

**ClawDaddy injects:**
```json
{
  "env": { "ANTHROPIC_API_KEY": "sk-ant-..." },
  "agents": {
    "defaults": {
      "model": { "primary": "anthropic/claude-sonnet-4-5" }
    }
  }
}
```

**Note:** This is separate billing from a Claude Pro/Max subscription. Customer pays per token.

### Claude Subscription via Setup-Token (Pro/Max Users)

This is how customers with a Claude Pro ($20/mo) or Max ($100–200/mo) subscription can use their existing plan with OpenClaw instead of paying per-token.

**How it works per OpenClaw docs (docs.openclaw.ai/providers/anthropic#option-b-claude-setup-token):**

The Claude Code CLI generates a long-lived OAuth token that OpenClaw can use to make inference requests against the customer's subscription. The token is created with `claude setup-token` and pasted into OpenClaw.

**What the customer actually has to do:**
1. Open a terminal
2. Run: `npx @anthropic-ai/claude-code setup-token` (uses npx to avoid permanent install)
3. Browser opens → sign in with their Anthropic account
4. Terminal outputs a token string → copy it
5. Paste into ClawDaddy dashboard

**ClawDaddy backend then runs:**
```bash
# Inject the token into the customer's OpenClaw instance
openclaw models auth paste-token --provider anthropic
# Set the model
# Restart gateway
```

**Config result:**
```json
{
  "agents": {
    "defaults": {
      "model": { "primary": "anthropic/claude-opus-4-6" }
    }
  }
}
```

**Important caveats:**
- Requires Node.js on the customer's machine (for the npx command)
- Token can expire — customer may need to regenerate periodically
- If "OAuth token refresh failed" appears, re-run `claude setup-token`
- Prompt caching does NOT work with subscription auth (API-only feature)
- Usage is shared with their claude.ai and Claude Code usage
- Only grants `user:inference` scope, not `user:profile` (usage tracking won't show in OpenClaw)

---

## Part 3: UX for Non-Technical Customers

### The Core Challenge

Most ClawDaddy customers won't know what a terminal is, let alone npm. The setup-token flow requires running a CLI command, which is the main friction point.

### Recommended Dashboard Wizard

Build a guided flow in the ClawDaddy web dashboard:

**Screen 1: "Power Up Your Assistant"**

Offer three clear choices:
- **Quick Setup (Recommended)** — "Use OpenRouter for easy access to Claude, GPT, Gemini and more. One key, all models." → Goes to OpenRouter flow
- **Use My Claude Subscription** — "Already paying for Claude Pro or Max? Connect it here." → Goes to setup-token flow  
- **Advanced** — "I have my own API key from Anthropic, OpenAI, or another provider." → Goes to direct API key paste

**Screen 2a: OpenRouter Flow**
1. "Go to openrouter.ai and create an account"
2. "Add at least $10 in credits"  
3. "Copy your API key from openrouter.ai/keys"
4. Paste field: [________________] [Connect →]
5. ClawDaddy validates the key live (test API call), shows green checkmark
6. Model picker: "Which model do you want as your default?" (Claude Sonnet, GPT-5, Gemini Flash, etc.)

**Screen 2b: Claude Subscription Flow**
1. Detect OS (show Mac vs Windows instructions)
2. "Open your terminal and paste this command:"
   - Mac/Linux: `npx @anthropic-ai/claude-code@latest setup-token`
   - Windows: Same command in PowerShell
3. "Your browser will open — sign in with your Claude account"
4. "Copy the token that appears in your terminal"
5. Paste field: [________________] [Connect →]
6. Embed a 60-second walkthrough video showing the exact steps
7. "Need help? Chat with us" → support link

**Screen 2c: Direct API Key Flow**
1. Provider dropdown: Anthropic / OpenAI / Google / Groq / Mistral / Other
2. Paste field for API key
3. Live validation

**Screen 3: Confirmation**
- "Your assistant is now powered by Claude Sonnet 4.5"
- "You can change models anytime in Settings → AI Model"
- Show a test message to prove it works

### Dealing with Node.js Requirement

For the setup-token path, the `npx` command requires Node.js. Options for handling this:

**Option A (Ship now):** Add a prerequisite check to the wizard: "This requires Node.js. [Check if installed] → If not: Download it here (nodejs.org) → then come back." Most people paying $100+/mo for Claude Max can handle installing Node.

**Option B (Better UX, more work):** Build a hosted web-based OAuth flow at `connect.clawdaddy.com/claude` that performs the same OAuth PKCE flow in-browser, eliminating the CLI entirely. Customer clicks "Connect Claude" → browser OAuth → token flows to ClawDaddy backend. This is the Docker `claude-sub-proxy` approach but hosted as a web service.

**Option C (Fastest):** Record a Loom video, embed it, and offer live support chat for anyone who gets stuck. For v1 this is probably sufficient.

### System Prompt for Bootstrap Model

While the customer is on the free bootstrap model, set expectations:

```
You are a helpful AI assistant powered by ClawDaddy. 

Note: You're currently running on a starter model. Your owner can upgrade 
to Claude, GPT, or other premium models in their ClawDaddy dashboard at 
any time for significantly better responses. 

Visit [dashboard-url] → Settings → AI Model to upgrade.
```

This turns the bootstrap experience into a natural upsell moment.

---

## Part 4: OpenClaw Provider Compatibility Reference

### Native Support (No Custom Config)

| Provider | Model Format | Auth |
|----------|-------------|------|
| **OpenRouter** | `openrouter/<author>/<model>` | `OPENROUTER_API_KEY` env var |
| **Anthropic (API key)** | `anthropic/<model>` | `ANTHROPIC_API_KEY` env var |
| **Anthropic (subscription)** | `anthropic/<model>` | `claude setup-token` → paste |
| **OpenAI** | `openai/<model>` | `OPENAI_API_KEY` env var |

### Requires Custom Provider Config

**Groq:**
```json
{
  "models": {
    "providers": {
      "groq": {
        "baseUrl": "https://api.groq.com/openai/v1",
        "headers": { "Authorization": "Bearer $GROQ_API_KEY" }
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "groq/llama-3.3-70b-versatile" }
    }
  }
}
```

**Cloudflare Workers AI:**
```json
{
  "models": {
    "providers": {
      "cloudflare": {
        "baseUrl": "https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1",
        "headers": { "Authorization": "Bearer $CF_API_TOKEN" }
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "cloudflare/@cf/meta/llama-3.2-3b-instruct" }
    }
  }
}
```

**Mistral:**
```json
{
  "models": {
    "providers": {
      "mistral": {
        "baseUrl": "https://api.mistral.ai/v1",
        "headers": { "Authorization": "Bearer $MISTRAL_API_KEY" }
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "mistral/mistral-small-latest" }
    }
  }
}
```

---

## Part 5: Action Items

### Immediate (Ship with MVP)

1. Create a ClawDaddy OpenRouter account, fund with $10+
2. Build bootstrap config template that gets injected at instance provisioning
3. Test `openrouter/free` and specific free models (Llama 4 Scout, Gemini Flash) for quality
4. Build dashboard "Connect Your AI" wizard with OpenRouter as the recommended path
5. Add setup-token paste field for Claude subscription users (with embedded walkthrough video)
6. Add direct API key paste for Anthropic/OpenAI/other providers
7. Implement live key validation on paste (hit provider API, confirm auth works)
8. Set bootstrap system prompt that nudges upgrade

### Near-Term

9. Build config-swap logic: when customer adds their own key, replace bootstrap config and restart gateway
10. Monitor shared OpenRouter key usage — alert if approaching daily limits
11. Set up Groq free tier as secondary fallback provider
12. Create Gemini Tier 1 project as paid safety net ($0.002/conversation)

### Longer-Term

13. Build hosted OAuth flow (`connect.clawdaddy.com/claude`) to eliminate CLI requirement for subscription users
14. Consider becoming the proxy (ClawDaddy bills customers directly for AI usage, routes to providers with ClawDaddy's own keys) — best UX, customer never touches an API key
15. Implement per-customer rate limiting on the shared bootstrap key
16. Add model switching UI in dashboard (let customers swap models without editing config)
