#!/bin/bash
set -e

###############################################################################
# ClawDaddy Entrypoint
# 
# Injects customer config from environment variables, starts VNC + OpenClaw.
#
# Required env:
#   ANTHROPIC_API_KEY  — Customer's Anthropic API key
#
# Optional env:
#   CUSTOMER_ID        — Customer identifier (for logging/routing)
#   VNC_PASSWORD       — VNC password (default: random)
#   DISCORD_TOKEN      — Discord bot token
#   DISCORD_CHANNEL    — Discord channel ID
#   TELEGRAM_TOKEN     — Telegram bot token  
#   TELEGRAM_CHAT      — Telegram chat ID
#   OPENCLAW_MODEL     — Model override (default: anthropic/claude-sonnet-4-20250514)
#   WEBCHAT_ENABLED    — Enable webchat (default: true)
#   VNC_ENABLED        — Enable VNC server (default: true)
###############################################################################

WORKSPACE="/home/clawd/clawd"
CONFIG_DIR="/home/clawd/.openclaw"
VNC_DISPLAY=":1"

echo "🦞 ClawDaddy OpenClaw Container Starting..."

# --- Validate required env ---
if [[ -z "${ANTHROPIC_API_KEY}" ]]; then
    echo "ERROR: ANTHROPIC_API_KEY is required"
    exit 1
fi

# --- Generate OpenClaw config ---
MODEL="${OPENCLAW_MODEL:-anthropic/claude-sonnet-4-20250514}"

# Persistent gateway token - generate once, reuse on restarts
GW_TOKEN_FILE="${CONFIG_DIR}/.gw-token"
if [[ -f "${GW_TOKEN_FILE}" ]]; then
    GW_TOKEN=$(cat "${GW_TOKEN_FILE}")
else
    GW_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-$(tr -dc 'a-f0-9' < /dev/urandom | head -c 48)}"
    echo "${GW_TOKEN}" > "${GW_TOKEN_FILE}"
    chmod 600 "${GW_TOKEN_FILE}"
fi

WEBCHAT="${WEBCHAT_ENABLED:-true}"

# Build channels object from env vars
CHANNELS="{}"
if [[ -n "${DISCORD_TOKEN}" && -n "${DISCORD_CHANNEL}" ]]; then
    CHANNELS=$(DISCORD_TOKEN="${DISCORD_TOKEN}" DISCORD_CHANNEL="${DISCORD_CHANNEL}" node -e "
      const c=JSON.parse(require('fs').readFileSync(0,'utf8')||'{}');
      c.discord={botToken:process.env.DISCORD_TOKEN,channels:[{id:process.env.DISCORD_CHANNEL}]};
      console.log(JSON.stringify(c))" <<< "${CHANNELS}" 2>/dev/null || echo "${CHANNELS}")
fi

if [[ -n "${TELEGRAM_TOKEN}" && -n "${TELEGRAM_CHAT}" ]]; then
    CHANNELS=$(TELEGRAM_TOKEN="${TELEGRAM_TOKEN}" TELEGRAM_CHAT="${TELEGRAM_CHAT}" node -e "
      const c=JSON.parse(require('fs').readFileSync(0,'utf8')||'{}');
      c.telegram={botToken:process.env.TELEGRAM_TOKEN,chatId:process.env.TELEGRAM_CHAT};
      console.log(JSON.stringify(c))" <<< "${CHANNELS}" 2>/dev/null || echo "${CHANNELS}")
fi

INIT_MARKER="${CONFIG_DIR}/.initialized"
IS_FIRST_BOOT="false"
[[ ! -f "${INIT_MARKER}" ]] && IS_FIRST_BOOT="true"

if [[ ! -f "${INIT_MARKER}" ]]; then
    # ── First boot: write full config from env vars ──
    echo "📝 First boot — initializing OpenClaw configuration..."

    MODEL="${MODEL}" GW_TOKEN="${GW_TOKEN}" WORKSPACE="${WORKSPACE}" \
      TZ="${TZ:-America/New_York}" CHANNELS="${CHANNELS}" \
      node -e "
      const fs = require('fs');
      const channels = JSON.parse(process.env.CHANNELS || '{}');
      const cfg = {
        auth: { profiles: { 'anthropic:manual': { provider: 'anthropic', mode: 'token' } } },
        agents: { defaults: {
          model: { primary: process.env.MODEL },
          workspace: process.env.WORKSPACE,
          userTimezone: process.env.TZ
        }},
        gateway: {
          port: 18789, mode: 'local', bind: 'lan',
          auth: { mode: 'token', token: process.env.GW_TOKEN },
          controlUi: { dangerouslyDisableDeviceAuth: true, allowInsecureAuth: true },
          http: { endpoints: { chatCompletions: { enabled: true } } }
        },
        channels
      };
      fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2) + '\n');
    " "${CONFIG_DIR}/openclaw.json"

    # Remove any unrecognized config keys that would cause openclaw to reject the config
    su - clawd -c "openclaw doctor --fix" 2>/dev/null || true

    # Write auth-profiles.json (where the API key actually lives)
    mkdir -p "${CONFIG_DIR}/agents/main/agent"
    ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" node -e "
      const fs = require('fs');
      const prof = {
        version: 1,
        profiles: { 'anthropic:manual': { type: 'token', provider: 'anthropic', token: process.env.ANTHROPIC_API_KEY } },
        order: { anthropic: ['anthropic:manual'] }
      };
      fs.writeFileSync(process.argv[1], JSON.stringify(prof, null, 2) + '\n');
    " "${CONFIG_DIR}/agents/main/agent/auth-profiles.json"

    touch "${INIT_MARKER}"

else
    # ── Subsequent boot: merge env-driven values into existing config ──
    echo "📝 Restarting — merging env updates into existing config..."

    GW_TOKEN="${GW_TOKEN}" \
      node -e "
      const fs = require('fs');
      const p = process.argv[1];
      const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));

      // Model is NOT overwritten on subsequent boot — user may have changed it via portal/UI.
      // It is only seeded on first boot from OPENCLAW_MODEL env var.

      if (!cfg.agents) cfg.agents = {};

      // Ensure gateway auth token is current
      if (!cfg.gateway) cfg.gateway = {};
      if (!cfg.gateway.auth) cfg.gateway.auth = {};
      cfg.gateway.auth.token = process.env.GW_TOKEN;

      // Ensure http chatCompletions is enabled
      if (!cfg.gateway.http) cfg.gateway.http = {};
      if (!cfg.gateway.http.endpoints) cfg.gateway.http.endpoints = {};
      cfg.gateway.http.endpoints.chatCompletions = { enabled: true };

      // Channels are NOT merged on subsequent boot.
      // On-disk config is authoritative — user may have disconnected channels via portal.
      // Channels are only seeded on first boot from env vars.

      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
      console.log('   Config merged successfully');
    " "${CONFIG_DIR}/openclaw.json" || {
        echo "⚠️  Config merge failed — continuing with existing config" >&2
    }

    # Auth-profiles.json is NOT overwritten on subsequent boot.
    # OAuth flow writes tokens there and those are authoritative.
    # Only seeded on first boot from ANTHROPIC_API_KEY env var.
    AUTH_PROF="${CONFIG_DIR}/agents/main/agent/auth-profiles.json"
    if [[ -f "${AUTH_PROF}" ]]; then
        echo "   Auth profiles exist — skipping (OAuth tokens are authoritative)"
    else
        echo "   Auth profiles missing — recreating from env"
        mkdir -p "${CONFIG_DIR}/agents/main/agent"
        ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" node -e "
          const fs = require('fs');
          const prof = {
            version: 1,
            profiles: { 'anthropic:manual': { type: 'token', provider: 'anthropic', token: process.env.ANTHROPIC_API_KEY } },
            order: { anthropic: ['anthropic:manual'] }
          };
          fs.writeFileSync(process.argv[1], JSON.stringify(prof, null, 2) + '\n');
          console.log('   Auth profiles recreated from env');
        " "${AUTH_PROF}" || {
            echo "⚠️  Auth profile creation failed" >&2
        }
    fi
fi

# Generate device identity (required for webchat pairing/auth)
mkdir -p "${CONFIG_DIR}/identity"
if [[ ! -f "${CONFIG_DIR}/identity/device.json" ]]; then
    DEVICE_ID=$(tr -dc 'a-f0-9' < /dev/urandom | head -c 64)
    OPERATOR_TOKEN=$(tr -dc 'a-f0-9' < /dev/urandom | head -c 32)
    NOW_MS=$(date +%s%3N)

    # Generate ed25519 keypair for device identity
    PRIVKEY_FILE=$(mktemp)
    openssl genpkey -algorithm ed25519 -out "${PRIVKEY_FILE}" 2>/dev/null
    PUBKEY_PEM=$(openssl pkey -in "${PRIVKEY_FILE}" -pubout 2>/dev/null)
    PRIVKEY_PEM=$(cat "${PRIVKEY_FILE}")
    rm -f "${PRIVKEY_FILE}"

    cat > "${CONFIG_DIR}/identity/device.json" <<DEVID
{
  "version": 1,
  "deviceId": "${DEVICE_ID}",
  "publicKeyPem": $(echo "${PUBKEY_PEM}" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(d)))"),
  "privateKeyPem": $(echo "${PRIVKEY_PEM}" | node -e "process.stdin.resume();let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.stringify(d)))"),
  "createdAtMs": ${NOW_MS}
}
DEVID

    cat > "${CONFIG_DIR}/identity/device-auth.json" <<DEVAUTH
{
  "version": 1,
  "deviceId": "${DEVICE_ID}",
  "tokens": {
    "operator": {
      "token": "${OPERATOR_TOKEN}",
      "role": "operator",
      "scopes": [
        "operator.admin",
        "operator.approvals",
        "operator.pairing"
      ],
      "updatedAtMs": ${NOW_MS}
    }
  }
}
DEVAUTH

    echo "🔐 Device identity generated"
fi

# Create empty session file if missing
mkdir -p "${CONFIG_DIR}/agents/main/sessions"
[[ -f "${CONFIG_DIR}/agents/main/sessions/sessions.json" ]] || echo '{}' > "${CONFIG_DIR}/agents/main/sessions/sessions.json"

# Create empty devices files if missing
mkdir -p "${CONFIG_DIR}/devices"
[[ -f "${CONFIG_DIR}/devices/paired.json" ]] || echo '{}' > "${CONFIG_DIR}/devices/paired.json"
[[ -f "${CONFIG_DIR}/devices/pending.json" ]] || echo '{}' > "${CONFIG_DIR}/devices/pending.json"

chown -R clawd:clawd "${CONFIG_DIR}"
chmod 600 "${CONFIG_DIR}/openclaw.json" "${CONFIG_DIR}/agents/main/agent/auth-profiles.json"

# --- Discover and register sub-agents ---
echo "🔍 Discovering sub-agents..."

if [[ -d "${WORKSPACE}/agents" ]]; then
    IS_FIRST_BOOT="${IS_FIRST_BOOT}" MODEL="${MODEL}" WORKSPACE="${WORKSPACE}" CONFIG_DIR="${CONFIG_DIR}" node -e "
      const fs = require('fs');
      const path = require('path');
      const cfgPath = process.argv[1];
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      const workspace = process.env.WORKSPACE;
      const configDir = process.env.CONFIG_DIR;
      const model = process.env.MODEL;
      const isFirstBoot = process.env.IS_FIRST_BOOT === 'true';

      // Discover agent directories
      const agentsDir = path.join(workspace, 'agents');
      let agentNames = [];
      try {
        agentNames = fs.readdirSync(agentsDir).filter(name => {
          const stat = fs.statSync(path.join(agentsDir, name));
          return stat.isDirectory() && /^[a-zA-Z0-9-]+\$/.test(name);
        });
      } catch (e) {}

      if (agentNames.length === 0) {
        console.log('   No sub-agents found');
        process.exit(0);
      }

      if (!cfg.agents) cfg.agents = {};
      cfg.agents.skipBootstrap = true;

      if (isFirstBoot) {
        // First boot: full rebuild of agent list from scratch
        const list = [
          { id: 'main', default: true, workspace: workspace, model: { primary: model } }
        ];

        for (const name of agentNames) {
          list.push({
            id: name,
            workspace: path.join(workspace, 'agents', name),
            model: { primary: model }
          });
        }

        cfg.agents.list = list;
        console.log('   Registered agents: main, ' + agentNames.join(', '));
      } else {
        // Subsequent boot: additive only — discover NEW agents, preserve existing configs
        const existingList = cfg.agents.list || [];
        const existingIds = new Set(existingList.map(a => a.id));
        let added = [];

        // Ensure 'main' exists in the list (safety net)
        if (!existingIds.has('main')) {
          existingList.unshift({ id: 'main', default: true, workspace: workspace });
          existingIds.add('main');
        }

        for (const name of agentNames) {
          if (!existingIds.has(name)) {
            // New agent discovered — add it with current model as default
            existingList.push({
              id: name,
              workspace: path.join(workspace, 'agents', name),
              model: { primary: model }
            });
            added.push(name);
          }
          // Existing agents are NOT touched — preserves user customizations
        }

        cfg.agents.list = existingList;
        if (added.length > 0) {
          console.log('   New agents added: ' + added.join(', '));
        } else {
          console.log('   No new agents discovered');
        }
      }

      // Ensure config dirs, auth, and sessions exist for all agents (both boots)
      for (const name of agentNames) {
        const agentConfigDir = path.join(configDir, 'agents', name, 'agent');
        fs.mkdirSync(agentConfigDir, { recursive: true });

        const mainAuth = path.join(configDir, 'agents', 'main', 'agent', 'auth-profiles.json');
        const agentAuth = path.join(agentConfigDir, 'auth-profiles.json');
        if (fs.existsSync(mainAuth) && !fs.existsSync(agentAuth)) {
          // Only copy auth if sub-agent doesn't have its own yet
          fs.copyFileSync(mainAuth, agentAuth);
        }

        const sessionsDir = path.join(configDir, 'agents', name, 'sessions');
        fs.mkdirSync(sessionsDir, { recursive: true });
        const sessionsFile = path.join(sessionsDir, 'sessions.json');
        if (!fs.existsSync(sessionsFile)) {
          fs.writeFileSync(sessionsFile, '{}');
        }
      }

      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    " "${CONFIG_DIR}/openclaw.json" || {
        echo "⚠️  Agent discovery failed (non-fatal)" >&2
    }
else
    echo "   No agents directory found"
fi

chown -R clawd:clawd "${CONFIG_DIR}"

# Clean up any unrecognized config keys after agent discovery
su - clawd -c "openclaw doctor --fix" 2>/dev/null || true

# --- Set up VNC ---
VNC_ENABLED="${VNC_ENABLED:-true}"
if [[ "${VNC_ENABLED}" == "true" ]]; then
    echo "🖥️  Starting VNC server..."
    VNC_PASS="${VNC_PASSWORD:-$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 12)}"
    # Set VNC password and start server (non-fatal if it fails)
    printf '%s\n%s\nn\n' "${VNC_PASS}" "${VNC_PASS}" | su - clawd -c "/usr/bin/tigervncpasswd /home/clawd/.vnc/passwd" 2>/dev/null || \
      echo "⚠️  VNC password setup failed (non-fatal)"

    su - clawd -c "/usr/bin/tigervncserver ${VNC_DISPLAY} -geometry 1920x1080 -depth 24 -localhost no" 2>/dev/null && \
      echo "✅ VNC started on display ${VNC_DISPLAY}" || \
      echo "⚠️  VNC failed to start (non-fatal)"
else
    echo "🚫 VNC disabled via VNC_ENABLED=false"
fi


# --- Start OpenClaw ---
echo "🚀 Starting OpenClaw gateway..."
echo "   Workspace: ${WORKSPACE}"
echo "   Model: ${MODEL}"
echo "   Customer: ${CUSTOMER_ID:-unset}"

# Run as clawd user, stay in foreground
exec su - clawd -c "cd ${WORKSPACE} && /usr/local/bin/openclaw gateway"
