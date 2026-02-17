#!/usr/bin/env bash
###############################################################################
# provision-ec2.sh - OpenClaw EC2 Instance Provisioner
#
# EC2 equivalent of provision.sh (Lightsail). Creates a t3.micro instance
# with OpenClaw pre-installed via user-data. Uses the clawdaddy AWS profile.
#
# Usage:
#   bash provision-ec2.sh --email user@example.com --api-key sk-ant-... [OPTIONS]
#
# Required:
#   --email              Customer email address
#   --api-key            Anthropic API key (sk-ant-...)
#
# Optional:
#   --tier               Tier: "byok" (default) or "managed"
#   --username           Customer username (for subdomain routing)
#   --discord-token      Discord bot token
#   --discord-channel    Discord channel ID
#   --telegram-token     Telegram bot token
#   --telegram-chat      Telegram chat ID
#   --signal-phone       Signal phone number
#   --region             AWS region (default: us-east-1)
#   --instance-type      EC2 instance type (default: t3.micro)
#   --stripe-customer-id Stripe customer ID
#   --stripe-subscription-id Stripe subscription ID
#
# Environment variables:
#   AWS_PROFILE          AWS profile (default: clawdaddy)
#   CUSTOMERS_FILE       Path to customers.json (default: ./customers.json)
#   INSTALL_SCRIPT_URL   URL to install-openclaw.sh
#   CONTROL_PLANE_IP     Control plane IP for SSH-only firewall rule
#   CONTROL_PLANE_KEY    Path to SSH private key for provisioned instances
###############################################################################
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration defaults
# ---------------------------------------------------------------------------
AWS_PROFILE="${AWS_PROFILE:-clawdaddy}"
CUSTOMERS_FILE="${CUSTOMERS_FILE:-./customers.json}"
INSTALL_SCRIPT_URL="${INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/openclaw/openclaw/main/install-openclaw.sh}"
PORTAL_BUNDLE_URL="${PORTAL_BUNDLE_URL:-https://clawdaddy-releases.s3.amazonaws.com/portal-v1.tar.gz}"
CONTROL_PLANE_IP="${CONTROL_PLANE_IP:-3.230.7.207}"
CONTROL_PLANE_KEY="${CONTROL_PLANE_KEY:-/home/ubuntu/.ssh/clawdaddy-control}"

# EC2 defaults
DEFAULT_INSTANCE_TYPE="t3.micro"
DEFAULT_AMI=""  # auto-detected
SECURITY_GROUP_NAME="clawdaddy-customer-sg"
KEY_PAIR_NAME="clawdaddy-control"  # reuse control plane key for SSH access

HEALTH_PORT=8080
HEALTH_TIMEOUT=600
HEALTH_INTERVAL=15
INSTANCE_TIMEOUT=300
INSTANCE_INTERVAL=10

# ---------------------------------------------------------------------------
# Colors & Logging
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
    RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m'
    CYAN='\033[0;36m' BOLD='\033[1m' DIM='\033[2m' RESET='\033[0m'
else
    RED='' GREEN='' YELLOW='' CYAN='' BOLD='' DIM='' RESET=''
fi

LOG_FILE="./provision-$(date +%Y%m%d-%H%M%S).log"
log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "${LOG_FILE}" 2>/dev/null || true; }
info() { echo -e "${CYAN}[info]${RESET}  $*"; log "INFO  $*"; }
ok()   { echo -e "${GREEN}  [ok]${RESET}  $*"; log "OK    $*"; }
warn() { echo -e "${YELLOW}[warn]${RESET}  $*"; log "WARN  $*"; }
fail() { echo -e "${RED}[fail]${RESET}  $*"; log "ERROR $*"; }
die()  { fail "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
ARG_EMAIL="" ARG_API_KEY="" ARG_TIER="byok" ARG_USERNAME=""
ARG_DISCORD_TOKEN="" ARG_DISCORD_CHANNEL=""
ARG_TELEGRAM_TOKEN="" ARG_TELEGRAM_CHAT="" ARG_SIGNAL_PHONE=""
ARG_REGION="us-east-1" ARG_INSTANCE_TYPE="${DEFAULT_INSTANCE_TYPE}"
ARG_STRIPE_CUSTOMER_ID="" ARG_STRIPE_SUBSCRIPTION_ID=""

usage() {
    echo "Usage: provision-ec2.sh --email EMAIL --api-key KEY [--username USER] [--tier byok|managed] [OPTIONS]"
    echo "Run with --email and --api-key to provision a new customer instance."
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --email)            ARG_EMAIL="${2:?}"; shift 2 ;;
            --api-key)          ARG_API_KEY="${2:?}"; shift 2 ;;
            --tier)             ARG_TIER="${2:?}"; shift 2 ;;
            --username)         ARG_USERNAME="${2:?}"; shift 2 ;;
            --discord-token)    ARG_DISCORD_TOKEN="${2:?}"; shift 2 ;;
            --discord-channel)  ARG_DISCORD_CHANNEL="${2:?}"; shift 2 ;;
            --telegram-token)   ARG_TELEGRAM_TOKEN="${2:?}"; shift 2 ;;
            --telegram-chat)    ARG_TELEGRAM_CHAT="${2:?}"; shift 2 ;;
            --signal-phone)     ARG_SIGNAL_PHONE="${2:?}"; shift 2 ;;
            --region)           ARG_REGION="${2:?}"; shift 2 ;;
            --instance-type)    ARG_INSTANCE_TYPE="${2:?}"; shift 2 ;;
            --stripe-customer-id)       ARG_STRIPE_CUSTOMER_ID="${2:?}"; shift 2 ;;
            --stripe-subscription-id)   ARG_STRIPE_SUBSCRIPTION_ID="${2:?}"; shift 2 ;;
            --help|-h) usage; exit 0 ;;
            *) die "Unknown option: $1" ;;
        esac
    done

    [[ -n "${ARG_EMAIL}" ]] || die "Missing --email"
    if [[ "${ARG_TIER}" == "byok" ]]; then
        [[ -n "${ARG_API_KEY}" ]] || die "Missing --api-key (required for byok tier)"
    fi
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
generate_customer_id() {
    echo "oc_$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')"
}

generate_vnc_password() {
    tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 12 || true
}

# ---------------------------------------------------------------------------
# Get or create customer security group (SSH from control plane only + 443)
# ---------------------------------------------------------------------------
ensure_security_group() {
    local vpc_id sg_id

    vpc_id=$(aws ec2 describe-vpcs --profile "${AWS_PROFILE}" --region "${ARG_REGION}" \
        --filters "Name=is-default,Values=true" --query 'Vpcs[0].VpcId' --output text)

    # Check if SG already exists
    sg_id=$(aws ec2 describe-security-groups --profile "${AWS_PROFILE}" --region "${ARG_REGION}" \
        --filters "Name=group-name,Values=${SECURITY_GROUP_NAME}" "Name=vpc-id,Values=${vpc_id}" \
        --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")

    if [[ "${sg_id}" == "None" || -z "${sg_id}" ]]; then
        info "Creating customer security group..."
        sg_id=$(aws ec2 create-security-group --profile "${AWS_PROFILE}" --region "${ARG_REGION}" \
            --group-name "${SECURITY_GROUP_NAME}" \
            --description "ClawDaddy customer instances - SSH from control plane, HTTPS public" \
            --vpc-id "${vpc_id}" \
            --tag-specifications 'ResourceType=security-group,Tags=[{Key=project,Value=clawdaddy},{Key=Name,Value=clawdaddy-customer-sg}]' \
            --query 'GroupId' --output text)

        # SSH from control plane only
        aws ec2 authorize-security-group-ingress --profile "${AWS_PROFILE}" --region "${ARG_REGION}" \
            --group-id "${sg_id}" --protocol tcp --port 22 --cidr "${CONTROL_PLANE_IP}/32" >/dev/null

        # HTTPS from anywhere
        aws ec2 authorize-security-group-ingress --profile "${AWS_PROFILE}" --region "${ARG_REGION}" \
            --group-id "${sg_id}" --protocol tcp --port 443 --cidr "0.0.0.0/0" >/dev/null

        # Health check port (temporary, during provisioning)
        aws ec2 authorize-security-group-ingress --profile "${AWS_PROFILE}" --region "${ARG_REGION}" \
            --group-id "${sg_id}" --protocol tcp --port "${HEALTH_PORT}" --cidr "${CONTROL_PLANE_IP}/32" >/dev/null

        ok "Security group created: ${sg_id}"
    else
        ok "Security group exists: ${sg_id}"
    fi

    echo "${sg_id}"
}

# ---------------------------------------------------------------------------
# Get latest Ubuntu 24.04 AMI
# ---------------------------------------------------------------------------
get_latest_ami() {
    aws ec2 describe-images --profile "${AWS_PROFILE}" --region "${ARG_REGION}" \
        --owners 099720109477 \
        --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" \
                  "Name=state,Values=available" \
        --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
        --output text
}

# ---------------------------------------------------------------------------
# Generate user-data script
# ---------------------------------------------------------------------------
generate_user_data() {
    cat <<USERDATA
#!/usr/bin/env bash
set -euo pipefail
exec > /var/log/openclaw-userdata.log 2>&1
echo "=== OpenClaw user-data started at \$(date -Iseconds) ==="

export OPENCLAW_NONINTERACTIVE=1
export CFG_ANTHROPIC_KEY='${ARG_API_KEY}'
export CFG_DISCORD_TOKEN='${ARG_DISCORD_TOKEN}'
export CFG_DISCORD_CHANNEL='${ARG_DISCORD_CHANNEL}'
export CFG_TELEGRAM_TOKEN='${ARG_TELEGRAM_TOKEN}'
export CFG_TELEGRAM_CHAT='${ARG_TELEGRAM_CHAT}'
export CFG_SIGNAL_PHONE='${ARG_SIGNAL_PHONE}'
export CFG_VNC_PASSWORD='${VNC_PASSWORD}'

# Health check endpoint
cat > /opt/openclaw-health.js <<'HEALTHEOF'
const http = require("http");
const { execSync } = require("child_process");
const server = http.createServer((req, res) => {
    if (req.url === "/health" && req.method === "GET") {
        let ok = false;
        try { execSync("systemctl is-active --quiet openclaw", { timeout: 5000 }); ok = true; } catch (_) {}
        res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: ok ? "ok" : "starting", timestamp: new Date().toISOString() }));
    } else { res.writeHead(404); res.end("Not Found"); }
});
server.listen(${HEALTH_PORT}, "0.0.0.0");
HEALTHEOF

# Install Node.js first (needed for health check)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Start health check immediately
node /opt/openclaw-health.js &

# Download and run install script
curl -fsSL '${INSTALL_SCRIPT_URL}' -o /tmp/install-openclaw.sh
chmod +x /tmp/install-openclaw.sh

# Patch for non-interactive mode
sed -i '/^prompt_value() {$/,/^}$/c\\
prompt_value() {\\
    local varname="\$1" default="\${3:-}" required="\${4:-false}"\\
    if [[ "\${OPENCLAW_NONINTERACTIVE:-0}" == "1" ]]; then\\
        local env_val="\${!varname:-\${default}}"\\
        [[ "\${required}" == "true" && -z "\${env_val}" ]] && { echo "ERROR: \${varname} not set" >&2; exit 1; }\\
        eval "\${varname}=\\x27\${env_val}\\x27"\\
        return 0\\
    fi\\
}' /tmp/install-openclaw.sh

sed -i '/^confirm() {$/,/^}$/c\\
confirm() { [[ "\${OPENCLAW_NONINTERACTIVE:-0}" == "1" ]] && return 0; }' /tmp/install-openclaw.sh

bash /tmp/install-openclaw.sh

# Download and install portal bundle
echo "=== Installing ClawDaddy portal ==="
mkdir -p /home/ubuntu/clawdaddy/portal
curl -fsSL '${PORTAL_BUNDLE_URL}' -o /tmp/portal-v1.tar.gz
tar xzf /tmp/portal-v1.tar.gz -C /home/ubuntu/clawdaddy/portal --strip-components=1
cd /home/ubuntu/clawdaddy/portal && npm install --production
chown -R ubuntu:ubuntu /home/ubuntu/clawdaddy/portal
rm -f /tmp/portal-v1.tar.gz

echo "=== OpenClaw user-data completed at \$(date -Iseconds) ==="
USERDATA
}

# ---------------------------------------------------------------------------
# Wait for instance running
# ---------------------------------------------------------------------------
wait_for_instance() {
    local instance_id="$1" elapsed=0
    info "Waiting for instance ${instance_id} to be running..."
    while (( elapsed < INSTANCE_TIMEOUT )); do
        local state
        state=$(aws ec2 describe-instances --profile "${AWS_PROFILE}" --region "${ARG_REGION}" \
            --instance-ids "${instance_id}" \
            --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo "unknown")
        [[ "${state}" == "running" ]] && { ok "Instance running (${elapsed}s)"; return 0; }
        sleep "${INSTANCE_INTERVAL}"
        elapsed=$(( elapsed + INSTANCE_INTERVAL ))
    done
    return 1
}

# ---------------------------------------------------------------------------
# Wait for health
# ---------------------------------------------------------------------------
wait_for_health() {
    local ip="$1" elapsed=0
    info "Polling health at http://${ip}:${HEALTH_PORT}/health ..."
    while (( elapsed < HEALTH_TIMEOUT )); do
        local code
        code=$(curl -sf -o /dev/null -w '%{http_code}' --connect-timeout 5 --max-time 10 \
            "http://${ip}:${HEALTH_PORT}/health" 2>/dev/null || echo "000")
        [[ "${code}" == "200" ]] && { echo ""; ok "Health check passed (${elapsed}s)"; return 0; }
        printf "\r  ${DIM}Health: HTTP %-4s (%ds / %ds)${RESET}" "${code}" "${elapsed}" "${HEALTH_TIMEOUT}"
        sleep "${HEALTH_INTERVAL}"
        elapsed=$(( elapsed + HEALTH_INTERVAL ))
    done
    echo ""
    return 1
}

# ---------------------------------------------------------------------------
# Customers JSON
# ---------------------------------------------------------------------------
init_customers_file() {
    [[ -f "${CUSTOMERS_FILE}" ]] || echo '{"customers":[]}' | jq '.' > "${CUSTOMERS_FILE}"
}

add_customer_record() {
    local id="$1" email="$2" instance_id="$3" ip="$4" status="$5"
    local now; now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local tmp; tmp=$(mktemp)
    jq --arg id "$id" --arg email "$email" --arg inst "$instance_id" \
       --arg ip "$ip" --arg status "$status" --arg now "$now" \
       --arg username "${ARG_USERNAME}" --arg tier "${ARG_TIER}" \
       --arg vnc "${VNC_PASSWORD}" \
       --arg stripe_cust "${ARG_STRIPE_CUSTOMER_ID}" \
       --arg stripe_sub "${ARG_STRIPE_SUBSCRIPTION_ID}" \
       '.customers += [{
            id: $id, email: $email, username: $username, tier: $tier,
            instance_id: $inst, public_ip: $ip, vnc_password: $vnc,
            stripe_customer_id: $stripe_cust, stripe_subscription_id: $stripe_sub,
            status: $status, created_at: $now, updated_at: $now
        }]' "${CUSTOMERS_FILE}" > "$tmp"
    mv "$tmp" "${CUSTOMERS_FILE}"
}

update_customer_status() {
    local id="$1" status="$2" ip="${3:-}"
    local now; now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    local tmp; tmp=$(mktemp)
    if [[ -n "$ip" ]]; then
        jq --arg id "$id" --arg s "$status" --arg ip "$ip" --arg now "$now" \
            '(.customers[] | select(.id == $id)) |= (.status=$s | .public_ip=$ip | .updated_at=$now)' \
            "${CUSTOMERS_FILE}" > "$tmp"
    else
        jq --arg id "$id" --arg s "$status" --arg now "$now" \
            '(.customers[] | select(.id == $id)) |= (.status=$s | .updated_at=$now)' \
            "${CUSTOMERS_FILE}" > "$tmp"
    fi
    mv "$tmp" "${CUSTOMERS_FILE}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    parse_args "$@"

    echo ""
    echo -e "${BOLD}  OpenClaw EC2 Provisioner${RESET}"
    echo -e "${DIM}  $(date)${RESET}"
    echo ""

    init_customers_file

    local customer_id; customer_id=$(generate_customer_id)
    VNC_PASSWORD=$(generate_vnc_password)

    info "Customer ID:   ${customer_id}"
    info "Username:      ${ARG_USERNAME:-<none>}"
    info "Email:         ${ARG_EMAIL}"
    info "Tier:          ${ARG_TIER}"
    info "Instance type: ${ARG_INSTANCE_TYPE}"
    echo ""

    # Get AMI
    info "Finding latest Ubuntu 24.04 AMI..."
    local ami_id; ami_id=$(get_latest_ami)
    ok "AMI: ${ami_id}"

    # Ensure security group
    local sg_id; sg_id=$(ensure_security_group)

    # Get subnet
    local subnet_id
    subnet_id=$(aws ec2 describe-subnets --profile "${AWS_PROFILE}" --region "${ARG_REGION}" \
        --filters "Name=default-for-az,Values=true" \
        --query 'Subnets[0].SubnetId' --output text)

    # Generate user-data
    info "Generating user-data..."
    local userdata_file; userdata_file=$(mktemp)
    generate_user_data > "${userdata_file}"
    ok "User-data: $(wc -c < "${userdata_file}") bytes"

    # Launch instance
    info "Launching EC2 instance..."
    local instance_id
    instance_id=$(aws ec2 run-instances \
        --profile "${AWS_PROFILE}" --region "${ARG_REGION}" \
        --image-id "${ami_id}" \
        --instance-type "${ARG_INSTANCE_TYPE}" \
        --key-name "${KEY_PAIR_NAME}" \
        --security-group-ids "${sg_id}" \
        --subnet-id "${subnet_id}" \
        --associate-public-ip-address \
        --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":20,"VolumeType":"gp3","Encrypted":true}}]' \
        --user-data "file://${userdata_file}" \
        --tag-specifications "ResourceType=instance,Tags=[{Key=project,Value=clawdaddy},{Key=Name,Value=openclaw-${customer_id}},{Key=customer_id,Value=${customer_id}},{Key=username,Value=${ARG_USERNAME:-}}]" \
        --count 1 \
        --query 'Instances[0].InstanceId' --output text)

    rm -f "${userdata_file}"
    ok "Instance: ${instance_id}"

    add_customer_record "${customer_id}" "${ARG_EMAIL}" "${instance_id}" "" "provisioning"

    # Wait for running
    if ! wait_for_instance "${instance_id}"; then
        update_customer_status "${customer_id}" "failed"
        die "Instance failed to start"
    fi

    # Get public IP
    local public_ip
    public_ip=$(aws ec2 describe-instances --profile "${AWS_PROFILE}" --region "${ARG_REGION}" \
        --instance-ids "${instance_id}" \
        --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
    ok "Public IP: ${public_ip}"

    update_customer_status "${customer_id}" "provisioning" "${public_ip}"

    # Create DNS record for username.clawdaddy.sh
    if [[ -n "${ARG_USERNAME}" ]]; then
        info "Creating DNS record: ${ARG_USERNAME}.clawdaddy.sh → ${public_ip}"
        # Uses default profile (80Mills) since Route 53 is there
        aws route53 change-resource-record-sets \
            --hosted-zone-id Z02919613KESOD3UW0BNK \
            --change-batch "{
                \"Changes\": [{
                    \"Action\": \"UPSERT\",
                    \"ResourceRecordSet\": {
                        \"Name\": \"${ARG_USERNAME}.clawdaddy.sh\",
                        \"Type\": \"A\",
                        \"TTL\": 300,
                        \"ResourceRecords\": [{\"Value\": \"${public_ip}\"}]
                    }
                }]
            }" > /dev/null 2>&1 && ok "DNS record created" || warn "DNS record failed (non-fatal)"
    fi

    # Wait for health
    if wait_for_health "${public_ip}"; then
        update_customer_status "${customer_id}" "active"
        echo ""
        echo -e "${BOLD}======================================================${RESET}"
        echo -e "${GREEN}  Provisioning Complete${RESET}"
        echo -e "${BOLD}======================================================${RESET}"
        echo ""
        echo -e "  ${BOLD}Customer ID:${RESET}    ${customer_id}"
        echo -e "  ${BOLD}Username:${RESET}       ${ARG_USERNAME:-<none>}"
        echo -e "  ${BOLD}Instance:${RESET}       ${instance_id}"
        echo -e "  ${BOLD}IP:${RESET}             ${public_ip}"
        echo -e "  ${BOLD}URL:${RESET}            https://${ARG_USERNAME}.clawdaddy.sh"
        echo -e "  ${BOLD}VNC:${RESET}            ${public_ip}:5901 (pw: ${VNC_PASSWORD})"
        echo -e "  ${BOLD}Status:${RESET}         ${GREEN}active${RESET}"
        echo ""

        # Machine-readable output
        echo "CUSTOMER_ID=${customer_id}"
        echo "SERVER_IP=${public_ip}"
        echo "INSTANCE_ID=${instance_id}"
        echo "VNC_PASSWORD=${VNC_PASSWORD}"
        echo "SUBDOMAIN=${ARG_USERNAME}.clawdaddy.sh"
    else
        update_customer_status "${customer_id}" "failed"
        echo ""
        fail "Provisioning failed - health check timeout"
        echo -e "  Debug: ssh -i ${CONTROL_PLANE_KEY} ubuntu@${public_ip}"
        echo -e "  Logs:  cat /var/log/openclaw-userdata.log"
        exit 1
    fi
}

main "$@"
