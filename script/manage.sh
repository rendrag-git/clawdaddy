#!/usr/bin/env bash
###############################################################################
# OpenClaw Tier 2 — Customer Management CLI
# Copyright (c) 2025 OpenClaw. All rights reserved.
#
# Manages Lightsail-based customer instances provisioned by provision.sh.
# Reads/writes customers.json in the same directory as this script.
#
# Usage:
#   bash manage.sh <command> [args]
#
# Commands:
#   list                          Show all customers (formatted table)
#   health                        Ping health endpoint on all active instances
#   stop    <id_or_email>         Stop a customer's Lightsail instance
#   start   <id_or_email>         Start a customer's Lightsail instance
#   restart <id_or_email>         Restart (stop + start) a customer's instance
#   destroy <id_or_email>         Snapshot, archive, and delete an instance
#   update-all                    Update openclaw on every active instance
#   ssh     <id_or_email>         SSH into a customer's instance
#   logs    <id_or_email>         Tail openclaw service logs on instance
#   usage   <id_or_email>         Show API usage stats for a customer
#   budget  <id_or_email> <amt>   Update a customer's monthly budget limit
#   usage-report                  Show usage report for all managed customers
#   margins                       Show margin analysis for all customers
#
# Requirements: bash 4+, jq, aws cli (configured), curl, ssh
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CUSTOMERS_FILE="${SCRIPT_DIR}/customers.json"
SSH_KEY="${HOME}/.ssh/lightsail_key"
HEALTH_PORT=8080
HEALTH_PATH="/health"
HEALTH_TIMEOUT=5
STATS_PORT=3141

# ---------------------------------------------------------------------------
# Colors & formatting
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

readonly RED GREEN YELLOW CYAN BOLD DIM RESET

# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------
info()  { echo -e "${CYAN}[info]${RESET}  $*"; }
ok()    { echo -e "${GREEN} [ok]${RESET}  $*"; }
warn()  { echo -e "${YELLOW}[warn]${RESET}  $*"; }
fail()  { echo -e "${RED}[fail]${RESET}  $*"; }
die()   { fail "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------
require_jq() {
    if ! command -v jq &>/dev/null; then
        die "jq is required but not installed. Install it with: sudo apt install jq"
    fi
}

require_aws() {
    if ! command -v aws &>/dev/null; then
        die "AWS CLI is required but not installed. See: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
    fi
}

require_customers_file() {
    if [[ ! -f "${CUSTOMERS_FILE}" ]]; then
        die "customers.json not found at ${CUSTOMERS_FILE}. Run provision.sh first to create it."
    fi
}

# ---------------------------------------------------------------------------
# Customer lookup
# ---------------------------------------------------------------------------
# find_customer <id_or_email>
# Prints the JSON object for a customer matched by id or email.
# Returns 1 if not found.
find_customer() {
    local query="$1"
    local result

    # Try matching by id first, then by email
    result=$(jq -e --arg q "${query}" \
        '.customers[] | select(.id == $q or .email == $q)' \
        "${CUSTOMERS_FILE}" 2>/dev/null) || true

    if [[ -z "${result}" ]]; then
        die "Customer not found: ${query}"
    fi

    echo "${result}"
}

# find_customer_index <id_or_email>
# Prints the array index (0-based) of the matching customer.
find_customer_index() {
    local query="$1"
    local idx

    idx=$(jq --arg q "${query}" \
        '.customers | to_entries[] | select(.value.id == $q or .value.email == $q) | .key' \
        "${CUSTOMERS_FILE}" 2>/dev/null) || true

    if [[ -z "${idx}" ]]; then
        die "Customer not found: ${query}"
    fi

    echo "${idx}"
}

# ---------------------------------------------------------------------------
# Customer status update
# ---------------------------------------------------------------------------
# update_customer_status <id_or_email> <new_status> [extra_jq_updates]
# Updates status and updated_at. Optional third arg is additional jq expression
# applied to the customer object (e.g., '| .destroyed_at = "2025-01-01"').
update_customer_status() {
    local query="$1"
    local new_status="$2"
    local extra="${3:-}"
    local idx
    local now

    idx=$(find_customer_index "${query}")
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    local jq_expr=".customers[${idx}].status = \"${new_status}\" | .customers[${idx}].updated_at = \"${now}\""
    if [[ -n "${extra}" ]]; then
        jq_expr="${jq_expr} | .customers[${idx}]${extra}"
    fi

    local tmp
    tmp=$(mktemp)
    jq "${jq_expr}" "${CUSTOMERS_FILE}" > "${tmp}" && mv "${tmp}" "${CUSTOMERS_FILE}"
}

# ---------------------------------------------------------------------------
# get_instance_name <customer_json>
# Extracts the Lightsail instance name from a customer JSON object.
# ---------------------------------------------------------------------------
get_instance_name() {
    echo "$1" | jq -r '.instance_id // ("openclaw-" + .id)'
}

# get_region <customer_json>
get_region() {
    echo "$1" | jq -r '.region // "us-east-1"'
}

# get_ip <customer_json>
get_ip() {
    echo "$1" | jq -r '.static_ip // .ip // empty'
}

# get_id <customer_json>
get_id() {
    echo "$1" | jq -r '.id'
}

# get_email <customer_json>
get_email() {
    echo "$1" | jq -r '.email'
}

# get_tier <customer_json>
# Extract tier field; defaults to "byok" for legacy records.
get_tier() {
    echo "$1" | jq -r '.tier // "byok"'
}

# ssh_curl_stats <ip>
# SSH into an instance and curl the proxy stats endpoint. Returns JSON.
ssh_curl_stats() {
    local ip="$1"
    ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
        "ubuntu@${ip}" \
        "curl -s http://localhost:${STATS_PORT}/stats" 2>/dev/null
}

# progress_bar <percentage> <width>
# Renders a block-character progress bar for the given percentage.
progress_bar() {
    local pct="$1"
    local width="${2:-30}"
    local filled empty

    filled=$(awk "BEGIN { printf \"%d\", ${pct} / 100 * ${width} }")
    empty=$(( width - filled ))

    local bar=""
    for (( i = 0; i < filled; i++ )); do bar+="█"; done
    for (( i = 0; i < empty;  i++ )); do bar+="░"; done
    echo "${bar}"
}

# tier_price <tier>
# Returns the monthly revenue price for a given tier.
tier_price() {
    case "$1" in
        byok)          echo "35.00" ;;
        managed)       echo "75.00" ;;
        managed+opus)  echo "100.00" ;;
        *)             echo "35.00" ;;
    esac
}

# ---------------------------------------------------------------------------
# Subcommand: list
# ---------------------------------------------------------------------------
cmd_list() {
    require_jq
    require_customers_file

    local count
    count=$(jq '.customers | length' "${CUSTOMERS_FILE}")

    if (( count == 0 )); then
        info "No customers found in ${CUSTOMERS_FILE}."
        return 0
    fi

    echo ""
    echo -e "${BOLD}  Customers (${count})${RESET}"
    echo ""

    # Header
    printf "  ${BOLD}%-14s %-30s %-12s %-14s %-16s %-14s %-12s${RESET}\n" \
        "ID" "EMAIL" "STATUS" "TIER" "IP" "REGION" "CREATED"
    printf "  %-14s %-30s %-12s %-14s %-16s %-14s %-12s\n" \
        "--------------" "------------------------------" "------------" \
        "--------------" "----------------" "--------------" "------------"

    # Rows
    jq -r '.customers[] | [.id, .email, .status, (.tier // "byok"), (.static_ip // .ip // "n/a"), (.region // "n/a"), (.created_at // "n/a")] | @tsv' \
        "${CUSTOMERS_FILE}" | while IFS=$'\t' read -r id email status tier ip region created; do

        # Color-code status
        local status_display
        case "${status}" in
            active)
                status_display="${GREEN}${status}${RESET}"
                ;;
            suspended|stopped)
                status_display="${YELLOW}${status}${RESET}"
                ;;
            failed|destroyed)
                status_display="${RED}${status}${RESET}"
                ;;
            *)
                status_display="${DIM}${status}${RESET}"
                ;;
        esac

        # Truncate created date to date portion
        created="${created:0:10}"

        printf "  %-14s %-30s %-24b %-14s %-16s %-14s %-12s\n" \
            "${id}" "${email}" "${status_display}" "${tier}" "${ip}" "${region}" "${created}"
    done

    echo ""
}

# ---------------------------------------------------------------------------
# Subcommand: health
# ---------------------------------------------------------------------------
cmd_health() {
    require_jq
    require_customers_file

    local active_count
    active_count=$(jq '[.customers[] | select(.status == "active")] | length' "${CUSTOMERS_FILE}")

    if (( active_count == 0 )); then
        info "No active customers to check."
        return 0
    fi

    echo ""
    echo -e "${BOLD}  Health Check (${active_count} active instances)${RESET}"
    echo ""

    printf "  ${BOLD}%-14s %-30s %-16s %-10s %-10s${RESET}\n" \
        "ID" "EMAIL" "IP" "STATUS" "RESPONSE"
    printf "  %-14s %-30s %-16s %-10s %-10s\n" \
        "--------------" "------------------------------" \
        "----------------" "----------" "----------"

    jq -r '.customers[] | select(.status == "active") | [.id, .email, (.static_ip // "")] | @tsv' \
        "${CUSTOMERS_FILE}" | while IFS=$'\t' read -r id email ip; do

        if [[ -z "${ip}" || "${ip}" == "null" ]]; then
            printf "  %-14s %-30s %-16s ${YELLOW}%-10s${RESET} %-10s\n" \
                "${id}" "${email}" "n/a" "NO IP" "-"
            continue
        fi

        local url="http://${ip}:${HEALTH_PORT}${HEALTH_PATH}"
        local start_time end_time elapsed http_code

        start_time=$(date +%s%N)
        http_code=$(curl -s -o /dev/null -w "%{http_code}" \
            --connect-timeout "${HEALTH_TIMEOUT}" \
            --max-time "${HEALTH_TIMEOUT}" \
            "${url}" 2>/dev/null) || http_code="000"
        end_time=$(date +%s%N)

        # Calculate response time in ms
        elapsed=$(( (end_time - start_time) / 1000000 ))

        local status_display time_display
        if [[ "${http_code}" == "200" ]]; then
            status_display="${GREEN}UP${RESET}"
            time_display="${elapsed}ms"
        else
            status_display="${RED}DOWN${RESET}"
            time_display="${RED}${http_code}${RESET}"
        fi

        printf "  %-14s %-30s %-16s %-22b %-10b\n" \
            "${id}" "${email}" "${ip}" "${status_display}" "${time_display}"
    done

    echo ""
}

# ---------------------------------------------------------------------------
# Subcommand: stop <id_or_email>
# ---------------------------------------------------------------------------
cmd_stop() {
    local query="${1:?Usage: manage.sh stop <customer_id_or_email>}"

    require_jq
    require_aws
    require_customers_file

    local customer instance_name region id email
    customer=$(find_customer "${query}")
    instance_name=$(get_instance_name "${customer}")
    region=$(get_region "${customer}")
    id=$(get_id "${customer}")
    email=$(get_email "${customer}")

    info "Stopping instance ${BOLD}${instance_name}${RESET} (${email}) in ${region}..."

    aws lightsail stop-instance \
        --instance-name "${instance_name}" \
        --region "${region}" 2>&1 || die "Failed to stop instance ${instance_name}"

    update_customer_status "${id}" "suspended"
    ok "Instance ${instance_name} stopped. Status set to suspended."
}

# ---------------------------------------------------------------------------
# Subcommand: start <id_or_email>
# ---------------------------------------------------------------------------
cmd_start() {
    local query="${1:?Usage: manage.sh start <customer_id_or_email>}"

    require_jq
    require_aws
    require_customers_file

    local customer instance_name region id email
    customer=$(find_customer "${query}")
    instance_name=$(get_instance_name "${customer}")
    region=$(get_region "${customer}")
    id=$(get_id "${customer}")
    email=$(get_email "${customer}")

    info "Starting instance ${BOLD}${instance_name}${RESET} (${email}) in ${region}..."

    aws lightsail start-instance \
        --instance-name "${instance_name}" \
        --region "${region}" 2>&1 || die "Failed to start instance ${instance_name}"

    update_customer_status "${id}" "active"
    ok "Instance ${instance_name} started. Status set to active."
}

# ---------------------------------------------------------------------------
# Subcommand: restart <id_or_email>
# ---------------------------------------------------------------------------
cmd_restart() {
    local query="${1:?Usage: manage.sh restart <customer_id_or_email>}"

    require_jq
    require_aws
    require_customers_file

    local customer instance_name region id email
    customer=$(find_customer "${query}")
    instance_name=$(get_instance_name "${customer}")
    region=$(get_region "${customer}")
    id=$(get_id "${customer}")
    email=$(get_email "${customer}")

    info "Restarting instance ${BOLD}${instance_name}${RESET} (${email})..."

    info "Stopping..."
    aws lightsail stop-instance \
        --instance-name "${instance_name}" \
        --region "${region}" 2>&1 || die "Failed to stop instance ${instance_name}"

    # Wait for instance to fully stop before starting
    info "Waiting for instance to stop..."
    local attempts=0
    while (( attempts < 60 )); do
        local state
        state=$(aws lightsail get-instance-state \
            --instance-name "${instance_name}" \
            --region "${region}" \
            --query 'state.name' --output text 2>/dev/null) || true

        if [[ "${state}" == "stopped" ]]; then
            break
        fi
        attempts=$((attempts + 1))
        sleep 5
    done

    info "Starting..."
    aws lightsail start-instance \
        --instance-name "${instance_name}" \
        --region "${region}" 2>&1 || die "Failed to start instance ${instance_name}"

    update_customer_status "${id}" "active"
    ok "Instance ${instance_name} restarted. Status set to active."
}

# ---------------------------------------------------------------------------
# Subcommand: destroy <id_or_email>
# ---------------------------------------------------------------------------
cmd_destroy() {
    local query="${1:?Usage: manage.sh destroy <customer_id_or_email>}"
    local force="${2:-}"

    require_jq
    require_aws
    require_customers_file

    local customer instance_name region id email ip
    customer=$(find_customer "${query}")
    instance_name=$(get_instance_name "${customer}")
    region=$(get_region "${customer}")
    id=$(get_id "${customer}")
    email=$(get_email "${customer}")
    ip=$(get_ip "${customer}")

    echo ""
    warn "This will permanently destroy the instance for:"
    echo -e "    Customer : ${BOLD}${email}${RESET} (${id})"
    echo -e "    Instance : ${BOLD}${instance_name}${RESET}"
    echo -e "    Region   : ${region}"
    echo -e "    IP       : ${ip:-n/a}"
    echo ""

    if [[ "${force}" != "--force" ]]; then
        read -r -p "  Type 'destroy' to confirm: " confirmation
        if [[ "${confirmation}" != "destroy" ]]; then
            info "Destroy cancelled."
            return 0
        fi
    fi

    echo ""
    local now_tag
    now_tag=$(date -u +"%Y%m%d-%H%M%S")
    local snapshot_name="${instance_name}-final-${now_tag}"

    # Step 1: Create snapshot
    info "Creating snapshot: ${snapshot_name}..."
    aws lightsail create-instance-snapshot \
        --instance-name "${instance_name}" \
        --instance-snapshot-name "${snapshot_name}" \
        --region "${region}" 2>&1 || warn "Snapshot creation failed (instance may already be stopped)"

    ok "Snapshot requested: ${snapshot_name}"
    info "Note: Snapshot retained in Lightsail for 7 days. Tag or export to S3 if longer retention needed."

    # Step 2: Release static IP (if assigned)
    local static_ip_name
    static_ip_name=$(echo "${customer}" | jq -r '.static_ip_name // empty')

    if [[ -n "${static_ip_name}" ]]; then
        info "Releasing static IP: ${static_ip_name}..."
        aws lightsail detach-static-ip \
            --static-ip-name "${static_ip_name}" \
            --region "${region}" 2>/dev/null || true
        aws lightsail release-static-ip \
            --static-ip-name "${static_ip_name}" \
            --region "${region}" 2>/dev/null || true
        ok "Static IP released."
    else
        info "Instance uses dynamic IP (no static IP cleanup needed)"
    fi

    # Step 3: Delete instance
    info "Deleting instance: ${instance_name}..."
    aws lightsail delete-instance \
        --instance-name "${instance_name}" \
        --region "${region}" 2>&1 || die "Failed to delete instance ${instance_name}"

    ok "Instance ${instance_name} deleted."

    # Step 4: Update customers.json
    local destroyed_at
    destroyed_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    update_customer_status "${id}" "destroyed" \
        ".destroyed_at = \"${destroyed_at}\" | .snapshot = \"${snapshot_name}\""

    echo ""
    ok "Customer ${email} (${id}) destroyed."
    echo -e "    Snapshot : ${snapshot_name}"
    echo -e "    Status   : ${RED}destroyed${RESET}"
    echo ""
}

# ---------------------------------------------------------------------------
# Subcommand: update-all
# ---------------------------------------------------------------------------
cmd_update_all() {
    require_jq
    require_aws
    require_customers_file

    local active_count
    active_count=$(jq '[.customers[] | select(.status == "active")] | length' "${CUSTOMERS_FILE}")

    if (( active_count == 0 )); then
        info "No active customers to update."
        return 0
    fi

    echo ""
    echo -e "${BOLD}  Updating OpenClaw on ${active_count} active instance(s)${RESET}"
    echo ""

    local success=0
    local failed=0
    local idx=0

    jq -r '.customers[] | select(.status == "active") | [.id, .email, (.static_ip // ""), (.region // "us-east-1")] | @tsv' \
        "${CUSTOMERS_FILE}" | while IFS=$'\t' read -r id email ip region; do

        idx=$((idx + 1))
        echo -e "  ${BOLD}[${idx}/${active_count}]${RESET} ${email} (${ip})"

        if [[ -z "${ip}" || "${ip}" == "null" ]]; then
            fail "    No IP address — skipping"
            failed=$((failed + 1))
            continue
        fi

        info "    Connecting via SSH..."
        if ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
            "ubuntu@${ip}" \
            "sudo npm update -g openclaw && sudo systemctl restart openclaw" 2>&1; then
            ok "    Updated and restarted successfully"
            success=$((success + 1))
        else
            fail "    Update failed on ${ip}"
            failed=$((failed + 1))
        fi

        echo ""
    done

    echo -e "  ${BOLD}Update complete.${RESET}"
    echo ""
}

# ---------------------------------------------------------------------------
# Subcommand: ssh <id_or_email>
# ---------------------------------------------------------------------------
cmd_ssh() {
    local query="${1:?Usage: manage.sh ssh <customer_id_or_email>}"

    require_jq
    require_customers_file

    local customer ip id email
    customer=$(find_customer "${query}")
    ip=$(get_ip "${customer}")
    id=$(get_id "${customer}")
    email=$(get_email "${customer}")

    if [[ -z "${ip}" || "${ip}" == "null" ]]; then
        die "No IP address for customer ${email} (${id})"
    fi

    local ssh_cmd="ssh -i ${SSH_KEY} ubuntu@${ip}"
    info "Connecting to ${BOLD}${email}${RESET} (${ip})..."
    echo -e "  ${DIM}${ssh_cmd}${RESET}"
    echo ""

    exec ${ssh_cmd}
}

# ---------------------------------------------------------------------------
# Subcommand: logs <id_or_email>
# ---------------------------------------------------------------------------
cmd_logs() {
    local query="${1:?Usage: manage.sh logs <customer_id_or_email>}"

    require_jq
    require_customers_file

    local customer ip id email
    customer=$(find_customer "${query}")
    ip=$(get_ip "${customer}")
    id=$(get_id "${customer}")
    email=$(get_email "${customer}")

    if [[ -z "${ip}" || "${ip}" == "null" ]]; then
        die "No IP address for customer ${email} (${id})"
    fi

    info "Tailing logs for ${BOLD}${email}${RESET} (${ip})..."
    echo -e "  ${DIM}journalctl -u openclaw -f --no-pager -n 100${RESET}"
    echo ""

    ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
        "ubuntu@${ip}" \
        "sudo journalctl -u openclaw -f --no-pager -n 100"
}

# ---------------------------------------------------------------------------
# Subcommand: usage <id_or_email>
# ---------------------------------------------------------------------------
cmd_usage() {
    local query="${1:?Usage: manage.sh usage <customer_id_or_email>}"

    require_jq
    require_customers_file

    local customer ip id email tier
    customer=$(find_customer "${query}")
    ip=$(get_ip "${customer}")
    id=$(get_id "${customer}")
    email=$(get_email "${customer}")
    tier=$(get_tier "${customer}")

    if [[ "${tier}" == "byok" ]]; then
        info "Usage tracking not available for BYOK tier"
        return 0
    fi

    if [[ -z "${ip}" || "${ip}" == "null" ]]; then
        die "No IP address for customer ${email} (${id})"
    fi

    info "Fetching usage stats for ${BOLD}${email}${RESET}..."

    local stats
    stats=$(ssh_curl_stats "${ip}") || die "Failed to fetch stats from ${ip}"

    if [[ -z "${stats}" ]]; then
        die "Empty response from stats endpoint on ${ip}"
    fi

    local budget spend pct billing_cycle billing_cycle_start
    budget=$(echo "${stats}" | jq -r '.budget_limit // 0')
    spend=$(echo "${stats}" | jq -r '.monthly_spend // 0')
    billing_cycle=$(echo "${stats}" | jq -r '.billing_cycle // "unknown"')
    billing_cycle_start=$(echo "${stats}" | jq -r '.billing_cycle_start // 1')

    # Calculate percentage
    if (( $(echo "${budget} > 0" | bc -l) )); then
        pct=$(awk "BEGIN { printf \"%.1f\", ${spend} / ${budget} * 100 }")
    else
        pct="0.0"
    fi

    local bar
    bar=$(progress_bar "${pct%.*}")

    echo ""
    echo -e "${BOLD}Usage for ${email} (${id})${RESET}"
    echo -e "Tier: ${tier} | Budget: \$${budget}/mo | Billing cycle: ${billing_cycle} (starts day ${billing_cycle_start})"
    echo ""
    printf "Current Month Spend: \$%s / \$%s (%s%%)\n" "${spend}" "${budget}" "${pct}"
    echo -e "${GREEN}${bar}${RESET} ${pct}%"
    echo ""

    # Model breakdown
    local model_count
    model_count=$(echo "${stats}" | jq '.model_breakdown | length // 0')

    if (( model_count > 0 )); then
        echo -e "${BOLD}Model Breakdown:${RESET}"
        echo "${stats}" | jq -r '.model_breakdown[] | "  \(.model)  $\(.cost)  (\(.requests) requests)"'
        echo ""
    fi

    # Daily trend (last 7 days)
    local day_count
    day_count=$(echo "${stats}" | jq '.daily_breakdown | length // 0')

    if (( day_count > 0 )); then
        echo -e "${BOLD}Daily Trend (last 7 days):${RESET}"
        local max_daily
        max_daily=$(echo "${stats}" | jq '[.daily_breakdown[].spend] | max // 1')

        echo "${stats}" | jq -r '.daily_breakdown[-7:][] | "\(.date)\t\(.spend)"' | while IFS=$'\t' read -r day_date day_spend; do
            local bar_width
            bar_width=$(awk "BEGIN { w = int(${day_spend} / ${max_daily} * 30); if (w < 1) w = 1; printf \"%d\", w }")
            local day_bar=""
            for (( b = 0; b < bar_width; b++ )); do day_bar+="█"; done
            printf "  %-12s \$%-8s %s\n" "${day_date}" "${day_spend}" "${day_bar}"
        done
        echo ""
    fi
}

# ---------------------------------------------------------------------------
# Subcommand: budget <id_or_email> <amount>
# ---------------------------------------------------------------------------
cmd_budget() {
    local query="${1:?Usage: manage.sh budget <customer_id_or_email> <amount>}"
    local amount="${2:?Usage: manage.sh budget <customer_id_or_email> <amount>}"

    require_jq
    require_customers_file

    local customer ip id email tier idx
    customer=$(find_customer "${query}")
    ip=$(get_ip "${customer}")
    id=$(get_id "${customer}")
    email=$(get_email "${customer}")
    tier=$(get_tier "${customer}")
    idx=$(find_customer_index "${query}")

    if [[ "${tier}" == "byok" ]]; then
        die "Cannot set budget for BYOK tier customer"
    fi

    if [[ -z "${ip}" || "${ip}" == "null" ]]; then
        die "No IP address for customer ${email} (${id})"
    fi

    # Validate amount is a number
    if ! echo "${amount}" | grep -qE '^[0-9]+(\.[0-9]{1,2})?$'; then
        die "Invalid amount: ${amount}. Use a number like 40 or 40.00"
    fi

    local old_budget
    old_budget=$(echo "${customer}" | jq -r '.budget_limit // "not set"')

    info "Updating budget for ${BOLD}${email}${RESET}..."
    echo -e "  Old budget: \$${old_budget}"
    echo -e "  New budget: \$${amount}"

    # Update customers.json
    local now tmp
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    tmp=$(mktemp)
    jq ".customers[${idx}].budget_limit = ${amount} | .customers[${idx}].updated_at = \"${now}\"" \
        "${CUSTOMERS_FILE}" > "${tmp}" && mv "${tmp}" "${CUSTOMERS_FILE}"

    # Update remote .env and restart proxy
    info "Updating BUDGET_LIMIT on instance ${ip}..."
    ssh -i "${SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
        "ubuntu@${ip}" \
        "sudo sed -i 's/^BUDGET_LIMIT=.*/BUDGET_LIMIT=${amount}/' /opt/openclaw-proxy/.env && sudo systemctl restart openclaw-proxy" \
        2>&1 || die "Failed to update budget on instance ${ip}"

    ok "Budget updated to \$${amount}/mo for ${email} (${id})"
    ok "Proxy service restarted on ${ip}"
}

# ---------------------------------------------------------------------------
# Subcommand: usage-report
# ---------------------------------------------------------------------------
cmd_usage_report() {
    require_jq
    require_customers_file

    local billing_period
    billing_period=$(date -u +"%Y-%m")

    echo ""
    echo -e "${BOLD}  Monthly Usage Report — Billing Period: ${billing_period}${RESET}"
    echo ""

    printf "  ${BOLD}%-14s %-30s %-12s %-10s %-10s %-6s %-10s${RESET}\n" \
        "ID" "EMAIL" "TIER" "BUDGET" "SPEND" "%" "STATUS"
    printf "  %-14s %-30s %-12s %-10s %-10s %-6s %-10s\n" \
        "--------------" "------------------------------" "------------" \
        "----------" "----------" "------" "----------"

    local total_spend=0
    local managed_count=0

    jq -r '.customers[] | select(.status == "active") | [.id, .email, (.tier // "byok"), (.budget_limit // 0), (.static_ip // .ip // ""), (.status // "unknown")] | @tsv' \
        "${CUSTOMERS_FILE}" | while IFS=$'\t' read -r id email tier budget ip status; do

        local spend="-" pct_display="-" status_label="N/A"

        if [[ "${tier}" != "byok" ]]; then
            managed_count=$((managed_count + 1))

            if [[ -n "${ip}" && "${ip}" != "null" ]]; then
                local stats
                stats=$(ssh_curl_stats "${ip}" 2>/dev/null) || stats=""

                if [[ -n "${stats}" ]]; then
                    spend=$(echo "${stats}" | jq -r '.monthly_spend // 0')
                    total_spend=$(awk "BEGIN { printf \"%.2f\", ${total_spend} + ${spend} }")

                    if (( $(echo "${budget} > 0" | bc -l) )); then
                        local pct
                        pct=$(awk "BEGIN { printf \"%d\", ${spend} / ${budget} * 100 }")
                        pct_display="${pct}%"

                        if (( pct >= 80 )); then
                            status_label="${YELLOW}WARN${RESET}"
                        else
                            status_label="${GREEN}OK${RESET}"
                        fi
                    else
                        pct_display="-"
                        status_label="OK"
                    fi

                    spend="\$${spend}"
                else
                    spend="err"
                    pct_display="-"
                    status_label="${RED}ERR${RESET}"
                fi
            else
                spend="-"
                status_label="${RED}NO IP${RESET}"
            fi

            budget="\$${budget}"
        else
            budget="-"
            spend="-"
            pct_display="-"
            status_label="${DIM}N/A${RESET}"
        fi

        printf "  %-14s %-30s %-12s %-10s %-10s %-18b %-10b\n" \
            "${id}" "${email}" "${tier}" "${budget}" "${spend}" "${pct_display}" "${status_label}"
    done

    echo ""
    # Re-count from the file since subshell vars are lost
    local mc ts
    mc=$(jq '[.customers[] | select(.status == "active" and (.tier // "byok") != "byok")] | length' "${CUSTOMERS_FILE}")
    echo -e "  Total managed customers: ${BOLD}${mc}${RESET}"

    # Total spend requires re-fetching — print a note if non-trivial
    echo -e "  ${DIM}(Total API spend shown per customer above)${RESET}"
    echo ""
}

# ---------------------------------------------------------------------------
# Subcommand: margins
# ---------------------------------------------------------------------------
cmd_margins() {
    require_jq
    require_customers_file

    local billing_period
    billing_period=$(date -u +"%Y-%m")

    echo ""
    echo -e "${BOLD}  Margin Analysis — Current Month (${billing_period})${RESET}"
    echo ""

    printf "  ${BOLD}%-14s %-26s %-14s %-10s %-12s %-10s %-10s %-6s${RESET}\n" \
        "ID" "EMAIL" "TIER" "REVENUE" "LIGHTSAIL" "API COST" "MARGIN" "%"
    printf "  %-14s %-26s %-14s %-10s %-12s %-10s %-10s %-6s\n" \
        "--------------" "--------------------------" "--------------" \
        "----------" "------------" "----------" "----------" "------"

    local total_revenue=0
    local total_lightsail=0
    local total_api=0
    local total_margin=0

    # Use a temp file to accumulate totals from the subshell
    local totals_file
    totals_file=$(mktemp)
    echo "0 0 0 0" > "${totals_file}"

    jq -r '.customers[] | select(.status == "active") | [.id, .email, (.tier // "byok"), (.static_ip // .ip // "")] | @tsv' \
        "${CUSTOMERS_FILE}" | while IFS=$'\t' read -r id email tier ip; do

        local revenue lightsail_cost api_cost margin margin_pct
        revenue=$(tier_price "${tier}")
        lightsail_cost="10.00"
        api_cost="-"
        margin=""
        margin_pct=""

        if [[ "${tier}" != "byok" && -n "${ip}" && "${ip}" != "null" ]]; then
            local stats
            stats=$(ssh_curl_stats "${ip}" 2>/dev/null) || stats=""

            if [[ -n "${stats}" ]]; then
                api_cost=$(echo "${stats}" | jq -r '.monthly_spend // 0')
            else
                api_cost="0"
            fi

            margin=$(awk "BEGIN { printf \"%.2f\", ${revenue} - ${lightsail_cost} - ${api_cost} }")
            margin_pct=$(awk "BEGIN { printf \"%d\", (${margin} / ${revenue}) * 100 }")

            # Accumulate totals
            read -r tr tl ta tm < "${totals_file}"
            tr=$(awk "BEGIN { printf \"%.2f\", ${tr} + ${revenue} }")
            tl=$(awk "BEGIN { printf \"%.2f\", ${tl} + ${lightsail_cost} }")
            ta=$(awk "BEGIN { printf \"%.2f\", ${ta} + ${api_cost} }")
            tm=$(awk "BEGIN { printf \"%.2f\", ${tm} + ${margin} }")
            echo "${tr} ${tl} ${ta} ${tm}" > "${totals_file}"

            api_cost="\$${api_cost}"
        else
            # BYOK or no IP — no API cost
            margin=$(awk "BEGIN { printf \"%.2f\", ${revenue} - ${lightsail_cost} }")
            margin_pct=$(awk "BEGIN { printf \"%d\", (${margin} / ${revenue}) * 100 }")

            read -r tr tl ta tm < "${totals_file}"
            tr=$(awk "BEGIN { printf \"%.2f\", ${tr} + ${revenue} }")
            tl=$(awk "BEGIN { printf \"%.2f\", ${tl} + ${lightsail_cost} }")
            tm=$(awk "BEGIN { printf \"%.2f\", ${tm} + ${margin} }")
            echo "${tr} ${tl} ${ta} ${tm}" > "${totals_file}"
        fi

        local margin_color="${GREEN}"
        if (( $(echo "${margin} < 0" | bc -l 2>/dev/null || echo 0) )); then
            margin_color="${RED}"
        fi

        printf "  %-14s %-26s %-14s \$%-9s \$%-11s %-10s ${margin_color}\$%-9s %s%%${RESET}\n" \
            "${id}" "${email}" "${tier}" "${revenue}" "${lightsail_cost}" "${api_cost}" "${margin}" "${margin_pct}"
    done

    echo ""

    # Read accumulated totals
    read -r total_revenue total_lightsail total_api total_margin < "${totals_file}"
    rm -f "${totals_file}"

    local total_margin_pct=0
    if (( $(echo "${total_revenue} > 0" | bc -l 2>/dev/null || echo 0) )); then
        total_margin_pct=$(awk "BEGIN { printf \"%d\", (${total_margin} / ${total_revenue}) * 100 }")
    fi

    echo -e "  ${BOLD}TOTALS${RESET}"
    printf "    Total Revenue:     \$%s\n" "${total_revenue}"
    printf "    Total Lightsail:   \$%s\n" "${total_lightsail}"
    printf "    Total API Cost:    \$%s\n" "${total_api}"
    printf "    Total Margin:      \$%s (%s%%)\n" "${total_margin}" "${total_margin_pct}"
    echo ""
}

# ---------------------------------------------------------------------------
# Usage / help
# ---------------------------------------------------------------------------
show_usage() {
    cat <<USAGEEOF

${BOLD}OpenClaw — Customer Management CLI${RESET}

${BOLD}USAGE${RESET}
    bash manage.sh <command> [arguments]

${BOLD}COMMANDS${RESET}
    ${CYAN}list${RESET}                            Show all customers in a formatted table
    ${CYAN}health${RESET}                          Ping health endpoint on all active instances
    ${CYAN}stop${RESET}    <id_or_email>           Stop a customer's Lightsail instance
    ${CYAN}start${RESET}   <id_or_email>           Start a customer's Lightsail instance
    ${CYAN}restart${RESET} <id_or_email>           Restart (stop then start) an instance
    ${CYAN}destroy${RESET} <id_or_email>           Snapshot, archive, and delete an instance
    ${CYAN}update-all${RESET}                      Update openclaw on every active instance
    ${CYAN}ssh${RESET}     <id_or_email>           SSH into a customer's instance
    ${CYAN}logs${RESET}    <id_or_email>           Tail openclaw service logs on an instance

  ${BOLD}Managed Tier${RESET}
    ${CYAN}usage${RESET}   <id_or_email>           Show API usage stats for a managed customer
    ${CYAN}budget${RESET}  <id_or_email> <amount>  Update a customer's monthly budget limit
    ${CYAN}usage-report${RESET}                    Show usage report for all managed customers
    ${CYAN}margins${RESET}                         Show margin analysis for all customers

${BOLD}OPTIONS${RESET}
    --help, -h                      Show this help message

${BOLD}EXAMPLES${RESET}
    bash manage.sh list
    bash manage.sh health
    bash manage.sh stop cust_abc123
    bash manage.sh start user@example.com
    bash manage.sh destroy cust_abc123
    bash manage.sh ssh user@example.com
    bash manage.sh logs cust_abc123
    bash manage.sh usage cust_abc123
    bash manage.sh budget cust_abc123 50.00
    bash manage.sh usage-report
    bash manage.sh margins

${BOLD}FILES${RESET}
    customers.json                  Customer database (created by provision.sh)
    ~/.ssh/lightsail_key            SSH private key for instance access

USAGEEOF
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    local command="${1:-}"
    shift 2>/dev/null || true

    case "${command}" in
        list)
            require_jq
            cmd_list
            ;;
        health)
            require_jq
            cmd_health
            ;;
        stop)
            cmd_stop "$@"
            ;;
        start)
            cmd_start "$@"
            ;;
        restart)
            cmd_restart "$@"
            ;;
        destroy)
            cmd_destroy "$@"
            ;;
        update-all)
            cmd_update_all
            ;;
        ssh)
            cmd_ssh "$@"
            ;;
        logs)
            cmd_logs "$@"
            ;;
        usage)
            cmd_usage "$@"
            ;;
        budget)
            cmd_budget "$@"
            ;;
        usage-report)
            cmd_usage_report
            ;;
        margins)
            cmd_margins
            ;;
        --help|-h)
            show_usage
            ;;
        "")
            show_usage
            ;;
        *)
            die "Unknown command: ${command}. Use --help for usage."
            ;;
    esac
}

main "$@"
