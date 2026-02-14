#!/usr/bin/env bash
###############################################################################
# Weekly Report - OpenClaw BYOK Tier 2
#
# Generates a weekly summary from customers.json and metrics.json:
#   - Total active customers / MRR
#   - Instance health overview
#   - Disk usage warnings (>80%)
#   - New / churned customers this week
# Sends report via email (Resend API) and Discord webhook.
#
# Cron: 0 9 * * 1 /opt/openclaw/monitoring/weekly-report.sh  (Monday 9am)
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CUSTOMERS_FILE="${CUSTOMERS_FILE:-${SCRIPT_DIR}/../customers.json}"
METRICS_FILE="${SCRIPT_DIR}/metrics.json"
STATE_FILE="${SCRIPT_DIR}/health-state.json"
LOG_FILE="${SCRIPT_DIR}/weekly-report.log"

DISCORD_WEBHOOK="${DISCORD_OPS_WEBHOOK_URL:-}"
RESEND_API_KEY="${RESEND_API_KEY:-}"
REPORT_EMAIL="${REPORT_EMAIL:-}"
FROM_EMAIL="${FROM_EMAIL:-ops@openclaw.dev}"
MRR_BYOK=35
MRR_MANAGED=75
MRR_OPUS=100
DEFAULT_BUDGET=40

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
log() {
    local timestamp
    timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "[${timestamp}] $*" >> "${LOG_FILE}"
}

# ---------------------------------------------------------------------------
# Collect API spend for managed-tier customers
# ---------------------------------------------------------------------------
collect_api_spend() {
    local spend_data="[]"
    local managed_customers
    managed_customers="$(jq -r '.customers[] | select(.status == "active" and (.tier // "byok") == "managed") | "\(.id)|\(.static_ip)|\(.email // "unknown")"' "${CUSTOMERS_FILE}" 2>/dev/null || true)"

    if [[ -z "${managed_customers}" ]]; then
        echo "${spend_data}"
        return 0
    fi

    while IFS='|' read -r customer_id ip email; do
        [[ -z "${customer_id}" ]] && continue

        local stats_json
        stats_json="$(ssh -o StrictHostKeyChecking=no \
            -o ConnectTimeout=10 \
            -o BatchMode=yes \
            -i "${SSH_KEY:-${HOME}/.ssh/id_ed25519}" \
            "${SSH_USER:-ubuntu}@${ip}" \
            "curl -s http://localhost:3141/stats 2>/dev/null" 2>/dev/null)" || stats_json=""

        if [[ -n "${stats_json}" ]] && echo "${stats_json}" | jq -e '.monthly_spend' &>/dev/null; then
            local entry
            entry="$(echo "${stats_json}" | jq -n --input \
                --arg id "${customer_id}" \
                --arg email "${email}" \
                --argjson budget "${DEFAULT_BUDGET}" \
                '{
                    id: $id,
                    email: $email,
                    spend: .monthly_spend,
                    budget: (.budget_limit // $budget),
                    pct: (.budget_pct // ((.monthly_spend / ($budget | tonumber)) * 100) | floor)
                }')"
            spend_data="$(echo "${spend_data}" | jq --argjson e "${entry}" '. + [$e]')"
        else
            local entry
            entry="$(jq -n \
                --arg id "${customer_id}" \
                --arg email "${email}" \
                '{id: $id, email: $email, spend: null, budget: null, pct: null}')"
            spend_data="$(echo "${spend_data}" | jq --argjson e "${entry}" '. + [$e]')"
        fi
    done <<< "${managed_customers}"

    echo "${spend_data}"
}

# ---------------------------------------------------------------------------
# Generate report content
# ---------------------------------------------------------------------------
generate_report() {
    local now
    now="$(date -u '+%Y-%m-%d %H:%M UTC')"
    local week_ago
    week_ago="$(date -u -d '7 days ago' '+%Y-%m-%d' 2>/dev/null || date -u -v-7d '+%Y-%m-%d' 2>/dev/null || echo 'unknown')"

    # --- Customer counts ---
    local total_active
    total_active="$(jq '[.customers[] | select(.status == "active")] | length' "${CUSTOMERS_FILE}")"
    local total_pending_destroy
    total_pending_destroy="$(jq '[.customers[] | select(.status == "pending_destroy")] | length' "${CUSTOMERS_FILE}")"
    local total_all
    total_all="$(jq '.customers | length' "${CUSTOMERS_FILE}")"

    # --- Per-tier counts ---
    local byok_count managed_count opus_count
    byok_count="$(jq '[.customers[] | select(.status == "active" and ((.tier // "byok") == "byok"))] | length' "${CUSTOMERS_FILE}")"
    managed_count="$(jq '[.customers[] | select(.status == "active" and .tier == "managed")] | length' "${CUSTOMERS_FILE}")"
    opus_count="$(jq '[.customers[] | select(.status == "active" and .tier == "opus")] | length' "${CUSTOMERS_FILE}")"
    local mrr=$(( byok_count * MRR_BYOK + managed_count * MRR_MANAGED + opus_count * MRR_OPUS ))

    # --- API spend data for managed tier ---
    local api_spend_data
    api_spend_data="$(collect_api_spend)"

    # --- New customers this week ---
    local new_customers
    new_customers="$(jq -r --arg since "${week_ago}" \
        '[.customers[] | select(.created_at >= $since and .status == "active")] | length' \
        "${CUSTOMERS_FILE}" 2>/dev/null || echo "0")"

    # --- Churned customers this week ---
    local churned_customers
    churned_customers="$(jq -r --arg since "${week_ago}" \
        '[.customers[] | select(.destroy_scheduled_at != null and .destroy_scheduled_at >= $since)] | length' \
        "${CUSTOMERS_FILE}" 2>/dev/null || echo "0")"

    # --- Health state ---
    local instances_down=0
    if [[ -f "${STATE_FILE}" ]]; then
        instances_down="$(jq 'length' "${STATE_FILE}" 2>/dev/null || echo "0")"
    fi
    local instances_up=$(( total_active - instances_down ))

    # --- Disk warnings from latest metrics ---
    local disk_warnings=""
    if [[ -f "${METRICS_FILE}" ]]; then
        disk_warnings="$(jq -r '
            (sort_by(.date) | last // empty) |
            .instances[]? |
            select(.disk_pct > 80) |
            "  - \(.id): \(.disk_pct)% disk used"
        ' "${METRICS_FILE}" 2>/dev/null || true)"
    fi

    # --- Instances that went down this week ---
    local down_this_week=""
    if [[ -f "${STATE_FILE}" ]]; then
        down_this_week="$(jq -r --arg since "${week_ago}" '
            to_entries[] |
            select(.value.first_failure >= $since) |
            "  - \(.key): down since \(.value.first_failure)"
        ' "${STATE_FILE}" 2>/dev/null || true)"
    fi

    # --- Build report ---
    local report=""
    report+="OPENCLAW WEEKLY REPORT"$'\n'
    report+="Generated: ${now}"$'\n'
    report+="Period: ${week_ago} to $(date -u '+%Y-%m-%d')"$'\n'
    report+="================================================"$'\n'
    report+=""$'\n'
    report+="CUSTOMERS"$'\n'
    report+="  Active:            ${total_active}"$'\n'
    report+="  Pending destroy:   ${total_pending_destroy}"$'\n'
    report+="  Total (all time):  ${total_all}"$'\n'
    report+="  New this week:     ${new_customers}"$'\n'
    report+="  Churned this week: ${churned_customers}"$'\n'
    report+=""$'\n'
    report+="REVENUE"$'\n'
    report+="  MRR: \$${mrr} (${byok_count}x\$${MRR_BYOK} + ${managed_count}x\$${MRR_MANAGED} + ${opus_count}x\$${MRR_OPUS})"$'\n'
    report+=""$'\n'
    report+="INSTANCE HEALTH"$'\n'
    report+="  Up:   ${instances_up}"$'\n'
    report+="  Down: ${instances_down}"$'\n'

    if [[ -n "${down_this_week}" ]]; then
        report+=""$'\n'
        report+="INSTANCES DOWN THIS WEEK"$'\n'
        report+="${down_this_week}"$'\n'
    fi

    if [[ -n "${disk_warnings}" ]]; then
        report+=""$'\n'
        report+="DISK USAGE WARNINGS (>80%)"$'\n'
        report+="${disk_warnings}"$'\n'
    fi

    # --- API Usage section for managed tier ---
    local api_total_cost
    api_total_cost="$(echo "${api_spend_data}" | jq '[.[] | select(.spend != null) | .spend] | add // 0')"
    local api_customer_count
    api_customer_count="$(echo "${api_spend_data}" | jq '[.[] | select(.spend != null)] | length')"

    if [[ "$(echo "${api_spend_data}" | jq 'length')" -gt 0 ]]; then
        report+=""$'\n'
        report+="API USAGE (Managed Tier)"$'\n'
        report+="  $(printf '%-20s %-10s %-10s %-7s %s' 'Customer' 'Spend' 'Budget' '%' 'Status')"$'\n'

        while IFS='|' read -r cid spend budget pct; do
            [[ -z "${cid}" ]] && continue
            local status="OK"
            if [[ "${spend}" == "null" ]]; then
                report+="  $(printf '%-20s %-10s %-10s %-7s %s' "${cid}" 'N/A' 'N/A' 'N/A' 'N/A')"$'\n'
                continue
            fi
            if [[ "${pct}" -ge 100 ]]; then
                status="OVER"
            elif [[ "${pct}" -ge 80 ]]; then
                status="WARN"
            fi
            report+="  $(printf '%-20s $%-9s $%-9s %-6s%% %s' "${cid}" "${spend}" "${budget}" "${pct}" "${status}")"$'\n'
        done < <(echo "${api_spend_data}" | jq -r '.[] | "\(.id)|\(.spend)|\(.budget)|\(.pct)"')

        report+=""$'\n'
        local api_avg
        if [[ "${api_customer_count}" -gt 0 ]]; then
            api_avg="$(echo "${api_spend_data}" | jq '[.[] | select(.spend != null) | .spend] | add / length | . * 100 | round / 100')"
        else
            api_avg="0"
        fi
        report+="  Total API cost:    \$${api_total_cost}"$'\n'
        report+="  Avg per customer:  \$${api_avg}"$'\n'
    fi

    # --- Margin analysis ---
    local lightsail_cost=$(( total_active * 10 ))
    local total_margin
    total_margin="$(echo "${mrr} ${lightsail_cost} ${api_total_cost}" | awk '{printf "%.2f", $1 - $2 - $3}')"
    local margin_pct
    if [[ "${mrr}" -gt 0 ]]; then
        margin_pct="$(echo "${total_margin} ${mrr}" | awk '{printf "%d", ($1 / $2) * 100}')"
    else
        margin_pct="0"
    fi

    report+=""$'\n'
    report+="MARGIN ANALYSIS"$'\n'
    report+="  Revenue (MRR):     \$${mrr}.00"$'\n'
    report+="  Lightsail costs:   \$${lightsail_cost}.00"$'\n'
    report+="  API costs:         \$${api_total_cost}"$'\n'
    report+="  Total margin:      \$${total_margin} (${margin_pct}%)"$'\n'

    # --- Customers over budget ---
    local over_budget=""
    over_budget="$(echo "${api_spend_data}" | jq -r '.[] | select(.pct != null and .pct >= 80) | "\(.id)|\(.email)|\(.spend)|\(.budget)|\(.pct)"' 2>/dev/null || true)"

    if [[ -n "${over_budget}" ]]; then
        report+=""$'\n'
        report+="CUSTOMERS OVER BUDGET"$'\n'
        while IFS='|' read -r cid email spend budget pct; do
            [[ -z "${cid}" ]] && continue
            local label="approaching limit"
            if [[ "${pct}" -ge 100 ]]; then
                label="over limit"
            fi
            report+="  ${cid} (${email}): \$${spend} / \$${budget} (${pct}%) -- ${label}"$'\n'
        done <<< "${over_budget}"
    fi

    report+=""$'\n'
    report+="================================================"$'\n'
    report+="End of report"$'\n'

    echo "${report}"
}

# ---------------------------------------------------------------------------
# Send email via Resend API
# ---------------------------------------------------------------------------
send_email() {
    local report="$1"

    if [[ -z "${RESEND_API_KEY}" || -z "${REPORT_EMAIL}" ]]; then
        log "WARN: RESEND_API_KEY or REPORT_EMAIL not set, skipping email"
        return 0
    fi

    local subject="OpenClaw Weekly Report - $(date -u '+%Y-%m-%d')"
    local payload
    payload="$(jq -n \
        --arg from "${FROM_EMAIL}" \
        --arg to "${REPORT_EMAIL}" \
        --arg subject "${subject}" \
        --arg text "${report}" \
        '{from: $from, to: [$to], subject: $subject, text: $text}')"

    if curl -s -o /dev/null -w '' \
        -X POST "https://api.resend.com/emails" \
        -H "Authorization: Bearer ${RESEND_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "${payload}"; then
        log "INFO: Email sent to ${REPORT_EMAIL}"
    else
        log "ERROR: Failed to send email"
    fi
}

# ---------------------------------------------------------------------------
# Send Discord message
# ---------------------------------------------------------------------------
send_discord() {
    local report="$1"

    if [[ -z "${DISCORD_WEBHOOK}" ]]; then
        log "WARN: DISCORD_OPS_WEBHOOK_URL not set, skipping Discord"
        return 0
    fi

    # Discord messages have a 2000-char limit; wrap in code block
    local content
    content="\`\`\`\n${report}\n\`\`\`"

    # Truncate if too long
    if [[ ${#content} -gt 1990 ]]; then
        content="${content:0:1987}..."
    fi

    local payload
    payload="$(jq -n --arg c "${content}" '{content: $c}')"

    if curl -s -o /dev/null -w '' \
        -H "Content-Type: application/json" \
        -d "${payload}" "${DISCORD_WEBHOOK}"; then
        log "INFO: Discord report posted"
    else
        log "ERROR: Failed to post to Discord"
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

    log "INFO: Generating weekly report..."

    local report
    report="$(generate_report)"

    # Print to stdout (useful for manual runs)
    echo "${report}"

    # Send via email and Discord
    send_email "${report}"
    send_discord "${report}"

    log "INFO: Weekly report complete"
}

main "$@"
