#!/usr/bin/env bash
# test-provision.sh — CLI wrapper for testing provision.sh directly
# No web server, no Stripe. Just provision and stream output.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROVISION_SCRIPT="${SCRIPT_DIR}/provision.sh"

# Defaults
USERNAME=""
EMAIL="test@clawdaddy.sh"
TIER="byok"
API_KEY="sk-ant-test-dummy-key-for-testing"
CLEANUP=false
REGION="us-east-1"

usage() {
  cat <<EOF
Usage: $(basename "$0") --username <name> [options]

Required:
  --username <name>     Customer username (becomes subdomain + instance name)

Options:
  --email <email>       Customer email (default: test@clawdaddy.sh)
  --tier <byok|managed> Tier (default: byok)
  --api-key <key>       API key for BYOK tier (default: dummy test key)
  --region <region>     AWS region (default: us-east-1)
  --cleanup             Auto-delete instance + static IP on failure
  --help                Show this help

Examples:
  $(basename "$0") --username testuser1
  $(basename "$0") --username testuser1 --cleanup
  $(basename "$0") --username testuser1 --tier managed --cleanup
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --username)   USERNAME="${2:?--username requires a value}"; shift 2 ;;
    --email)      EMAIL="${2:?--email requires a value}"; shift 2 ;;
    --tier)       TIER="${2:?--tier requires a value}"; shift 2 ;;
    --api-key)    API_KEY="${2:?--api-key requires a value}"; shift 2 ;;
    --region)     REGION="${2:?--region requires a value}"; shift 2 ;;
    --cleanup)    CLEANUP=true; shift ;;
    --help)       usage ;;
    *)            echo "Unknown option: $1"; usage ;;
  esac
done

if [[ -z "$USERNAME" ]]; then
  echo "Error: --username is required"
  usage
fi

INSTANCE_NAME="openclaw-${USERNAME}"
STATIC_IP_NAME="ip-openclaw-${USERNAME}"

cleanup_on_failure() {
  if [[ "$CLEANUP" != true ]]; then
    echo ""
    echo "💡 Re-run with --cleanup to auto-delete on failure"
    return
  fi

  echo ""
  echo "🧹 Cleanup: deleting instance and static IP..."

  aws lightsail delete-instance --instance-name "$INSTANCE_NAME" --profile clawdaddy 2>/dev/null && \
    echo "  ✓ Deleted instance: $INSTANCE_NAME" || \
    echo "  - Instance $INSTANCE_NAME not found (already deleted or never created)"

  aws lightsail release-static-ip --static-ip-name "$STATIC_IP_NAME" --profile clawdaddy 2>/dev/null && \
    echo "  ✓ Released static IP: $STATIC_IP_NAME" || \
    echo "  - Static IP $STATIC_IP_NAME not found (already released or never created)"

  # Clean up SSH key if it exists
  local key_dir="${SSH_KEY_DIR:-$HOME/.ssh/customer-keys}"
  if [[ -f "${key_dir}/${USERNAME}" ]]; then
    rm -f "${key_dir}/${USERNAME}" "${key_dir}/${USERNAME}.pub"
    echo "  ✓ Removed SSH key: ${key_dir}/${USERNAME}"
  fi

  # Remove DNS record if it exists
  if [[ -n "${ROUTE53_HOSTED_ZONE_ID:-}" ]]; then
    local ip
    ip=$(aws lightsail get-static-ip --static-ip-name "$STATIC_IP_NAME" --profile clawdaddy --query 'staticIp.ipAddress' --output text 2>/dev/null || true)
    if [[ -n "$ip" && "$ip" != "None" ]]; then
      aws route53 change-resource-record-sets --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" --change-batch "{
        \"Changes\": [{
          \"Action\": \"DELETE\",
          \"ResourceRecordSet\": {
            \"Name\": \"${USERNAME}.clawdaddy.sh\",
            \"Type\": \"A\",
            \"TTL\": 300,
            \"ResourceRecords\": [{\"Value\": \"${ip}\"}]
          }
        }]
      }" 2>/dev/null && echo "  ✓ Deleted DNS record: ${USERNAME}.clawdaddy.sh" || true
    fi
  fi

  echo "🧹 Cleanup complete"
}

# Build args
PROVISION_ARGS=(
  --username "$USERNAME"
  --email "$EMAIL"
  --tier "$TIER"
  --region "$REGION"
)

if [[ "$TIER" == "byok" ]]; then
  PROVISION_ARGS+=(--api-key "$API_KEY")
fi

echo "═══════════════════════════════════════════════════"
echo "  ClawDaddy Provision Test"
echo "═══════════════════════════════════════════════════"
echo "  Username:  $USERNAME"
echo "  Email:     $EMAIL"
echo "  Tier:      $TIER"
echo "  Region:    $REGION"
echo "  Cleanup:   $CLEANUP"
echo "  Instance:  $INSTANCE_NAME"
echo "  Static IP: $STATIC_IP_NAME"
echo "═══════════════════════════════════════════════════"
echo ""

START_TIME=$(date +%s)

# Run provision.sh, stream output, capture exit code
set +e
bash "$PROVISION_SCRIPT" "${PROVISION_ARGS[@]}" 2>&1 | tee /tmp/test-provision-${USERNAME}.log
EXIT_CODE=${PIPESTATUS[0]}
set -e

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
MINUTES=$((ELAPSED / 60))
SECONDS=$((ELAPSED % 60))

echo ""
echo "═══════════════════════════════════════════════════"
if [[ $EXIT_CODE -eq 0 ]]; then
  echo "  ✅ PROVISIONING SUCCEEDED"
else
  echo "  ❌ PROVISIONING FAILED (exit code: $EXIT_CODE)"
fi
echo "  Elapsed: ${MINUTES}m ${SECONDS}s"
echo "═══════════════════════════════════════════════════"

# Parse machine-readable output
if [[ $EXIT_CODE -eq 0 ]]; then
  LOG="/tmp/test-provision-${USERNAME}.log"
  IP=$(grep '^SERVER_IP=' "$LOG" | tail -1 | cut -d= -f2)
  CID=$(grep '^CUSTOMER_ID=' "$LOG" | tail -1 | cut -d= -f2)
  DNS=$(grep '^DNS_HOSTNAME=' "$LOG" | tail -1 | cut -d= -f2)
  KEY=$(grep '^SSH_KEY_PATH=' "$LOG" | tail -1 | cut -d= -f2)

  echo ""
  echo "  Results:"
  echo "    Customer ID:  ${CID:-unknown}"
  echo "    Server IP:    ${IP:-unknown}"
  echo "    DNS:          ${DNS:-not set}"
  echo "    SSH Key:      ${KEY:-unknown}"
  [[ -n "$IP" ]] && echo "    Health:       http://${IP}:8080/health"
  [[ -n "$DNS" ]] && echo "    Subdomain:    https://${DNS}"
  echo ""
  echo "  Quick commands:"
  [[ -n "$KEY" && -n "$IP" ]] && echo "    ssh -i ${KEY} ubuntu@${IP}"
  echo "    bash ${SCRIPT_DIR}/manage.sh health ${CID:-$USERNAME}"
  echo ""
else
  cleanup_on_failure
fi

echo "  Full log: /tmp/test-provision-${USERNAME}.log"
echo "═══════════════════════════════════════════════════"

exit $EXIT_CODE
