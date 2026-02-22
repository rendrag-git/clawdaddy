#!/usr/bin/env bash
###############################################################################
# create-snapshot.sh - Create a Lightsail golden snapshot for faster provisioning
#
# Creates a snapshot from an existing Lightsail instance, waits for it to
# become available, and prints the snapshot name for use with provision.sh
# --snapshot-name.
#
# Usage:
#   bash create-snapshot.sh --instance-name <name> [--region <region>]
#
# Examples:
#   bash create-snapshot.sh --instance-name openclaw-golden --region us-east-1
#   # Then use with provision.sh:
#   bash provision.sh --email user@example.com --snapshot-name openclaw-golden-20260222-153045
###############################################################################
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
INSTANCE_NAME=""
REGION="us-east-1"
AWS_PROFILE_ARG="${AWS_PROFILE:-clawdaddy}"
SNAPSHOT_TIMEOUT=600   # 10 minutes
SNAPSHOT_INTERVAL=15   # seconds

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

info()  { echo -e "${CYAN}[info]${RESET}  $*"; }
ok()    { echo -e "${GREEN}  [ok]${RESET}  $*"; }
fail()  { echo -e "${RED}[fail]${RESET}  $*"; }
die()   { fail "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
usage() {
    cat <<EOF
${BOLD}Usage:${RESET}
  bash create-snapshot.sh --instance-name NAME [OPTIONS]

${BOLD}Required:${RESET}
  --instance-name      Name of the Lightsail instance to snapshot

${BOLD}Optional:${RESET}
  --region             AWS region (default: us-east-1)
  --help               Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --instance-name)
            INSTANCE_NAME="${2:?--instance-name requires a value}"
            shift 2
            ;;
        --region)
            REGION="${2:?--region requires a value}"
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

if [[ -z "${INSTANCE_NAME}" ]]; then
    die "Missing required argument: --instance-name"
fi

# ---------------------------------------------------------------------------
# Verify instance exists
# ---------------------------------------------------------------------------
info "Verifying instance '${INSTANCE_NAME}' exists in ${REGION}..."

instance_state="$(aws lightsail get-instance \
    --instance-name "${INSTANCE_NAME}" \
    --region "${REGION}" \
    --profile "${AWS_PROFILE_ARG}" \
    --query 'instance.state.name' \
    --output text 2>/dev/null || echo "not_found")"

if [[ "${instance_state}" == "not_found" ]]; then
    die "Instance '${INSTANCE_NAME}' not found in region ${REGION}"
fi

if [[ "${instance_state}" != "running" ]]; then
    die "Instance '${INSTANCE_NAME}' is in state '${instance_state}' (must be 'running')"
fi

ok "Instance found and running"

# ---------------------------------------------------------------------------
# Create snapshot
# ---------------------------------------------------------------------------
snapshot_name="${INSTANCE_NAME}-$(date +%Y%m%d-%H%M%S)"

info "Creating snapshot '${snapshot_name}'..."

if ! aws lightsail create-instance-snapshot \
    --instance-name "${INSTANCE_NAME}" \
    --instance-snapshot-name "${snapshot_name}" \
    --region "${REGION}" \
    --profile "${AWS_PROFILE_ARG}" \
    --output json > /dev/null 2>&1; then
    die "Failed to create snapshot"
fi

ok "Snapshot creation initiated"

# ---------------------------------------------------------------------------
# Wait for snapshot to be available
# ---------------------------------------------------------------------------
info "Waiting for snapshot to become available (timeout: ${SNAPSHOT_TIMEOUT}s)..."

elapsed=0
while (( elapsed < SNAPSHOT_TIMEOUT )); do
    snapshot_state="$(aws lightsail get-instance-snapshot \
        --instance-snapshot-name "${snapshot_name}" \
        --region "${REGION}" \
        --profile "${AWS_PROFILE_ARG}" \
        --query 'instanceSnapshot.state' \
        --output text 2>/dev/null || echo "unknown")"

    if [[ "${snapshot_state}" == "available" ]]; then
        printf "\n"
        ok "Snapshot is available (${elapsed}s elapsed)"
        break
    fi

    printf "\r  ${DIM}Snapshot state: %-12s (%ds / %ds)${RESET}" \
        "${snapshot_state}" "${elapsed}" "${SNAPSHOT_TIMEOUT}"

    sleep "${SNAPSHOT_INTERVAL}"
    elapsed=$(( elapsed + SNAPSHOT_INTERVAL ))
done

if [[ "${snapshot_state}" != "available" ]]; then
    printf "\n"
    die "Snapshot did not become available within ${SNAPSHOT_TIMEOUT}s"
fi

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}========================================================${RESET}"
echo -e "${GREEN}  Snapshot Created${RESET}"
echo -e "${BOLD}========================================================${RESET}"
echo ""
echo -e "  ${BOLD}Snapshot Name:${RESET}  ${snapshot_name}"
echo -e "  ${BOLD}Source:${RESET}         ${INSTANCE_NAME}"
echo -e "  ${BOLD}Region:${RESET}         ${REGION}"
echo ""
echo -e "  Use with provision.sh:"
echo -e "    ${CYAN}bash provision.sh --email user@example.com --snapshot-name ${snapshot_name}${RESET}"
echo ""

# Machine-readable output
echo "SNAPSHOT_NAME=${snapshot_name}"
