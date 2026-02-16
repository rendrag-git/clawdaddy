#!/usr/bin/env bash
# test-provision.sh — Full E2E test: provision + quiz + profile gen + file push + verify
# No web server, no Stripe. CLI-driven end-to-end.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROVISION_SCRIPT="${SCRIPT_DIR}/provision.sh"
PROFILE_SCRIPT="${SCRIPT_DIR}/generate-profile.js"

# Defaults
USERNAME=""
EMAIL="test@clawdaddy.sh"
TIER="byok"
API_KEY="sk-ant-test-dummy-key-for-testing"
BOT_NAME=""
QUIZ_FILE=""
CLEANUP=false
REGION="us-east-1"
SKIP_PROVISION=false

usage() {
  cat <<EOF
Usage: $(basename "$0") --username <name> [options]

Required:
  --username <name>     Customer username (becomes subdomain + instance name)

Options:
  --email <email>       Customer email (default: test@clawdaddy.sh)
  --tier <byok|managed> Tier (default: byok)
  --api-key <key>       API key for BYOK tier (default: dummy test key)
  --bot-name <name>     Assistant name (default: same as username)
  --quiz <file.json>    Quiz results JSON (default: script/sample-quiz.json)
  --region <region>     AWS region (default: us-east-1)
  --cleanup             Auto-delete instance + static IP + DNS on failure
  --skip-provision      Skip Lightsail provisioning (use existing instance)
  --help                Show this help

Examples:
  # Full E2E: provision + quiz + profile + push + verify
  $(basename "$0") --username testuser1 --cleanup

  # Custom quiz answers
  $(basename "$0") --username testuser1 --quiz my-quiz.json --cleanup

  # Skip provisioning, just test profile gen + push on existing instance
  $(basename "$0") --username testuser1 --skip-provision
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --username)       USERNAME="${2:?--username requires a value}"; shift 2 ;;
    --email)          EMAIL="${2:?--email requires a value}"; shift 2 ;;
    --tier)           TIER="${2:?--tier requires a value}"; shift 2 ;;
    --api-key)        API_KEY="${2:?--api-key requires a value}"; shift 2 ;;
    --bot-name)       BOT_NAME="${2:?--bot-name requires a value}"; shift 2 ;;
    --quiz)           QUIZ_FILE="${2:?--quiz requires a value}"; shift 2 ;;
    --region)         REGION="${2:?--region requires a value}"; shift 2 ;;
    --cleanup)        CLEANUP=true; shift ;;
    --skip-provision) SKIP_PROVISION=true; shift ;;
    --help)           usage ;;
    *)                echo "Unknown option: $1"; usage ;;
  esac
done

if [[ -z "$USERNAME" ]]; then
  echo "Error: --username is required"
  usage
fi

[[ -z "$BOT_NAME" ]] && BOT_NAME="$USERNAME"
[[ -z "$QUIZ_FILE" ]] && QUIZ_FILE="${SCRIPT_DIR}/sample-quiz.json"

if [[ ! -f "$QUIZ_FILE" ]]; then
  echo "Error: Quiz file not found: $QUIZ_FILE"
  exit 1
fi

INSTANCE_NAME="openclaw-${USERNAME}"
STATIC_IP_NAME="ip-openclaw-${USERNAME}"
GENERATED_DIR="/tmp/clawdaddy-generated-${USERNAME}"
LOG_FILE="/tmp/test-provision-${USERNAME}.log"
KEY_DIR="${SSH_KEY_DIR:-$HOME/.ssh/customer-keys}"

cleanup_resources() {
  if [[ "$CLEANUP" != true ]]; then
    echo ""
    echo "💡 Re-run with --cleanup to auto-delete on failure"
    return
  fi

  echo ""
  echo "🧹 Cleanup: deleting resources..."

  aws lightsail delete-instance --instance-name "$INSTANCE_NAME" --profile clawdaddy 2>/dev/null && \
    echo "  ✓ Deleted instance: $INSTANCE_NAME" || \
    echo "  - Instance $INSTANCE_NAME not found"

  aws lightsail release-static-ip --static-ip-name "$STATIC_IP_NAME" --profile clawdaddy 2>/dev/null && \
    echo "  ✓ Released static IP: $STATIC_IP_NAME" || \
    echo "  - Static IP $STATIC_IP_NAME not found"

  if [[ -f "${KEY_DIR}/${USERNAME}" ]]; then
    rm -f "${KEY_DIR}/${USERNAME}" "${KEY_DIR}/${USERNAME}.pub"
    echo "  ✓ Removed SSH key: ${KEY_DIR}/${USERNAME}"
  fi

  # DNS cleanup (best effort)
  if [[ -n "${ROUTE53_HOSTED_ZONE_ID:-}" && -n "${SERVER_IP:-}" ]]; then
    aws route53 change-resource-record-sets --hosted-zone-id "$ROUTE53_HOSTED_ZONE_ID" --change-batch "{
      \"Changes\": [{
        \"Action\": \"DELETE\",
        \"ResourceRecordSet\": {
          \"Name\": \"${USERNAME}.clawdaddy.sh\",
          \"Type\": \"A\",
          \"TTL\": 300,
          \"ResourceRecords\": [{\"Value\": \"${SERVER_IP}\"}]
        }
      }]
    }" 2>/dev/null && echo "  ✓ Deleted DNS: ${USERNAME}.clawdaddy.sh" || true
  fi

  rm -rf "$GENERATED_DIR" 2>/dev/null || true

  echo "🧹 Cleanup complete"
}

# Track results for summary
SERVER_IP=""
CUSTOMER_ID=""
SSH_KEY_PATH=""
DNS_HOSTNAME=""
STEP_RESULTS=()

step_ok() { STEP_RESULTS+=("✅ $1"); echo "  ✅ $1"; }
step_fail() { STEP_RESULTS+=("❌ $1: $2"); echo "  ❌ $1: $2"; }

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ClawDaddy Full E2E Test"
echo "═══════════════════════════════════════════════════════════"
echo "  Username:   $USERNAME"
echo "  Bot Name:   $BOT_NAME"
echo "  Email:      $EMAIL"
echo "  Tier:       $TIER"
echo "  Quiz:       $QUIZ_FILE"
echo "  Region:     $REGION"
echo "  Cleanup:    $CLEANUP"
echo "  Skip Prov:  $SKIP_PROVISION"
echo "═══════════════════════════════════════════════════════════"
echo ""

START_TIME=$(date +%s)

# ─────────────────────────────────────────────────────────────
# STEP 1: Provision Lightsail Instance
# ─────────────────────────────────────────────────────────────
echo "━━━ Step 1/5: Provision Instance ━━━"

if [[ "$SKIP_PROVISION" == true ]]; then
  echo "  Skipped (--skip-provision). Looking up existing instance..."
  SERVER_IP=$(aws lightsail get-static-ip --static-ip-name "$STATIC_IP_NAME" --profile clawdaddy --query 'staticIp.ipAddress' --output text 2>/dev/null || true)
  if [[ -z "$SERVER_IP" || "$SERVER_IP" == "None" ]]; then
    echo "  ❌ No existing static IP found for $STATIC_IP_NAME"
    exit 1
  fi
  SSH_KEY_PATH="${KEY_DIR}/${USERNAME}"
  if [[ ! -f "$SSH_KEY_PATH" ]]; then
    echo "  ❌ No SSH key found at $SSH_KEY_PATH"
    exit 1
  fi
  step_ok "Instance exists (IP: $SERVER_IP)"
else
  PROVISION_ARGS=(
    --username "$USERNAME"
    --email "$EMAIL"
    --tier "$TIER"
    --region "$REGION"
  )
  [[ "$TIER" == "byok" ]] && PROVISION_ARGS+=(--api-key "$API_KEY")

  set +e
  bash "$PROVISION_SCRIPT" "${PROVISION_ARGS[@]}" 2>&1 | tee "$LOG_FILE"
  PROV_EXIT=${PIPESTATUS[0]}
  set -e

  if [[ $PROV_EXIT -ne 0 ]]; then
    step_fail "Provisioning" "exit code $PROV_EXIT"
    cleanup_resources
    exit 1
  fi

  # Parse machine-readable output
  SERVER_IP=$(grep '^SERVER_IP=' "$LOG_FILE" | tail -1 | cut -d= -f2)
  CUSTOMER_ID=$(grep '^CUSTOMER_ID=' "$LOG_FILE" | tail -1 | cut -d= -f2)
  SSH_KEY_PATH=$(grep '^SSH_KEY_PATH=' "$LOG_FILE" | tail -1 | cut -d= -f2)
  DNS_HOSTNAME=$(grep '^DNS_HOSTNAME=' "$LOG_FILE" | tail -1 | cut -d= -f2)

  if [[ -z "$SERVER_IP" ]]; then
    step_fail "Provisioning" "no SERVER_IP in output"
    cleanup_resources
    exit 1
  fi

  step_ok "Provisioned (IP: $SERVER_IP, ID: ${CUSTOMER_ID:-unknown})"
fi

echo ""

# ─────────────────────────────────────────────────────────────
# STEP 2: Generate Personality Profile
# ─────────────────────────────────────────────────────────────
echo "━━━ Step 2/5: Generate Personality Profile ━━━"

rm -rf "$GENERATED_DIR" 2>/dev/null || true

set +e
OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-$(cat /home/ubuntu/clawd/.secrets/openrouter-key 2>/dev/null || true)}" \
  node "$PROFILE_SCRIPT" "$QUIZ_FILE" "$USERNAME" "$BOT_NAME" "$GENERATED_DIR" 2>&1
PROFILE_EXIT=$?
set -e

if [[ $PROFILE_EXIT -ne 0 ]]; then
  step_fail "Profile generation" "exit code $PROFILE_EXIT"
  cleanup_resources
  exit 1
fi

# Verify files exist
EXPECTED_FILES=("SOUL.md" "USER.md" "IDENTITY.md" "BOOTSTRAP.md")
MISSING=()
for f in "${EXPECTED_FILES[@]}"; do
  if [[ ! -f "${GENERATED_DIR}/${f}" ]]; then
    MISSING+=("$f")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  step_fail "Profile generation" "missing files: ${MISSING[*]}"
  cleanup_resources
  exit 1
fi

step_ok "Profile generated ($(ls "$GENERATED_DIR" | wc -l) files)"
echo ""

# ─────────────────────────────────────────────────────────────
# STEP 3: Push Files to Instance via SCP
# ─────────────────────────────────────────────────────────────
echo "━━━ Step 3/5: Push Files to Instance ━━━"

# Determine SSH key
if [[ -z "$SSH_KEY_PATH" ]]; then
  SSH_KEY_PATH="${KEY_DIR}/${USERNAME}"
fi

if [[ ! -f "$SSH_KEY_PATH" ]]; then
  step_fail "File push" "SSH key not found: $SSH_KEY_PATH"
  cleanup_resources
  exit 1
fi

SSH_OPTS="-i ${SSH_KEY_PATH} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o LogLevel=ERROR"

# Wait for SSH to be ready (instance may still be booting)
echo "  Waiting for SSH on $SERVER_IP..."
SSH_READY=false
for i in $(seq 1 30); do
  if ssh $SSH_OPTS ubuntu@"$SERVER_IP" "echo ok" &>/dev/null; then
    SSH_READY=true
    break
  fi
  echo "  Attempt $i/30 — waiting 10s..."
  sleep 10
done

if [[ "$SSH_READY" != true ]]; then
  step_fail "File push" "SSH not reachable after 5 minutes"
  cleanup_resources
  exit 1
fi

# Determine agent workspace path on the instance
REMOTE_AGENT_DIR="/home/ubuntu/.openclaw/agents/default"

# Create directory and push files
set +e
ssh $SSH_OPTS ubuntu@"$SERVER_IP" "mkdir -p ${REMOTE_AGENT_DIR}" 2>&1
SCP_OUTPUT=$(scp $SSH_OPTS "${GENERATED_DIR}/SOUL.md" "${GENERATED_DIR}/USER.md" "${GENERATED_DIR}/IDENTITY.md" "${GENERATED_DIR}/BOOTSTRAP.md" ubuntu@"$SERVER_IP":"${REMOTE_AGENT_DIR}/" 2>&1)
SCP_EXIT=$?
set -e

if [[ $SCP_EXIT -ne 0 ]]; then
  step_fail "File push" "SCP failed: $SCP_OUTPUT"
  cleanup_resources
  exit 1
fi

step_ok "Files pushed via SCP to ${REMOTE_AGENT_DIR}/"
echo ""

# ─────────────────────────────────────────────────────────────
# STEP 4: Verify Files on Instance
# ─────────────────────────────────────────────────────────────
echo "━━━ Step 4/5: Verify Files on Instance ━━━"

VERIFY_FAILED=false
for f in "${EXPECTED_FILES[@]}"; do
  REMOTE_SIZE=$(ssh $SSH_OPTS ubuntu@"$SERVER_IP" "stat -c%s ${REMOTE_AGENT_DIR}/${f} 2>/dev/null || echo 0")
  LOCAL_SIZE=$(stat -c%s "${GENERATED_DIR}/${f}" 2>/dev/null || echo 0)

  if [[ "$REMOTE_SIZE" -eq 0 ]]; then
    echo "  ❌ ${f} — missing on instance"
    VERIFY_FAILED=true
  elif [[ "$REMOTE_SIZE" -ne "$LOCAL_SIZE" ]]; then
    echo "  ⚠️  ${f} — size mismatch (local: ${LOCAL_SIZE}, remote: ${REMOTE_SIZE})"
    VERIFY_FAILED=true
  else
    echo "  ✓ ${f} — verified (${REMOTE_SIZE} bytes)"
  fi
done

# Also check content of SOUL.md (first line should be # Soul or similar)
SOUL_FIRST_LINE=$(ssh $SSH_OPTS ubuntu@"$SERVER_IP" "head -1 ${REMOTE_AGENT_DIR}/SOUL.md 2>/dev/null || echo EMPTY")
echo ""
echo "  SOUL.md first line: ${SOUL_FIRST_LINE}"

if [[ "$VERIFY_FAILED" == true ]]; then
  step_fail "Verification" "some files didn't match"
else
  step_ok "All files verified on instance"
fi

echo ""

# ─────────────────────────────────────────────────────────────
# STEP 5: Health Check
# ─────────────────────────────────────────────────────────────
echo "━━━ Step 5/5: Instance Health Check ━━━"

set +e
HEALTH=$(curl -s --connect-timeout 5 "http://${SERVER_IP}:8080/health" 2>/dev/null)
HEALTH_EXIT=$?
set -e

if [[ $HEALTH_EXIT -eq 0 && -n "$HEALTH" ]]; then
  step_ok "Health check passed: $HEALTH"
else
  echo "  ⚠️  Health endpoint not responding (OpenClaw may not be running yet)"
  STEP_RESULTS+=("⚠️  Health: not responding (expected if OpenClaw not started)")
fi

# ─────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
MINUTES=$((ELAPSED / 60))
SECONDS=$((ELAPSED % 60))

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  E2E Test Summary"
echo "═══════════════════════════════════════════════════════════"
for r in "${STEP_RESULTS[@]}"; do
  echo "  $r"
done
echo ""
echo "  Customer ID:  ${CUSTOMER_ID:-unknown}"
echo "  Server IP:    ${SERVER_IP}"
echo "  DNS:          ${DNS_HOSTNAME:-not set}"
echo "  SSH Key:      ${SSH_KEY_PATH}"
echo "  Generated:    ${GENERATED_DIR}"
echo "  Elapsed:      ${MINUTES}m ${SECONDS}s"
echo ""
echo "  Quick commands:"
echo "    ssh -i ${SSH_KEY_PATH} ubuntu@${SERVER_IP}"
[[ -n "$DNS_HOSTNAME" ]] && echo "    https://${DNS_HOSTNAME}"
echo "    bash ${SCRIPT_DIR}/manage.sh health ${CUSTOMER_ID:-$USERNAME}"
echo ""
echo "  Full log: ${LOG_FILE}"
echo "═══════════════════════════════════════════════════════════"
