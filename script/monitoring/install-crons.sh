#!/usr/bin/env bash
###############################################################################
# Install Cron Jobs - OpenClaw BYOK Tier 2
#
# Idempotently adds crontab entries for all monitoring scripts.
# Safe to re-run; checks for existing entries before adding.
#
# Usage: sudo bash install-crons.sh
###############################################################################
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/openclaw/monitoring"

# Cron entries to install
declare -A CRONS=(
    ["health-check"]="*/5 * * * * ${INSTALL_DIR}/health-check.sh >> ${INSTALL_DIR}/health-check.log 2>&1"
    ["daily-metrics"]="0 3 * * * ${INSTALL_DIR}/daily-metrics.sh >> ${INSTALL_DIR}/daily-metrics.log 2>&1"
    ["weekly-report"]="0 9 * * 1 ${INSTALL_DIR}/weekly-report.sh >> ${INSTALL_DIR}/weekly-report.log 2>&1"
    ["destroy-expired"]="0 4 * * * ${INSTALL_DIR}/destroy-expired.sh >> ${INSTALL_DIR}/destroy-expired.log 2>&1"
)

added=0
skipped=0

echo "Installing OpenClaw monitoring cron jobs..."
echo ""

# Get current crontab (suppress "no crontab" error)
current_crontab="$(crontab -l 2>/dev/null || true)"

new_crontab="${current_crontab}"

for name in "${!CRONS[@]}"; do
    entry="${CRONS[${name}]}"
    script_name="${name}.sh"

    if echo "${current_crontab}" | grep -qF "${script_name}"; then
        echo "  [skip] ${name} - already installed"
        skipped=$((skipped + 1))
    else
        new_crontab="${new_crontab}"$'\n'"${entry}"
        echo "  [add]  ${name} - ${entry}"
        added=$((added + 1))
    fi
done

if [[ ${added} -gt 0 ]]; then
    echo "${new_crontab}" | crontab -
    echo ""
    echo "Installed ${added} new cron job(s), ${skipped} already present."
else
    echo ""
    echo "All cron jobs already installed (${skipped} entries)."
fi

echo ""
echo "Current crontab:"
crontab -l 2>/dev/null || echo "  (empty)"
