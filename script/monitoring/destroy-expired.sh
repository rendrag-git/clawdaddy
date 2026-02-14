#!/usr/bin/env bash
###############################################################################
# Destroy Expired Instances - OpenClaw BYOK Tier 2
#
# Finds customers with status=pending_destroy whose destroy_scheduled_at
# has passed, then calls manage.sh destroy to remove their instance.
#
# Cron: 0 4 * * * /opt/openclaw/monitoring/destroy-expired.sh
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CUSTOMERS_FILE="${CUSTOMERS_FILE:-${SCRIPT_DIR}/../customers.json}"
MANAGE_SCRIPT="${SCRIPT_DIR}/../manage.sh"
LOG_FILE="${SCRIPT_DIR}/destroy-expired.log"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() {
    local timestamp
    timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "[${timestamp}] $*" >> "${LOG_FILE}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    if ! command -v jq &>/dev/null; then
        log "ERROR: jq is required but not installed"
        exit 1
    fi

    if [[ ! -f "${CUSTOMERS_FILE}" ]]; then
        log "ERROR: Customers file not found at ${CUSTOMERS_FILE}"
        exit 1
    fi

    if [[ ! -f "${MANAGE_SCRIPT}" ]]; then
        log "ERROR: manage.sh not found at ${MANAGE_SCRIPT}"
        exit 1
    fi

    local now
    now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    local destroyed=0
    local errors=0

    log "INFO: Checking for expired instances..."

    # Find customers pending destruction whose scheduled time has passed
    local expired
    expired="$(jq -r --arg now "${now}" '
        .customers[] |
        select(.status == "pending_destroy" and .destroy_scheduled_at != null and .destroy_scheduled_at <= $now) |
        .id
    ' "${CUSTOMERS_FILE}" 2>/dev/null || true)"

    if [[ -z "${expired}" ]]; then
        log "INFO: No expired instances found"
        return 0
    fi

    while IFS= read -r customer_id; do
        [[ -z "${customer_id}" ]] && continue

        log "INFO: Destroying expired instance for ${customer_id}..."

        if bash "${MANAGE_SCRIPT}" destroy "${customer_id}" --force >> "${LOG_FILE}" 2>&1; then
            destroyed=$((destroyed + 1))
            log "OK: Destroyed instance for ${customer_id}"
        else
            errors=$((errors + 1))
            log "ERROR: Failed to destroy instance for ${customer_id}"
        fi
    done <<< "${expired}"

    log "INFO: Destroy sweep complete - destroyed=${destroyed} errors=${errors}"
}

main "$@"
