#!/usr/bin/env bash
###############################################################################
# Daily Metrics Collector - OpenClaw BYOK Tier 2
#
# SSHs into each active customer instance and collects:
#   - Disk usage, memory usage, service status, uptime
# Appends results to metrics.json.
#
# Cron: 0 3 * * * /opt/openclaw/monitoring/daily-metrics.sh
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CUSTOMERS_FILE="${CUSTOMERS_FILE:-${SCRIPT_DIR}/../customers.json}"
METRICS_FILE="${SCRIPT_DIR}/metrics.json"
LOG_FILE="${SCRIPT_DIR}/daily-metrics.log"
SSH_KEY="${SSH_KEY:-${HOME}/.ssh/id_ed25519}"
SSH_USER="${SSH_USER:-ubuntu}"
SSH_TIMEOUT=10

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() {
    local timestamp
    timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "[${timestamp}] $*" >> "${LOG_FILE}"
}

# ---------------------------------------------------------------------------
# Collect metrics from a single instance via SSH
# ---------------------------------------------------------------------------
collect_instance_metrics() {
    local customer_id="$1"
    local ip="$2"

    # Single SSH call to collect all metrics at once
    local raw
    raw="$(ssh -o StrictHostKeyChecking=no \
        -o ConnectTimeout="${SSH_TIMEOUT}" \
        -o BatchMode=yes \
        -i "${SSH_KEY}" \
        "${SSH_USER}@${ip}" \
        'echo "DISK:$(df --output=pcent / | tail -1 | tr -dc "0-9")";
         echo "MEM:$(free -m | awk "/^Mem:/ {print \$3\"|\" \$2}")";
         echo "SVC:$(systemctl is-active openclaw 2>/dev/null || echo inactive)";
         echo "UP:$(awk "{print int(\$1/86400)}" /proc/uptime)"' 2>/dev/null)" || return 1

    local disk_pct mem_info mem_used mem_total svc_status uptime_days

    disk_pct="$(echo "${raw}" | grep '^DISK:' | cut -d: -f2)"
    mem_info="$(echo "${raw}" | grep '^MEM:' | cut -d: -f2)"
    mem_used="$(echo "${mem_info}" | cut -d'|' -f1)"
    mem_total="$(echo "${mem_info}" | cut -d'|' -f2)"
    svc_status="$(echo "${raw}" | grep '^SVC:' | cut -d: -f2)"
    uptime_days="$(echo "${raw}" | grep '^UP:' | cut -d: -f2)"

    local service_active="false"
    if [[ "${svc_status}" == "active" ]]; then
        service_active="true"
    fi

    jq -n \
        --arg id "${customer_id}" \
        --argjson disk "${disk_pct:-0}" \
        --argjson mem_used "${mem_used:-0}" \
        --argjson mem_total "${mem_total:-0}" \
        --argjson svc_active "${service_active}" \
        --argjson uptime "${uptime_days:-0}" \
        '{
            id: $id,
            disk_pct: $disk,
            mem_used_mb: $mem_used,
            mem_total_mb: $mem_total,
            service_active: $svc_active,
            uptime_days: $uptime
        }'
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

    # Initialize metrics file if missing
    if [[ ! -f "${METRICS_FILE}" ]]; then
        echo '[]' > "${METRICS_FILE}"
    fi

    local today
    today="$(date -u '+%Y-%m-%d')"
    local instances="[]"
    local collected=0
    local failed=0

    # Read active customers (include tier for API spend collection)
    local customers
    customers="$(jq -r '.customers[] | select(.status == "active") | "\(.id)|\(.static_ip)|\(.tier // "byok")"' "${CUSTOMERS_FILE}" 2>/dev/null || true)"

    if [[ -z "${customers}" ]]; then
        log "INFO: No active customers found"
        return 0
    fi

    while IFS='|' read -r customer_id ip tier; do
        [[ -z "${customer_id}" ]] && continue

        log "INFO: Collecting metrics for ${customer_id} (${ip})..."

        local metric
        if metric="$(collect_instance_metrics "${customer_id}" "${ip}")"; then
            # Collect API spend for managed-tier instances
            local api_spend="null"
            if [[ "${tier}" == "managed" || "${tier}" == "opus" ]]; then
                local stats_json
                stats_json="$(ssh -o StrictHostKeyChecking=no \
                    -o ConnectTimeout="${SSH_TIMEOUT}" \
                    -o BatchMode=yes \
                    -i "${SSH_KEY}" \
                    "${SSH_USER}@${ip}" \
                    "curl -s http://localhost:3141/stats 2>/dev/null" 2>/dev/null)" || stats_json=""

                if [[ -n "${stats_json}" ]] && echo "${stats_json}" | jq -e '.monthly_spend' &>/dev/null; then
                    api_spend="$(echo "${stats_json}" | jq '.monthly_spend')"
                fi
            fi

            metric="$(echo "${metric}" | jq --argjson spend "${api_spend}" '. + {api_spend: $spend}')"
            instances="$(echo "${instances}" | jq --argjson m "${metric}" '. + [$m]')"
            collected=$((collected + 1))
            log "OK: Collected metrics for ${customer_id}"
        else
            failed=$((failed + 1))
            log "WARN: SSH failed for ${customer_id} (${ip}), skipping"
        fi
    done <<< "${customers}"

    # Build daily entry
    local entry
    entry="$(jq -n \
        --arg date "${today}" \
        --argjson instances "${instances}" \
        '{date: $date, instances: $instances}')"

    # Append to metrics file (replace entry for today if re-run)
    local metrics
    metrics="$(cat "${METRICS_FILE}")"
    metrics="$(echo "${metrics}" | jq --arg date "${today}" '[.[] | select(.date != $date)]')"
    metrics="$(echo "${metrics}" | jq --argjson entry "${entry}" '. + [$entry]')"
    echo "${metrics}" | jq '.' > "${METRICS_FILE}"

    log "INFO: Daily metrics complete - collected=${collected} failed=${failed}"
}

main "$@"
