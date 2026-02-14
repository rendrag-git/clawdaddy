#!/usr/bin/env bash
###############################################################################
# Health Check - OpenClaw BYOK Tier 2
#
# Checks /health endpoint on all active customer instances every 5 minutes.
# Tracks consecutive failures in health-state.json and sends Discord alerts
# when an instance has been down for >15 minutes (3 consecutive failures).
#
# Cron: */5 * * * * /opt/openclaw/monitoring/health-check.sh
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CUSTOMERS_FILE="${CUSTOMERS_FILE:-${SCRIPT_DIR}/../customers.json}"
STATE_FILE="${SCRIPT_DIR}/health-state.json"
LOG_FILE="${SCRIPT_DIR}/health-check.log"
DISCORD_WEBHOOK="${DISCORD_OPS_WEBHOOK_URL:-}"
HEALTH_TIMEOUT=5
FAILURE_THRESHOLD=3  # consecutive failures before alerting (3 * 5min = 15min)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() {
    local timestamp
    timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "[${timestamp}] $*" >> "${LOG_FILE}"
}

# ---------------------------------------------------------------------------
# Discord alert
# ---------------------------------------------------------------------------
send_discord_alert() {
    local customer_id="$1"
    local ip="$2"
    local failures="$3"
    local first_failure="$4"
    local downtime_min=$(( failures * 5 ))

    if [[ -z "${DISCORD_WEBHOOK}" ]]; then
        log "WARN: DISCORD_OPS_WEBHOOK_URL not set, skipping alert for ${customer_id}"
        return 0
    fi

    local payload
    payload=$(jq -n \
        --arg title "Instance Down: ${customer_id}" \
        --arg desc "**IP:** ${ip}\n**Consecutive failures:** ${failures}\n**Down since:** ${first_failure}\n**Estimated downtime:** ~${downtime_min} minutes" \
        --argjson color 15158332 \
        --arg ts "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
        '{
            embeds: [{
                title: $title,
                description: $desc,
                color: $color,
                timestamp: $ts
            }]
        }')

    if curl -s -o /dev/null -w '' -H "Content-Type: application/json" \
        -d "${payload}" "${DISCORD_WEBHOOK}"; then
        log "INFO: Discord alert sent for ${customer_id}"
    else
        log "ERROR: Failed to send Discord alert for ${customer_id}"
    fi
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

    # Initialize state file if missing
    if [[ ! -f "${STATE_FILE}" ]]; then
        echo '{}' > "${STATE_FILE}"
    fi

    local state
    state="$(cat "${STATE_FILE}")"
    local now
    now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    local checked=0
    local healthy=0
    local unhealthy=0

    # Read active customers
    local customers
    customers="$(jq -r '.customers[] | select(.status == "active") | "\(.id)|\(.static_ip)"' "${CUSTOMERS_FILE}" 2>/dev/null || true)"

    if [[ -z "${customers}" ]]; then
        log "INFO: No active customers found"
        echo "${state}" > "${STATE_FILE}"
        return 0
    fi

    while IFS='|' read -r customer_id ip; do
        [[ -z "${customer_id}" ]] && continue
        checked=$((checked + 1))

        # Perform health check
        local http_code
        http_code="$(curl -s -o /dev/null -w '%{http_code}' \
            --connect-timeout "${HEALTH_TIMEOUT}" \
            --max-time $((HEALTH_TIMEOUT * 2)) \
            "http://${ip}:8080/health" 2>/dev/null || echo "000")"

        if [[ "${http_code}" == "200" ]]; then
            healthy=$((healthy + 1))
            # Clear failure state on success
            state="$(echo "${state}" | jq --arg id "${customer_id}" 'del(.[$id])')"
            log "OK: ${customer_id} (${ip}) healthy"
        else
            unhealthy=$((unhealthy + 1))

            # Get current failure count
            local prev_failures
            prev_failures="$(echo "${state}" | jq -r --arg id "${customer_id}" '.[$id].consecutive_failures // 0')"
            local first_failure
            first_failure="$(echo "${state}" | jq -r --arg id "${customer_id}" '.[$id].first_failure // empty')"

            local new_failures=$((prev_failures + 1))
            if [[ -z "${first_failure}" ]]; then
                first_failure="${now}"
            fi

            # Update state
            state="$(echo "${state}" | jq \
                --arg id "${customer_id}" \
                --argjson failures "${new_failures}" \
                --arg first "${first_failure}" \
                --arg last "${now}" \
                '.[$id] = {consecutive_failures: $failures, first_failure: $first, last_check: $last}')"

            log "FAIL: ${customer_id} (${ip}) returned ${http_code} (failure #${new_failures})"

            # Alert if threshold reached (only on the exact threshold to avoid spam)
            if [[ "${new_failures}" -eq "${FAILURE_THRESHOLD}" ]]; then
                send_discord_alert "${customer_id}" "${ip}" "${new_failures}" "${first_failure}"
            fi
        fi
    done <<< "${customers}"

    # Persist state
    echo "${state}" | jq '.' > "${STATE_FILE}"

    log "INFO: Health check complete - checked=${checked} healthy=${healthy} unhealthy=${unhealthy}"
}

main "$@"
