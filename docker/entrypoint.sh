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
echo "📝 Writing OpenClaw configuration..."

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

# Build channels object
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

# Write main config (no API key here — that goes in auth-profiles.json)
cat > "${CONFIG_DIR}/openclaw.json" <<CONF
{
  "auth": {
    "profiles": {
      "anthropic:manual": {
        "provider": "anthropic",
        "mode": "token"
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "${MODEL}"
      },
      "workspace": "${WORKSPACE}",
      "userTimezone": "${TZ:-America/New_York}"
    }
  },
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "lan",
    "auth": {
      "mode": "token",
      "token": "${GW_TOKEN}"
    },
    "controlUi": {
      "dangerouslyDisableDeviceAuth": true
    }
  },
  "channels": ${CHANNELS}
}
CONF

# Remove any unrecognized config keys that would cause openclaw to reject the config
su - clawd -c "openclaw doctor --fix" 2>/dev/null || true

# Write auth-profiles.json (where the API key actually lives)
mkdir -p "${CONFIG_DIR}/agents/main/agent"
cat > "${CONFIG_DIR}/agents/main/agent/auth-profiles.json" <<APROF
{
  "version": 1,
  "profiles": {
    "anthropic:manual": {
      "type": "token",
      "provider": "anthropic",
      "token": "${ANTHROPIC_API_KEY}"
    }
  },
  "order": {
    "anthropic": ["anthropic:manual"]
  }
}
APROF

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
