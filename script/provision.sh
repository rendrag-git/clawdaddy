#!/usr/bin/env bash
###############################################################################
# provision.sh - OpenClaw Lightsail Instance Provisioner
#
# Creates and provisions an AWS Lightsail instance with OpenClaw pre-installed.
# Generates user-data that drives install-openclaw.sh non-interactively.
#
# Usage:
#   bash provision.sh --email user@example.com --api-key sk-ant-... [OPTIONS]
#   bash provision.sh --email user@example.com --tier managed [OPTIONS]
#
# Required:
#   --email              Customer email address
#   --api-key            Anthropic API key (sk-ant-...) — required for byok, unused for managed
#
# Optional:
#   --tier               Tier: "byok" (default) or "managed"
#   --discord-token      Discord bot token
#   --discord-channel    Discord channel ID
#   --telegram-token     Telegram bot token
#   --telegram-chat      Telegram chat ID
#   --signal-phone       Signal phone number
#   --region             AWS region (default: us-east-1)
#   --stripe-customer-id Stripe customer ID (optional, persisted to customers.json)
#   --stripe-subscription-id Stripe subscription ID (optional, persisted to customers.json)
#   --stripe-checkout-session-id Stripe checkout session ID (optional, persisted to customers.json)
#
# Environment variables:
#   CUSTOMERS_FILE       Path to customers.json (default: ./customers.json)
#   INSTALL_SCRIPT_URL   URL to install-openclaw.sh
#   OPERATOR_API_KEY     Your Anthropic API key (required for managed tier)
#   PROXY_BUNDLE_URL     URL to download the API proxy tarball (required for managed tier)
#   REPORT_WEBHOOK_URL   Webhook URL for daily usage reporting (managed tier)
#   DEFAULT_BUDGET       Default monthly budget in USD (default: 40)
###############################################################################
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration defaults
# ---------------------------------------------------------------------------
CUSTOMERS_FILE="${CUSTOMERS_FILE:-./customers.json}"
INSTALL_SCRIPT_URL="${INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/openclaw/openclaw/main/install-openclaw.sh}"
PROXY_BUNDLE_URL="${PROXY_BUNDLE_URL:-}"
OPERATOR_API_KEY="${OPERATOR_API_KEY:-}"
REPORT_WEBHOOK_URL="${REPORT_WEBHOOK_URL:-}"
DISCORD_OPS_WEBHOOK_URL="${DISCORD_OPS_WEBHOOK_URL:-}"
DEFAULT_BUDGET="${DEFAULT_BUDGET:-40}"
HEALTH_PORT=8080
HEALTH_TIMEOUT=600    # 10 minutes
HEALTH_INTERVAL=15    # seconds
INSTANCE_TIMEOUT=300  # 5 minutes
INSTANCE_INTERVAL=10  # seconds

# ---------------------------------------------------------------------------
# Colors
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    CYAN='\033[0;36m'
    BOLD='\033[1m'
    DIM='\033[2m'
    RESET='\033[0m'
else
    RED='' GREEN='' YELLOW='' CYAN='' BOLD='' DIM='' RESET=''
fi

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
LOG_FILE="./provision-$(date +%Y%m%d-%H%M%S).log"

log() {
    local timestamp
    timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "[${timestamp}] $*" >> "${LOG_FILE}" 2>/dev/null || true
}

info()  { echo -e "${CYAN}[info]${RESET}  $*"; log "INFO  $*"; }
ok()    { echo -e "${GREEN}  [ok]${RESET}  $*"; log "OK    $*"; }
warn()  { echo -e "${YELLOW}[warn]${RESET}  $*"; log "WARN  $*"; }
fail()  { echo -e "${RED}[fail]${RESET}  $*"; log "ERROR $*"; }
die()   { fail "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Cleanup trap
# ---------------------------------------------------------------------------
CLEANUP_ACTIONS=()

cleanup() {
    local exit_code=$?
    if (( exit_code != 0 )); then
        fail "Provisioning failed (exit code ${exit_code})."
        info "Log file: ${LOG_FILE}"
    fi
    for action in "${CLEANUP_ACTIONS[@]:-}"; do
        eval "${action}" 2>/dev/null || true
    done
}

trap cleanup EXIT

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
ARG_EMAIL=""
ARG_API_KEY=""
ARG_TIER="byok"
ARG_DISCORD_TOKEN=""
ARG_DISCORD_CHANNEL=""
ARG_TELEGRAM_TOKEN=""
ARG_TELEGRAM_CHAT=""
ARG_SIGNAL_PHONE=""
ARG_REGION="us-east-1"
ARG_STRIPE_CUSTOMER_ID=""
ARG_STRIPE_SUBSCRIPTION_ID=""
ARG_STRIPE_CHECKOUT_SESSION_ID=""
ARG_USERNAME=""

usage() {
    cat <<EOF
${BOLD}Usage:${RESET}
  bash provision.sh --email EMAIL --api-key KEY [OPTIONS]
  bash provision.sh --email EMAIL --tier managed [OPTIONS]

${BOLD}Required:${RESET}
  --email              Customer email address
  --api-key            Anthropic API key (sk-ant-...) — required for byok tier

${BOLD}Optional:${RESET}
  --tier               Tier: "byok" (default) or "managed"
  --discord-token      Discord bot token
  --discord-channel    Discord channel ID
  --telegram-token     Telegram bot token
  --telegram-chat      Telegram chat ID
  --signal-phone       Signal phone number
  --region             AWS region (default: us-east-1)
  --stripe-customer-id Stripe customer ID (optional)
  --stripe-subscription-id Stripe subscription ID (optional)
  --stripe-checkout-session-id Stripe checkout session ID (optional)
  --username           Customer username for DNS and instance naming (3-20 chars, lowercase alphanumeric + hyphens)
  --help               Show this help message

${BOLD}Environment:${RESET}
  CUSTOMERS_FILE       Path to customers.json (default: ./customers.json)
  INSTALL_SCRIPT_URL   URL to install-openclaw.sh
  OPERATOR_API_KEY     Your Anthropic API key (required for managed tier)
  PROXY_BUNDLE_URL     URL to download the API proxy tarball (managed tier)
  REPORT_WEBHOOK_URL   Webhook URL for daily usage reporting (managed tier)
  DISCORD_OPS_WEBHOOK_URL  Discord webhook for ops notifications (managed tier)
  DEFAULT_BUDGET       Default monthly budget in USD (default: 40)
  SSH_KEY_DIR          Persistent directory for SSH keys (default: ~/.ssh/customer-keys/)
  ROUTE53_HOSTED_ZONE_ID  Route 53 hosted zone ID for clawdaddy.sh DNS
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --email)
                ARG_EMAIL="${2:?--email requires a value}"
                shift 2
                ;;
            --api-key)
                ARG_API_KEY="${2:?--api-key requires a value}"
                shift 2
                ;;
            --tier)
                ARG_TIER="${2:?--tier requires a value}"
                shift 2
                ;;
            --discord-token)
                ARG_DISCORD_TOKEN="${2:?--discord-token requires a value}"
                shift 2
                ;;
            --discord-channel)
                ARG_DISCORD_CHANNEL="${2:?--discord-channel requires a value}"
                shift 2
                ;;
            --telegram-token)
                ARG_TELEGRAM_TOKEN="${2:?--telegram-token requires a value}"
                shift 2
                ;;
            --telegram-chat)
                ARG_TELEGRAM_CHAT="${2:?--telegram-chat requires a value}"
                shift 2
                ;;
            --signal-phone)
                ARG_SIGNAL_PHONE="${2:?--signal-phone requires a value}"
                shift 2
                ;;
            --region)
                ARG_REGION="${2:?--region requires a value}"
                shift 2
                ;;
            --stripe-customer-id)
                ARG_STRIPE_CUSTOMER_ID="${2:?--stripe-customer-id requires a value}"
                shift 2
                ;;
            --stripe-subscription-id)
                ARG_STRIPE_SUBSCRIPTION_ID="${2:?--stripe-subscription-id requires a value}"
                shift 2
                ;;
            --stripe-checkout-session-id)
                ARG_STRIPE_CHECKOUT_SESSION_ID="${2:?--stripe-checkout-session-id requires a value}"
                shift 2
                ;;
            --username)
                ARG_USERNAME="${2:?--username requires a value}"
                shift 2
                ;;
            --help|-h)
                usage
                exit 0
                ;;
            *)
                die "Unknown option: $1. Use --help for usage."
                ;;
        esac
    done

    # Validate --tier
    if [[ "${ARG_TIER}" != "byok" && "${ARG_TIER}" != "managed" ]]; then
        die "Invalid --tier value '${ARG_TIER}'. Must be 'byok' or 'managed'."
    fi

    # Validate required args
    if [[ -z "${ARG_EMAIL}" ]]; then
        die "Missing required argument: --email"
    fi

    if [[ "${ARG_TIER}" == "byok" ]]; then
        # BYOK: require --api-key
        if [[ -z "${ARG_API_KEY}" ]]; then
            die "Missing required argument: --api-key (required for byok tier)"
        fi
        if [[ ! "${ARG_API_KEY}" =~ ^sk-ant- ]]; then
            die "Invalid API key format. Must start with 'sk-ant-'."
        fi
    else
        # Managed: require OPERATOR_API_KEY env var
        if [[ -z "${OPERATOR_API_KEY}" ]]; then
            die "OPERATOR_API_KEY environment variable is required for managed tier"
        fi
        if [[ -z "${PROXY_BUNDLE_URL}" ]]; then
            die "PROXY_BUNDLE_URL environment variable is required for managed tier"
        fi
    fi

    # Validate --username if provided
    if [[ -n "${ARG_USERNAME}" ]]; then
        if [[ ${#ARG_USERNAME} -lt 3 || ${#ARG_USERNAME} -gt 20 ]]; then
            die "--username must be 3-20 characters"
        fi
        if [[ ! "${ARG_USERNAME}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
            die "--username must be lowercase alphanumeric with hyphens, no leading/trailing hyphens"
        fi
    fi
}

# ---------------------------------------------------------------------------
# Dependency checks
# ---------------------------------------------------------------------------
check_dependencies() {
    info "Checking dependencies..."

    local missing=()
    for cmd in aws jq curl; do
        if ! command -v "${cmd}" > /dev/null 2>&1; then
            missing+=("${cmd}")
        fi
    done

    if (( ${#missing[@]} > 0 )); then
        die "Missing required commands: ${missing[*]}. Install them and retry."
    fi

    # Verify AWS credentials are configured
    if ! aws sts get-caller-identity > /dev/null 2>&1; then
        die "AWS credentials not configured. Run 'aws configure' first."
    fi

    ok "All dependencies available"
}

# ---------------------------------------------------------------------------
# ID and password generation
# ---------------------------------------------------------------------------
generate_customer_id() {
    local hex
    hex="$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')"
    echo "oc_${hex}"
}

generate_vnc_password() {
    tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 12 || true
}

# ---------------------------------------------------------------------------
# User-data script generation
# ---------------------------------------------------------------------------
generate_user_data() {
    local api_key="$1"
    local discord_token="$2"
    local discord_channel="$3"
    local telegram_token="$4"
    local telegram_chat="$5"
    local signal_phone="$6"
    local vnc_password="$7"
    local install_url="$8"
    local tier="${9:-byok}"
    local customer_id_val="${10:-}"
    local ssh_pub_key="${11:-}"

    cat <<'USERDATA_HEADER'
#!/usr/bin/env bash
set -euo pipefail

exec > /var/log/openclaw-userdata.log 2>&1
echo "=== OpenClaw user-data script started at $(date -Iseconds) ==="

# ---------------------------------------------------------------------------
# Export configuration for non-interactive install
# ---------------------------------------------------------------------------
export OPENCLAW_NONINTERACTIVE=1
USERDATA_HEADER

    # Emit the variable exports (these contain secrets so we use the runtime values)
    cat <<USERDATA_VARS
export CFG_ANTHROPIC_KEY='${api_key}'
export CFG_DISCORD_TOKEN='${discord_token}'
export CFG_DISCORD_CHANNEL='${discord_channel}'
export CFG_TELEGRAM_TOKEN='${telegram_token}'
export CFG_TELEGRAM_CHAT='${telegram_chat}'
export CFG_SIGNAL_PHONE='${signal_phone}'
export CFG_VNC_PASSWORD='${vnc_password}'
USERDATA_VARS

    if [[ -n "${ssh_pub_key}" ]]; then
        cat <<USERDATA_SSHKEY

# ---------------------------------------------------------------------------
# Add control plane SSH public key
# ---------------------------------------------------------------------------
mkdir -p /home/ubuntu/.ssh
chmod 700 /home/ubuntu/.ssh
echo '${ssh_pub_key}' >> /home/ubuntu/.ssh/authorized_keys
chmod 600 /home/ubuntu/.ssh/authorized_keys
chown -R ubuntu:ubuntu /home/ubuntu/.ssh
USERDATA_SSHKEY
    fi

    cat <<'USERDATA_BODY'

# ---------------------------------------------------------------------------
# Download install script
# ---------------------------------------------------------------------------
USERDATA_BODY

    cat <<USERDATA_URL
INSTALL_URL='${install_url}'
USERDATA_URL

    cat <<'USERDATA_INSTALL'
INSTALL_PATH="/tmp/install-openclaw.sh"

echo "Downloading install script from ${INSTALL_URL}..."
curl -fsSL "${INSTALL_URL}" -o "${INSTALL_PATH}"
chmod +x "${INSTALL_PATH}"

# ---------------------------------------------------------------------------
# Patch the install script for non-interactive mode
# ---------------------------------------------------------------------------
# Replace the prompt_value function: when OPENCLAW_NONINTERACTIVE=1,
# use the pre-exported CFG_ variable value instead of reading from stdin.
# The original prompt_value signature is:
#   prompt_value VARNAME "prompt text" "default" "required" "secret"
# We replace it so it reads from the environment variable matching VARNAME.
# ---------------------------------------------------------------------------
sed -i '/^prompt_value() {$/,/^}$/c\
prompt_value() {\
    local varname="$1"\
    local prompt_text="$2"\
    local default="${3:-}"\
    local required="${4:-false}"\
    local secret="${5:-false}"\
    if [[ "${OPENCLAW_NONINTERACTIVE:-0}" == "1" ]]; then\
        local env_val="${!varname:-${default}}"\
        if [[ "${required}" == "true" && -z "${env_val}" ]]; then\
            echo "ERROR: Required variable ${varname} is not set." >&2\
            exit 1\
        fi\
        eval "${varname}=\\x27${env_val}\\x27"\
        return 0\
    fi\
    local value\
    if [[ -n "${default}" ]]; then\
        prompt_text="${prompt_text} [${default}]"\
    fi\
    prompt_text="${prompt_text}: "\
    while true; do\
        if [[ "${secret}" == "true" ]]; then\
            read -r -s -p "$(echo -e "${prompt_text}")" value\
            echo ""\
        else\
            read -r -p "$(echo -e "${prompt_text}")" value\
        fi\
        value="${value:-${default}}"\
        if [[ "${required}" == "true" && -z "${value}" ]]; then\
            echo "This field is required. Please enter a value." >&2\
            continue\
        fi\
        break\
    done\
    eval "${varname}=\\x27${value}\\x27"\
}' "${INSTALL_PATH}"

# Replace the confirm function to always return true in non-interactive mode
sed -i '/^confirm() {$/,/^}$/c\
confirm() {\
    if [[ "${OPENCLAW_NONINTERACTIVE:-0}" == "1" ]]; then\
        return 0\
    fi\
    local prompt="$1"\
    local default="${2:-y}"\
    local answer\
    if [[ "${default}" == "y" ]]; then\
        prompt="${prompt} [Y/n]: "\
    else\
        prompt="${prompt} [y/N]: "\
    fi\
    read -r -p "$(echo -e "${prompt}")" answer\
    answer="${answer:-${default}}"\
    [[ "${answer}" =~ ^[Yy]$ ]]\
}' "${INSTALL_PATH}"

# ---------------------------------------------------------------------------
# Set up a health check endpoint (simple Node.js HTTP server on port 8080)
# This will be started after installation completes.
# ---------------------------------------------------------------------------
HEALTH_SCRIPT="/opt/openclaw-health.js"
cat > "${HEALTH_SCRIPT}" <<'HEALTHEOF'
const http = require("http");
const { execSync } = require("child_process");

const server = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
        let serviceActive = false;
        try {
            execSync("systemctl is-active --quiet openclaw", { timeout: 5000 });
            serviceActive = true;
        } catch (_) {
            serviceActive = false;
        }
        const status = serviceActive ? "ok" : "starting";
        const code = serviceActive ? 200 : 503;
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status, timestamp: new Date().toISOString() }));
    } else {
        res.writeHead(404);
        res.end("Not Found");
    }
});

server.listen(8080, "0.0.0.0", () => {
    console.log("Health check server listening on port 8080");
});
HEALTHEOF

# Create systemd unit for health check
cat > /etc/systemd/system/openclaw-health.service <<'HEALTHSVCEOF'
[Unit]
Description=OpenClaw Health Check Endpoint
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/openclaw-health.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
HEALTHSVCEOF

# ---------------------------------------------------------------------------
# Allow health check port through UFW
# ---------------------------------------------------------------------------
ufw allow 8080/tcp 2>/dev/null || true

# ---------------------------------------------------------------------------
# Run the install script
# ---------------------------------------------------------------------------
echo "Running install script..."
bash "${INSTALL_PATH}"

USERDATA_INSTALL

    # -- Managed tier: install API proxy --
    if [[ "${tier}" == "managed" ]]; then
        local operator_key="${OPERATOR_API_KEY}"
        local proxy_bundle="${PROXY_BUNDLE_URL}"
        local budget="${DEFAULT_BUDGET}"
        local billing_day
        billing_day="$(date +%-d)"
        local customer_id_val
        # Extract customer_id from the install_url or pass it through
        # We'll use a dedicated variable passed via the user-data
        customer_id_val="${10:-unknown}"
        local ops_webhook="${DISCORD_OPS_WEBHOOK_URL}"
        local report_webhook="${REPORT_WEBHOOK_URL}"

        cat <<USERDATA_PROXY

# ---------------------------------------------------------------------------
# Managed Tier: Install API Proxy
# ---------------------------------------------------------------------------
echo "Installing API proxy for managed tier..."

mkdir -p /opt/openclaw-proxy
mkdir -p /var/lib/openclaw-proxy

echo "Downloading proxy bundle from ${proxy_bundle}..."
curl -fsSL '${proxy_bundle}' -o /tmp/openclaw-proxy.tar.gz
tar -xzf /tmp/openclaw-proxy.tar.gz -C /opt/openclaw-proxy --strip-components=1
rm -f /tmp/openclaw-proxy.tar.gz

cd /opt/openclaw-proxy
npm install --production

# Write proxy environment configuration
cat > /opt/openclaw-proxy/.env <<'PROXYENVEOF'
ANTHROPIC_API_KEY=${operator_key}
PROXY_PORT=3141
BUDGET_LIMIT=${budget}
BILLING_CYCLE_START=${billing_day}
CUSTOMER_ID=${customer_id_val}
DISCORD_OPS_WEBHOOK_URL=${ops_webhook}
REPORT_WEBHOOK_URL=${report_webhook}
PROXYENVEOF

# Create systemd service for the proxy
cat > /etc/systemd/system/openclaw-proxy.service <<'PROXYSVCEOF'
[Unit]
Description=OpenClaw API Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/openclaw-proxy
ExecStart=/usr/bin/node /opt/openclaw-proxy/proxy.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/openclaw-proxy/.env

[Install]
WantedBy=multi-user.target
PROXYSVCEOF

systemctl daemon-reload
systemctl enable openclaw-proxy
systemctl start openclaw-proxy

# ---------------------------------------------------------------------------
# Managed Tier: Point OpenClaw to the local proxy
# ---------------------------------------------------------------------------
echo "Configuring OpenClaw to use local API proxy..."
OPENCLAW_ENV="/opt/openclaw/openclaw.env"
if [[ -f "\${OPENCLAW_ENV}" ]]; then
    echo "ANTHROPIC_BASE_URL=http://localhost:3141" >> "\${OPENCLAW_ENV}"
fi

# Override the API key to a placeholder (proxy handles the real key)
sed -i 's|^CFG_ANTHROPIC_KEY=.*|CFG_ANTHROPIC_KEY=sk-ant-proxy-managed|' "\${OPENCLAW_ENV}" 2>/dev/null || true

# Restart OpenClaw to pick up proxy config
systemctl restart openclaw 2>/dev/null || true

echo "API proxy installed and configured."
USERDATA_PROXY
    fi

    cat <<'USERDATA_TAIL'

# ---------------------------------------------------------------------------
# Start health check endpoint (Node.js should be available after install)
# ---------------------------------------------------------------------------
systemctl daemon-reload
systemctl enable openclaw-health
systemctl start openclaw-health

echo "=== OpenClaw user-data script completed at $(date -Iseconds) ==="
USERDATA_TAIL
}

# ---------------------------------------------------------------------------
# Initialize customers.json if it doesn't exist
# ---------------------------------------------------------------------------
init_customers_file() {
    if [[ ! -f "${CUSTOMERS_FILE}" ]]; then
        info "Creating ${CUSTOMERS_FILE}..."
        echo '{"customers":[]}' | jq '.' > "${CUSTOMERS_FILE}"
        ok "Initialized ${CUSTOMERS_FILE}"
    fi
}

# ---------------------------------------------------------------------------
# Add customer record to customers.json
# ---------------------------------------------------------------------------
add_customer_record() {
    local customer_id="$1"
    local email="$2"
    local instance_name="$3"
    local static_ip="${4:-}"
    local static_ip_name="${5:-}"
    local region="$6"
    local vnc_password="$7"
    local status="$8"
    local tier="${9:-byok}"
    local budget_limit="${10:-}"
    local model_tier="${11:-}"
    local stripe_customer_id="${12:-}"
    local stripe_subscription_id="${13:-}"
    local stripe_checkout_session_id="${14:-}"
    local username="${15:-}"

    local now
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    local tmp_file
    tmp_file="$(mktemp)"

    jq --arg id "${customer_id}" \
       --arg email "${email}" \
       --arg instance "${instance_name}" \
       --arg ip "${static_ip}" \
       --arg ip_name "${static_ip_name}" \
       --arg region "${region}" \
       --arg vnc "${vnc_password}" \
       --arg status "${status}" \
       --arg tier "${tier}" \
       --arg budget "${budget_limit}" \
       --arg model "${model_tier}" \
       --arg stripe_customer "${stripe_customer_id}" \
       --arg stripe_subscription "${stripe_subscription_id}" \
       --arg stripe_checkout "${stripe_checkout_session_id}" \
       --arg username "${username}" \
       --arg now "${now}" \
       '.customers += [{
            id: $id,
            email: $email,
            stripe_customer_id: $stripe_customer,
            stripe_subscription_id: $stripe_subscription,
            stripe_checkout_session_id: $stripe_checkout,
            instance_id: $instance,
            static_ip: $ip,
            static_ip_name: $ip_name,
            region: $region,
            vnc_password: $vnc,
            status: $status,
            tier: $tier,
            budget_limit: (if $budget == "" then null else ($budget | tonumber) end),
            model_tier: (if $model == "" then null else $model end),
            created_at: $now,
            updated_at: $now,
            destroy_scheduled_at: null,
            username: (if $username == "" then null else $username end)
        }]' "${CUSTOMERS_FILE}" > "${tmp_file}"

    mv "${tmp_file}" "${CUSTOMERS_FILE}"
    log "Added customer record: ${customer_id} (tier: ${tier}, status: ${status})"
}

# ---------------------------------------------------------------------------
# Update customer status in customers.json
# ---------------------------------------------------------------------------
update_customer_status() {
    local customer_id="$1"
    local new_status="$2"
    local static_ip="${3:-}"

    local now
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    local tmp_file
    tmp_file="$(mktemp)"

    if [[ -n "${static_ip}" ]]; then
        jq --arg id "${customer_id}" \
           --arg status "${new_status}" \
           --arg ip "${static_ip}" \
           --arg now "${now}" \
           '(.customers[] | select(.id == $id)) |= (
                .status = $status |
                .static_ip = $ip |
                .updated_at = $now
            )' "${CUSTOMERS_FILE}" > "${tmp_file}"
    else
        jq --arg id "${customer_id}" \
           --arg status "${new_status}" \
           --arg now "${now}" \
           '(.customers[] | select(.id == $id)) |= (
                .status = $status |
                .updated_at = $now
            )' "${CUSTOMERS_FILE}" > "${tmp_file}"
    fi

    mv "${tmp_file}" "${CUSTOMERS_FILE}"
    log "Updated customer ${customer_id} status to ${new_status}"
}

# ---------------------------------------------------------------------------
# Wait for instance to be running
# ---------------------------------------------------------------------------
wait_for_instance() {
    local instance_name="$1"
    local elapsed=0

    info "Waiting for instance '${instance_name}' to reach 'running' state..."

    while (( elapsed < INSTANCE_TIMEOUT )); do
        local state
        state="$(aws lightsail get-instance \
            --instance-name "${instance_name}" \
            --query 'instance.state.name' \
            --output text 2>/dev/null || echo "unknown")"

        if [[ "${state}" == "running" ]]; then
            ok "Instance is running (${elapsed}s elapsed)"
            return 0
        fi

        log "Instance state: ${state} (${elapsed}s elapsed)"
        printf "\r  ${DIM}Instance state: %-12s (%ds / %ds)${RESET}" \
            "${state}" "${elapsed}" "${INSTANCE_TIMEOUT}"

        sleep "${INSTANCE_INTERVAL}"
        elapsed=$(( elapsed + INSTANCE_INTERVAL ))
    done

    printf "\n"
    fail "Instance did not reach 'running' state within ${INSTANCE_TIMEOUT}s"
    return 1
}

# ---------------------------------------------------------------------------
# Wait for health endpoint
# ---------------------------------------------------------------------------
wait_for_health() {
    local ip="$1"
    local elapsed=0

    info "Polling health endpoint at http://${ip}:${HEALTH_PORT}/health ..."

    while (( elapsed < HEALTH_TIMEOUT )); do
        local http_code
        http_code="$(curl -sf -o /dev/null -w '%{http_code}' \
            --connect-timeout 5 --max-time 10 \
            "http://${ip}:${HEALTH_PORT}/health" 2>/dev/null || echo "000")"

        if [[ "${http_code}" == "200" ]]; then
            printf "\n"
            ok "Health check passed (${elapsed}s elapsed)"
            return 0
        fi

        log "Health check: HTTP ${http_code} (${elapsed}s elapsed)"
        printf "\r  ${DIM}Health check: HTTP %-4s (%ds / %ds)${RESET}" \
            "${http_code}" "${elapsed}" "${HEALTH_TIMEOUT}"

        sleep "${HEALTH_INTERVAL}"
        elapsed=$(( elapsed + HEALTH_INTERVAL ))
    done

    printf "\n"
    fail "Health check did not pass within ${HEALTH_TIMEOUT}s"
    return 1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    parse_args "$@"

    echo ""
    echo -e "${BOLD}  OpenClaw Lightsail Provisioner${RESET}"
    echo -e "${DIM}  $(date)${RESET}"
    echo ""

    log "=== Provisioning started ==="
    log "Email: ${ARG_EMAIL}"
    log "Tier: ${ARG_TIER}"
    log "Region: ${ARG_REGION}"

    check_dependencies
    init_customers_file

    # Generate unique identifiers
    local customer_id
    customer_id="$(generate_customer_id)"
    local vnc_password
    vnc_password="$(generate_vnc_password)"
    local instance_name="openclaw-${ARG_USERNAME:-${customer_id}}"
    local static_ip_name="ip-openclaw-${ARG_USERNAME:-${customer_id}}"

    # ------------------------------------------------------------------
    # Step 0b: Generate SSH keypair for control plane access
    # ------------------------------------------------------------------
    local ssh_key_path=""
    if [[ -n "${ARG_USERNAME}" ]]; then
        local key_dir="${SSH_KEY_DIR:-${HOME}/.ssh/customer-keys}"
        mkdir -p "${key_dir}" && chmod 700 "${key_dir}"
        ssh_key_path="${key_dir}/openclaw-${ARG_USERNAME}"
        if [[ -f "${ssh_key_path}" ]]; then
            local backup="${ssh_key_path}.$(date +%s).bak"
            warn "SSH key already exists, backing up to ${backup}"
            mv "${ssh_key_path}" "${backup}"
            mv "${ssh_key_path}.pub" "${backup}.pub" 2>/dev/null || true
        fi
        ssh-keygen -t ed25519 -f "${ssh_key_path}" -N "" -C "openclaw-${ARG_USERNAME}" >> "${LOG_FILE}" 2>&1
        chmod 600 "${ssh_key_path}"
        ok "SSH keypair generated: ${ssh_key_path}"
    fi

    info "Customer ID:   ${customer_id}"
    info "Instance name: ${instance_name}"
    info "Tier:          ${ARG_TIER}"
    info "Region:        ${ARG_REGION}"
    echo ""

    # ------------------------------------------------------------------
    # Step 1: Generate user-data
    # ------------------------------------------------------------------
    info "Generating user-data script..."
    local userdata_file
    userdata_file="$(mktemp)"
    CLEANUP_ACTIONS+=("rm -f '${userdata_file}'")

    # For managed tier, use a placeholder API key (the proxy handles the real key)
    local effective_api_key="${ARG_API_KEY}"
    if [[ "${ARG_TIER}" == "managed" ]]; then
        effective_api_key="sk-ant-proxy-managed"
    fi

    local ssh_pub_key_contents=""
    if [[ -n "${ssh_key_path}" && -f "${ssh_key_path}.pub" ]]; then
        ssh_pub_key_contents="$(cat "${ssh_key_path}.pub")"
    fi

    generate_user_data \
        "${effective_api_key}" \
        "${ARG_DISCORD_TOKEN}" \
        "${ARG_DISCORD_CHANNEL}" \
        "${ARG_TELEGRAM_TOKEN}" \
        "${ARG_TELEGRAM_CHAT}" \
        "${ARG_SIGNAL_PHONE}" \
        "${vnc_password}" \
        "${INSTALL_SCRIPT_URL}" \
        "${ARG_TIER}" \
        "${customer_id}" \
        "${ssh_pub_key_contents}" \
        > "${userdata_file}"

    ok "User-data script generated ($(wc -c < "${userdata_file}") bytes)"

    # ------------------------------------------------------------------
    # Step 2: Create Lightsail instance
    # ------------------------------------------------------------------
    echo "STAGE=creating_instance"
    info "Creating Lightsail instance..."

    if ! aws lightsail create-instances \
        --instance-names "${instance_name}" \
        --availability-zone "${ARG_REGION}a" \
        --blueprint-id "ubuntu_24_04" \
        --bundle-id "nano_3_0" \
        --user-data "file://${userdata_file}" \
        --region "${ARG_REGION}" \
        >> "${LOG_FILE}" 2>&1; then
        # Add failed record
        local budget_val=""
        [[ "${ARG_TIER}" == "managed" ]] && budget_val="${DEFAULT_BUDGET}"
        local model_val=""
        [[ "${ARG_TIER}" == "managed" ]] && model_val="sonnet"
        add_customer_record \
            "${customer_id}" "${ARG_EMAIL}" "${instance_name}" \
            "" "${static_ip_name}" "${ARG_REGION}" "${vnc_password}" "failed" \
            "${ARG_TIER}" "${budget_val}" "${model_val}" \
            "${ARG_STRIPE_CUSTOMER_ID}" "${ARG_STRIPE_SUBSCRIPTION_ID}" "${ARG_STRIPE_CHECKOUT_SESSION_ID}" \
            "${ARG_USERNAME}"
        die "Failed to create Lightsail instance. Check ${LOG_FILE} for details."
    fi

    ok "Instance creation initiated"

    # Add provisioning record immediately
    local budget_val=""
    [[ "${ARG_TIER}" == "managed" ]] && budget_val="${DEFAULT_BUDGET}"
    local model_val=""
    [[ "${ARG_TIER}" == "managed" ]] && model_val="sonnet"
    add_customer_record \
        "${customer_id}" "${ARG_EMAIL}" "${instance_name}" \
        "" "${static_ip_name}" "${ARG_REGION}" "${vnc_password}" "provisioning" \
        "${ARG_TIER}" "${budget_val}" "${model_val}" \
        "${ARG_STRIPE_CUSTOMER_ID}" "${ARG_STRIPE_SUBSCRIPTION_ID}" "${ARG_STRIPE_CHECKOUT_SESSION_ID}" \
        "${ARG_USERNAME}"

    # ------------------------------------------------------------------
    # Step 3: Wait for instance to be running
    # ------------------------------------------------------------------
    echo "STAGE=waiting_for_instance"
    if ! wait_for_instance "${instance_name}"; then
        update_customer_status "${customer_id}" "failed"
        die "Instance failed to start."
    fi

    # ------------------------------------------------------------------
    # Step 4: Allocate and attach static IP
    # ------------------------------------------------------------------
    echo "STAGE=allocating_ip"
    info "Allocating static IP '${static_ip_name}'..."

    if ! aws lightsail allocate-static-ip \
        --static-ip-name "${static_ip_name}" \
        --region "${ARG_REGION}" \
        >> "${LOG_FILE}" 2>&1; then
        update_customer_status "${customer_id}" "failed"
        die "Failed to allocate static IP."
    fi

    ok "Static IP allocated"

    info "Attaching static IP to instance..."

    if ! aws lightsail attach-static-ip \
        --static-ip-name "${static_ip_name}" \
        --instance-name "${instance_name}" \
        --region "${ARG_REGION}" \
        >> "${LOG_FILE}" 2>&1; then
        update_customer_status "${customer_id}" "failed"
        die "Failed to attach static IP."
    fi

    ok "Static IP attached"

    # Retrieve the actual IP address
    local static_ip
    static_ip="$(aws lightsail get-static-ip \
        --static-ip-name "${static_ip_name}" \
        --query 'staticIp.ipAddress' \
        --output text \
        --region "${ARG_REGION}" 2>/dev/null)"

    ok "Static IP: ${static_ip}"

    # Update record with IP
    update_customer_status "${customer_id}" "provisioning" "${static_ip}"

    # ------------------------------------------------------------------
    # Step 4b: Create DNS record
    # ------------------------------------------------------------------
    local dns_created="false"
    if [[ -n "${ARG_USERNAME}" && -n "${ROUTE53_HOSTED_ZONE_ID:-}" ]]; then
        echo "STAGE=creating_dns"
        info "Creating DNS record: ${ARG_USERNAME}.clawdaddy.sh -> ${static_ip}"

        local dns_change
        dns_change="$(cat <<DNSEOF
{
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "${ARG_USERNAME}.clawdaddy.sh",
      "Type": "A",
      "TTL": 300,
      "ResourceRecords": [{"Value": "${static_ip}"}]
    }
  }]
}
DNSEOF
)"

        if aws route53 change-resource-record-sets \
            --hosted-zone-id "${ROUTE53_HOSTED_ZONE_ID}" \
            --change-batch "${dns_change}" \
            >> "${LOG_FILE}" 2>&1; then
            ok "DNS record created: ${ARG_USERNAME}.clawdaddy.sh"
            dns_created="true"
        else
            warn "DNS record creation failed (non-fatal)"
        fi
    elif [[ -n "${ARG_USERNAME}" && -z "${ROUTE53_HOSTED_ZONE_ID:-}" ]]; then
        warn "ROUTE53_HOSTED_ZONE_ID not set, skipping DNS record creation"
    fi

    # ------------------------------------------------------------------
    # Step 5: Open required ports in Lightsail firewall
    # ------------------------------------------------------------------
    echo "STAGE=configuring_firewall"
    info "Configuring Lightsail firewall ports..."

    aws lightsail put-instance-public-ports \
        --instance-name "${instance_name}" \
        --port-infos \
            "fromPort=22,toPort=22,protocol=tcp" \
            "fromPort=5901,toPort=5901,protocol=tcp" \
            "fromPort=${HEALTH_PORT},toPort=${HEALTH_PORT},protocol=tcp" \
        --region "${ARG_REGION}" \
        >> "${LOG_FILE}" 2>&1 || warn "Could not configure firewall ports (non-fatal)"

    ok "Firewall ports configured"
    echo ""

    # ------------------------------------------------------------------
    # Step 6: Wait for health endpoint
    # ------------------------------------------------------------------
    echo "STAGE=waiting_for_health"
    if wait_for_health "${static_ip}"; then
        update_customer_status "${customer_id}" "active"

        echo ""
        echo -e "${BOLD}========================================================${RESET}"
        echo -e "${GREEN}  Provisioning Complete${RESET}"
        echo -e "${BOLD}========================================================${RESET}"
        echo ""
        echo -e "  ${BOLD}Customer ID:${RESET}    ${customer_id}"
        echo -e "  ${BOLD}Email:${RESET}          ${ARG_EMAIL}"
        echo -e "  ${BOLD}Tier:${RESET}           ${ARG_TIER}"
        echo -e "  ${BOLD}Instance:${RESET}       ${instance_name}"
        echo -e "  ${BOLD}Region:${RESET}         ${ARG_REGION}"
        echo -e "  ${BOLD}Static IP:${RESET}      ${static_ip}"
        echo -e "  ${BOLD}VNC:${RESET}            ${static_ip}:5901"
        echo -e "  ${BOLD}VNC Password:${RESET}   ${vnc_password}"
        echo -e "  ${BOLD}Status:${RESET}         ${GREEN}active${RESET}"
        echo ""
        echo -e "  ${DIM}Customer record saved to ${CUSTOMERS_FILE}${RESET}"
        echo ""

        # Machine-readable output for automated callers (webhook provisioner)
        echo "CUSTOMER_ID=${customer_id}"
        echo "SERVER_IP=${static_ip}"
        echo "VNC_PASSWORD=${vnc_password}"
        echo "TIER=${ARG_TIER}"
        if [[ -n "${ARG_USERNAME}" ]]; then
            echo "USERNAME=${ARG_USERNAME}"
        fi
        if [[ -n "${ssh_key_path}" ]]; then
            echo "SSH_KEY_PATH=${ssh_key_path}"
        fi
        if [[ "${dns_created}" == "true" ]]; then
            echo "DNS_HOSTNAME=${ARG_USERNAME}.clawdaddy.sh"
        fi

        log "Provisioning completed successfully for ${customer_id}"
    else
        update_customer_status "${customer_id}" "failed"

        echo ""
        echo -e "${BOLD}========================================================${RESET}"
        echo -e "${RED}  Provisioning Failed${RESET}"
        echo -e "${BOLD}========================================================${RESET}"
        echo ""
        echo -e "  ${BOLD}Customer ID:${RESET}    ${customer_id}"
        echo -e "  ${BOLD}Instance:${RESET}       ${instance_name}"
        echo -e "  ${BOLD}Static IP:${RESET}      ${static_ip}"
        echo -e "  ${BOLD}Status:${RESET}         ${RED}failed${RESET}"
        echo ""
        echo -e "  The instance was created but the health check did not pass."
        echo -e "  SSH into the instance to debug:"
        echo -e "    ${CYAN}ssh ubuntu@${static_ip}${RESET}"
        echo -e "    ${CYAN}cat /var/log/openclaw-userdata.log${RESET}"
        echo -e "    ${CYAN}cat /var/log/openclaw-install.log${RESET}"
        echo ""
        echo -e "  ${DIM}Customer record saved to ${CUSTOMERS_FILE} with status 'failed'${RESET}"
        echo ""

        log "Provisioning failed for ${customer_id} - health check timeout"
        exit 1
    fi
}

main "$@"
