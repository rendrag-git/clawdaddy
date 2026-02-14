#!/usr/bin/env bash
###############################################################################
# OpenClaw Installer
# Copyright (c) 2025 OpenClaw. All rights reserved.
#
# One-command installer for OpenClaw on Ubuntu 22.04 / 24.04.
# Supports: install (default), --uninstall, --status, --help
#
# Usage:
#   sudo bash install-openclaw.sh            # Interactive install
#   sudo bash install-openclaw.sh --status   # Check health
#   sudo bash install-openclaw.sh --uninstall # Clean removal
#
# Logs: /var/log/openclaw-install.log
###############################################################################
set -euo pipefail

SCRIPT_VERSION="1.0.0"
LOG_FILE="/var/log/openclaw-install.log"
TOTAL_STEPS=15
CURRENT_STEP=0
WORKSPACE_DIR="${HOME}/clawd"
SYSTEMD_UNIT="/etc/systemd/system/openclaw.service"
VNC_DISPLAY=":1"
VNC_PORT="5901"

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
# Logging
# ---------------------------------------------------------------------------
log() {
    local timestamp
    timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
    echo "[${timestamp}] $*" >> "${LOG_FILE}" 2>/dev/null || true
}

info()    { echo -e "${CYAN}[info]${RESET}  $*"; log "INFO  $*"; }
ok()      { echo -e "${GREEN} ✓${RESET}  $*";   log "OK    $*"; }
warn()    { echo -e "${YELLOW}[warn]${RESET}  $*"; log "WARN  $*"; }
fail()    { echo -e "${RED} ✗${RESET}  $*";      log "ERROR $*"; }
die()     { fail "$*"; exit 1; }

step() {
    CURRENT_STEP=$((CURRENT_STEP + 1))
    echo ""
    echo -e "${BOLD}[${CURRENT_STEP}/${TOTAL_STEPS}]${RESET} $*"
    log "STEP ${CURRENT_STEP}/${TOTAL_STEPS} $*"
}

# ---------------------------------------------------------------------------
# Spinner for long-running commands
# ---------------------------------------------------------------------------
spinner() {
    local pid=$1
    local msg="${2:-Working...}"
    local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
    local i=0

    if [[ ! -t 1 ]]; then
        wait "${pid}" 2>/dev/null
        return $?
    fi

    while kill -0 "${pid}" 2>/dev/null; do
        printf "\r  ${DIM}%s %s${RESET}" "${frames[i]}" "${msg}"
        i=$(( (i + 1) % ${#frames[@]} ))
        sleep 0.1
    done
    printf "\r%*s\r" $(( ${#msg} + 6 )) ""

    wait "${pid}" 2>/dev/null
    return $?
}

run_with_spinner() {
    local msg="$1"
    shift
    "$@" >> "${LOG_FILE}" 2>&1 &
    local pid=$!
    spinner "${pid}" "${msg}"
    return $?
}

# ---------------------------------------------------------------------------
# Error trap
# ---------------------------------------------------------------------------
on_error() {
    local exit_code=$?
    local line_no=$1
    fail "Installation failed at line ${line_no} (exit code ${exit_code})."
    echo ""
    echo -e "  ${DIM}Check the log for details:${RESET}"
    echo -e "    ${CYAN}cat ${LOG_FILE}${RESET}"
    echo -e "    ${CYAN}tail -50 ${LOG_FILE}${RESET}"
    echo ""
    echo -e "  ${DIM}If the issue persists, contact support@openclaw.dev${RESET}"
    echo -e "  ${DIM}with the log file attached.${RESET}"
    exit "${exit_code}"
}

trap 'on_error ${LINENO}' ERR

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
confirm() {
    local prompt="$1"
    local default="${2:-y}"
    local answer

    if [[ "${default}" == "y" ]]; then
        prompt="${prompt} [Y/n]: "
    else
        prompt="${prompt} [y/N]: "
    fi

    read -r -p "$(echo -e "${prompt}")" answer
    answer="${answer:-${default}}"

    [[ "${answer}" =~ ^[Yy]$ ]]
}

prompt_value() {
    local varname="$1"
    local prompt_text="$2"
    local default="${3:-}"
    local required="${4:-false}"
    local secret="${5:-false}"
    local value

    if [[ -n "${default}" ]]; then
        prompt_text="${prompt_text} [${default}]"
    fi
    prompt_text="${prompt_text}: "

    while true; do
        if [[ "${secret}" == "true" ]]; then
            read -r -s -p "$(echo -e "${prompt_text}")" value
            echo ""
        else
            read -r -p "$(echo -e "${prompt_text}")" value
        fi

        value="${value:-${default}}"

        if [[ "${required}" == "true" && -z "${value}" ]]; then
            warn "This field is required. Please enter a value."
            continue
        fi

        break
    done

    eval "${varname}='${value}'"
}

generate_password() {
    local length="${1:-12}"
    tr -dc 'A-Za-z0-9!@#%&*' < /dev/urandom | head -c "${length}" || true
}

get_primary_ip() {
    ip route get 1.1.1.1 2>/dev/null \
        | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' \
        | head -1
}

bytes_to_human() {
    local bytes=$1
    if (( bytes >= 1073741824 )); then
        echo "$(( bytes / 1073741824 )) GB"
    elif (( bytes >= 1048576 )); then
        echo "$(( bytes / 1048576 )) MB"
    else
        echo "${bytes} bytes"
    fi
}

# ---------------------------------------------------------------------------
# --help
# ---------------------------------------------------------------------------
show_help() {
    cat <<HELPEOF

${BOLD}OpenClaw Installer v${SCRIPT_VERSION}${RESET}

${BOLD}USAGE${RESET}
    sudo bash install-openclaw.sh [OPTION]

${BOLD}OPTIONS${RESET}
    (none)          Run the interactive installer
    --status        Show health / status of all components
    --uninstall     Cleanly remove OpenClaw and related packages
    --help          Show this help message
    --version       Show version

${BOLD}EXAMPLES${RESET}
    sudo bash install-openclaw.sh
    sudo bash install-openclaw.sh --status
    sudo bash install-openclaw.sh --uninstall

${BOLD}REQUIREMENTS${RESET}
    - Ubuntu 22.04 or 24.04
    - x86_64 or aarch64
    - Root / sudo access
    - Minimum 1 GB RAM, 2 GB free disk space
    - An Anthropic API key (sk-ant-...)

${BOLD}SUPPORT${RESET}
    support@openclaw.dev

HELPEOF
}

# ---------------------------------------------------------------------------
# --version
# ---------------------------------------------------------------------------
show_version() {
    echo "OpenClaw Installer v${SCRIPT_VERSION}"
}

# ---------------------------------------------------------------------------
# --status
# ---------------------------------------------------------------------------
do_status() {
    echo ""
    echo -e "${BOLD}OpenClaw Status Report${RESET}  (v${SCRIPT_VERSION})"
    echo -e "${DIM}$(date)${RESET}"
    echo ""

    # --- systemd service ---
    echo -e "${BOLD}Service:${RESET}"
    if systemctl is-active --quiet openclaw 2>/dev/null; then
        ok "openclaw.service is ${GREEN}active${RESET}"
        local uptime_info
        uptime_info=$(systemctl show openclaw \
            --property=ActiveEnterTimestamp 2>/dev/null | cut -d= -f2)
        if [[ -n "${uptime_info}" ]]; then
            info "  Running since: ${uptime_info}"
        fi
    elif systemctl is-enabled --quiet openclaw 2>/dev/null; then
        warn "openclaw.service is enabled but ${YELLOW}not running${RESET}"
    else
        fail "openclaw.service is ${RED}not installed or not enabled${RESET}"
    fi

    # --- VNC ---
    echo ""
    echo -e "${BOLD}VNC Server:${RESET}"
    if pgrep -f "Xtigervnc.*${VNC_DISPLAY}" > /dev/null 2>&1; then
        ok "TigerVNC is running on display ${VNC_DISPLAY} (port ${VNC_PORT})"
    else
        fail "TigerVNC is ${RED}not running${RESET}"
    fi

    # --- UFW ---
    echo ""
    echo -e "${BOLD}Firewall (UFW):${RESET}"
    if command -v ufw > /dev/null 2>&1; then
        local ufw_status
        ufw_status=$(ufw status 2>/dev/null | head -1)
        if echo "${ufw_status}" | grep -q "active"; then
            ok "UFW is active"
            if ufw status | grep -q "${VNC_PORT}"; then
                ok "  Port ${VNC_PORT}/tcp (VNC) is allowed"
            else
                warn "  Port ${VNC_PORT}/tcp (VNC) rule not found"
            fi
            if ufw status | grep -q "22/tcp"; then
                ok "  Port 22/tcp (SSH) is allowed"
            else
                warn "  Port 22/tcp (SSH) rule not found"
            fi
        else
            warn "UFW is ${YELLOW}inactive${RESET}"
        fi
    else
        fail "UFW is not installed"
    fi

    # --- openclaw binary ---
    echo ""
    echo -e "${BOLD}OpenClaw CLI:${RESET}"
    if command -v openclaw > /dev/null 2>&1; then
        local oc_version
        oc_version=$(openclaw --version 2>/dev/null || echo "unknown")
        ok "openclaw command found (version: ${oc_version})"
    else
        fail "openclaw command ${RED}not found${RESET} in PATH"
    fi

    # --- Disk space ---
    echo ""
    echo -e "${BOLD}Disk:${RESET}"
    local avail_kb
    avail_kb=$(df -k / | awk 'NR==2 {print $4}')
    local avail_human
    avail_human=$(bytes_to_human $(( avail_kb * 1024 )))
    if (( avail_kb > 2097152 )); then
        ok "Available disk space: ${avail_human}"
    elif (( avail_kb > 1048576 )); then
        warn "Available disk space is low: ${avail_human}"
    else
        fail "Available disk space is critically low: ${avail_human}"
    fi

    # --- Workspace ---
    echo ""
    echo -e "${BOLD}Workspace:${RESET}"
    if [[ -d "${WORKSPACE_DIR}" ]]; then
        ok "${WORKSPACE_DIR} exists"
        for subdir in memory skills config scripts; do
            if [[ -d "${WORKSPACE_DIR}/${subdir}" ]]; then
                ok "  ${subdir}/"
            else
                warn "  ${subdir}/ is missing"
            fi
        done
    else
        fail "${WORKSPACE_DIR} does not exist"
    fi

    echo ""
}

# ---------------------------------------------------------------------------
# --uninstall
# ---------------------------------------------------------------------------
do_uninstall() {
    echo ""
    echo -e "${BOLD}OpenClaw Uninstaller${RESET}  (v${SCRIPT_VERSION})"
    echo ""
    warn "This will remove OpenClaw and its associated components from this system."
    echo ""

    if ! confirm "  Are you sure you want to proceed?"; then
        info "Uninstall cancelled."
        exit 0
    fi

    echo ""

    # 1. Stop and disable systemd service
    info "Stopping openclaw service..."
    if systemctl is-active --quiet openclaw 2>/dev/null; then
        systemctl stop openclaw 2>/dev/null || true
        ok "Service stopped"
    else
        info "Service was not running"
    fi
    if systemctl is-enabled --quiet openclaw 2>/dev/null; then
        systemctl disable openclaw 2>/dev/null || true
        ok "Service disabled"
    fi
    if [[ -f "${SYSTEMD_UNIT}" ]]; then
        rm -f "${SYSTEMD_UNIT}"
        systemctl daemon-reload 2>/dev/null || true
        ok "Removed systemd unit file"
    fi

    # 2. Stop VNC
    info "Stopping VNC..."
    if command -v tigervncserver > /dev/null 2>&1; then
        tigervncserver -kill "${VNC_DISPLAY}" 2>/dev/null || true
        ok "VNC stopped"
    elif command -v vncserver > /dev/null 2>&1; then
        vncserver -kill "${VNC_DISPLAY}" 2>/dev/null || true
        ok "VNC stopped"
    else
        info "VNC server command not found; skipping"
    fi

    # 3. Uninstall openclaw npm package
    info "Removing openclaw npm package..."
    if command -v npm > /dev/null 2>&1; then
        npm uninstall -g openclaw 2>/dev/null || true
        ok "openclaw npm package removed"
    else
        info "npm not found; skipping"
    fi

    # 4. Remove UFW rules
    info "Removing UFW rules for port ${VNC_PORT}..."
    if command -v ufw > /dev/null 2>&1; then
        ufw delete allow "${VNC_PORT}/tcp" 2>/dev/null || true
        ok "UFW rule for ${VNC_PORT}/tcp removed"
    fi

    # 5. Optionally remove workspace
    echo ""
    if [[ -d "${WORKSPACE_DIR}" ]]; then
        if confirm "  Remove workspace directory (${WORKSPACE_DIR})?" "n"; then
            rm -rf "${WORKSPACE_DIR}"
            ok "Workspace removed"
        else
            info "Workspace preserved at ${WORKSPACE_DIR}"
        fi
    fi

    # 6. Remove VNC config
    if [[ -d "${HOME}/.vnc" ]]; then
        if confirm "  Remove VNC configuration (~/.vnc)?" "n"; then
            rm -rf "${HOME}/.vnc"
            ok "VNC configuration removed"
        else
            info "VNC configuration preserved"
        fi
    fi

    # 7. Optionally remove installed apt packages
    echo ""
    if confirm "  Remove packages installed by OpenClaw (tigervnc, scrot, xdotool, xterm)?" "n"; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get remove -y tigervnc-standalone-server scrot xdotool xterm \
            x11-xserver-utils 2>/dev/null || true
        apt-get autoremove -y 2>/dev/null || true
        ok "Packages removed"
    else
        info "Packages preserved"
    fi

    # 8. Optionally remove Node.js
    echo ""
    if confirm "  Remove Node.js?" "n"; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get remove -y nodejs 2>/dev/null || true
        rm -f /etc/apt/sources.list.d/nodesource.list 2>/dev/null || true
        rm -f /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
        apt-get autoremove -y 2>/dev/null || true
        ok "Node.js removed"
    else
        info "Node.js preserved"
    fi

    echo ""
    ok "OpenClaw has been uninstalled."
    echo ""
    info "The install log remains at ${LOG_FILE}"
    echo ""
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
preflight_checks() {
    step "Running pre-flight checks..."

    # Root check
    if [[ "${EUID}" -ne 0 ]]; then
        die "This script must be run as root. Use: sudo bash install-openclaw.sh"
    fi
    ok "Running as root"

    # OS check
    if [[ ! -f /etc/os-release ]]; then
        die "Cannot determine OS. /etc/os-release not found."
    fi

    # shellcheck disable=SC1091
    source /etc/os-release

    if [[ "${ID}" != "ubuntu" ]]; then
        die "Unsupported OS: ${ID}. OpenClaw requires Ubuntu 22.04 or 24.04."
    fi

    case "${VERSION_ID}" in
        22.04|24.04)
            ok "Ubuntu ${VERSION_ID} detected"
            ;;
        *)
            die "Unsupported Ubuntu version: ${VERSION_ID}. Requires 22.04 or 24.04."
            ;;
    esac

    # Architecture check
    local arch
    arch="$(uname -m)"
    case "${arch}" in
        x86_64|aarch64)
            ok "Architecture: ${arch}"
            ;;
        *)
            die "Unsupported architecture: ${arch}. Requires x86_64 or aarch64."
            ;;
    esac

    # RAM check (minimum 1 GB = 1048576 KB)
    local total_ram_kb
    total_ram_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
    local total_ram_human
    total_ram_human=$(bytes_to_human $(( total_ram_kb * 1024 )))

    if (( total_ram_kb < 1048576 )); then
        die "Insufficient RAM: ${total_ram_human}. Minimum 1 GB required."
    fi
    ok "RAM: ${total_ram_human}"

    # Disk check (minimum 2 GB free on /)
    local avail_kb
    avail_kb=$(df -k / | awk 'NR==2 {print $4}')
    local avail_human
    avail_human=$(bytes_to_human $(( avail_kb * 1024 )))

    if (( avail_kb < 2097152 )); then
        die "Insufficient disk space: ${avail_human}. Minimum 2 GB required."
    fi
    ok "Disk: ${avail_human} available"

    log "Pre-flight checks passed."
}

# ---------------------------------------------------------------------------
# Interactive configuration
# ---------------------------------------------------------------------------
collect_configuration() {
    step "Collecting configuration..."
    echo ""
    echo -e "  ${DIM}Press Enter to accept the default value shown in brackets.${RESET}"
    echo -e "  ${DIM}Leave optional fields empty to skip them.${RESET}"
    echo ""

    # --- Anthropic API key (required) ---
    while true; do
        prompt_value CFG_ANTHROPIC_KEY \
            "  ${BOLD}Anthropic API key${RESET} (required)" \
            "" "true" "true"
        if [[ "${CFG_ANTHROPIC_KEY}" =~ ^sk-ant- ]]; then
            ok "API key format looks valid"
            break
        else
            warn "API key should start with 'sk-ant-'. Please try again."
        fi
    done

    echo ""

    # --- Discord (optional) ---
    prompt_value CFG_DISCORD_TOKEN \
        "  ${BOLD}Discord bot token${RESET} (optional, Enter to skip)" \
        "" "false" "true"

    CFG_DISCORD_CHANNEL=""
    if [[ -n "${CFG_DISCORD_TOKEN}" ]]; then
        prompt_value CFG_DISCORD_CHANNEL \
            "  ${BOLD}Discord channel ID${RESET}" \
            "" "true" "false"
    fi

    echo ""

    # --- Telegram (optional) ---
    prompt_value CFG_TELEGRAM_TOKEN \
        "  ${BOLD}Telegram bot token${RESET} (optional, Enter to skip)" \
        "" "false" "true"

    CFG_TELEGRAM_CHAT=""
    if [[ -n "${CFG_TELEGRAM_TOKEN}" ]]; then
        prompt_value CFG_TELEGRAM_CHAT \
            "  ${BOLD}Telegram chat ID${RESET}" \
            "" "true" "false"
    fi

    echo ""

    # --- Signal (optional) ---
    prompt_value CFG_SIGNAL_PHONE \
        "  ${BOLD}Signal phone number${RESET} (optional, Enter to skip)" \
        "" "false" "false"

    echo ""

    # --- VNC password ---
    local default_vnc_pass
    default_vnc_pass="$(generate_password 12)"
    prompt_value CFG_VNC_PASSWORD \
        "  ${BOLD}VNC password${RESET}" \
        "${default_vnc_pass}" "true" "false"

    echo ""

    # --- Summary / confirm ---
    echo -e "  ${BOLD}Configuration summary:${RESET}"
    echo -e "    Anthropic API key : ${DIM}${CFG_ANTHROPIC_KEY:0:12}...${RESET}"
    if [[ -n "${CFG_DISCORD_TOKEN}" ]]; then
        echo -e "    Discord           : ${GREEN}configured${RESET}"
    else
        echo -e "    Discord           : ${DIM}skipped${RESET}"
    fi
    if [[ -n "${CFG_TELEGRAM_TOKEN}" ]]; then
        echo -e "    Telegram          : ${GREEN}configured${RESET}"
    else
        echo -e "    Telegram          : ${DIM}skipped${RESET}"
    fi
    if [[ -n "${CFG_SIGNAL_PHONE}" ]]; then
        echo -e "    Signal            : ${GREEN}configured${RESET}"
    else
        echo -e "    Signal            : ${DIM}skipped${RESET}"
    fi
    echo -e "    VNC password      : ${DIM}${CFG_VNC_PASSWORD}${RESET}"
    echo -e "    Workspace         : ${WORKSPACE_DIR}"
    echo ""

    if ! confirm "  Proceed with installation?"; then
        info "Installation cancelled by user."
        exit 0
    fi
}

# ---------------------------------------------------------------------------
# Installation steps
# ---------------------------------------------------------------------------

install_prerequisites() {
    step "Updating apt and installing prerequisites..."

    export DEBIAN_FRONTEND=noninteractive

    run_with_spinner "Updating package lists" \
        apt-get update -y

    local pkgs=(curl gnupg ca-certificates)
    local to_install=()

    for pkg in "${pkgs[@]}"; do
        if ! dpkg -l "${pkg}" 2>/dev/null | grep -q "^ii"; then
            to_install+=("${pkg}")
        fi
    done

    if (( ${#to_install[@]} > 0 )); then
        run_with_spinner "Installing ${to_install[*]}" \
            apt-get install -y "${to_install[@]}"
        ok "Installed: ${to_install[*]}"
    else
        ok "Prerequisites already installed"
    fi
}

install_nodejs() {
    step "Installing Node.js 22..."

    if command -v node > /dev/null 2>&1; then
        local current_major
        current_major=$(node --version | sed 's/v//' | cut -d. -f1)
        if (( current_major >= 22 )); then
            ok "Node.js $(node --version) already installed"
            return 0
        else
            info "Node.js $(node --version) found, upgrading to v22..."
        fi
    fi

    local keyring_dir="/etc/apt/keyrings"
    mkdir -p "${keyring_dir}"

    run_with_spinner "Adding NodeSource GPG key" \
        bash -c "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
            | gpg --dearmor -o ${keyring_dir}/nodesource.gpg --yes"

    echo "deb [signed-by=${keyring_dir}/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list

    run_with_spinner "Updating package lists" \
        apt-get update -y

    run_with_spinner "Installing Node.js 22" \
        apt-get install -y nodejs

    ok "Node.js $(node --version) installed"
}

install_openclaw() {
    step "Installing OpenClaw via npm..."

    if command -v openclaw > /dev/null 2>&1; then
        local current_ver
        current_ver=$(openclaw --version 2>/dev/null || echo "unknown")
        info "OpenClaw already installed (${current_ver}). Updating..."
    fi

    run_with_spinner "Installing openclaw globally" \
        npm install -g openclaw

    ok "OpenClaw installed"
}

install_chromium() {
    step "Installing Chromium..."

    if command -v chromium-browser > /dev/null 2>&1 \
       || command -v chromium > /dev/null 2>&1; then
        ok "Chromium already installed"
        return 0
    fi

    if apt-cache show chromium-browser > /dev/null 2>&1; then
        run_with_spinner "Installing chromium-browser" \
            apt-get install -y chromium-browser
        ok "chromium-browser installed"
    elif apt-cache show chromium > /dev/null 2>&1; then
        run_with_spinner "Installing chromium" \
            apt-get install -y chromium
        ok "chromium installed"
    else
        if command -v snap > /dev/null 2>&1; then
            run_with_spinner "Installing chromium via snap" \
                snap install chromium
            ok "chromium installed via snap"
        else
            die "Could not find chromium in apt or snap. Install manually and re-run."
        fi
    fi
}

install_vnc() {
    step "Installing TigerVNC server..."

    if dpkg -l tigervnc-standalone-server 2>/dev/null | grep -q "^ii"; then
        ok "TigerVNC already installed"
    else
        run_with_spinner "Installing tigervnc-standalone-server" \
            apt-get install -y tigervnc-standalone-server
        ok "TigerVNC installed"
    fi
}

install_x11_tools() {
    step "Installing X11 utilities..."

    local pkgs=(scrot xdotool xterm x11-xserver-utils)
    local to_install=()

    for pkg in "${pkgs[@]}"; do
        if ! dpkg -l "${pkg}" 2>/dev/null | grep -q "^ii"; then
            to_install+=("${pkg}")
        fi
    done

    if (( ${#to_install[@]} > 0 )); then
        run_with_spinner "Installing ${to_install[*]}" \
            apt-get install -y "${to_install[@]}"
        ok "Installed: ${to_install[*]}"
    else
        ok "X11 utilities already installed"
    fi
}

configure_ufw() {
    step "Configuring firewall (UFW)..."

    if ! command -v ufw > /dev/null 2>&1; then
        run_with_spinner "Installing UFW" \
            apt-get install -y ufw
    fi

    ufw default deny incoming  >> "${LOG_FILE}" 2>&1 || true
    ufw default allow outgoing >> "${LOG_FILE}" 2>&1 || true

    if ! ufw status | grep -q "22/tcp"; then
        ufw allow 22/tcp >> "${LOG_FILE}" 2>&1
        ok "Allowed SSH (22/tcp)"
    else
        ok "SSH (22/tcp) already allowed"
    fi

    if ! ufw status | grep -q "${VNC_PORT}/tcp"; then
        ufw allow "${VNC_PORT}/tcp" >> "${LOG_FILE}" 2>&1
        ok "Allowed VNC (${VNC_PORT}/tcp)"
    else
        ok "VNC (${VNC_PORT}/tcp) already allowed"
    fi

    if ! ufw status | grep -q "Status: active"; then
        echo "y" | ufw enable >> "${LOG_FILE}" 2>&1
        ok "UFW enabled"
    else
        ok "UFW already active"
    fi
}

create_workspace() {
    step "Creating workspace..."

    local subdirs=(memory skills config scripts)
    mkdir -p "${WORKSPACE_DIR}"
    for d in "${subdirs[@]}"; do
        mkdir -p "${WORKSPACE_DIR}/${d}"
    done
    ok "Workspace directories created at ${WORKSPACE_DIR}"

    # --- SOUL.md ---
    local soul_file="${WORKSPACE_DIR}/SOUL.md"
    if [[ -f "${soul_file}" ]]; then
        warn "${soul_file} already exists"
        if ! confirm "    Overwrite?" "n"; then
            info "  Keeping existing SOUL.md"
        else
            write_soul_file "${soul_file}"
        fi
    else
        write_soul_file "${soul_file}"
    fi

    # --- USER.md ---
    local user_file="${WORKSPACE_DIR}/USER.md"
    if [[ -f "${user_file}" ]]; then
        warn "${user_file} already exists"
        if ! confirm "    Overwrite?" "n"; then
            info "  Keeping existing USER.md"
        else
            write_user_file "${user_file}"
        fi
    else
        write_user_file "${user_file}"
    fi

    # --- AGENTS.md ---
    local agents_file="${WORKSPACE_DIR}/AGENTS.md"
    if [[ -f "${agents_file}" ]]; then
        warn "${agents_file} already exists"
        if ! confirm "    Overwrite?" "n"; then
            info "  Keeping existing AGENTS.md"
        else
            write_agents_file "${agents_file}"
        fi
    else
        write_agents_file "${agents_file}"
    fi

    # --- HEARTBEAT.md ---
    local hb_file="${WORKSPACE_DIR}/HEARTBEAT.md"
    if [[ -f "${hb_file}" ]]; then
        warn "${hb_file} already exists"
        if ! confirm "    Overwrite?" "n"; then
            info "  Keeping existing HEARTBEAT.md"
        else
            write_heartbeat_file "${hb_file}"
        fi
    else
        write_heartbeat_file "${hb_file}"
    fi

    ok "Starter files created"
}

write_soul_file() {
    cat > "$1" <<'SOULEOF'
# Soul

## Identity
- Name: Clawd
- Role: Your autonomous digital assistant

## Purpose
I help you by monitoring, automating, and managing tasks across your
configured channels (Discord, Telegram, Signal). I operate continuously
on your server, ready to act when you need me.

## Personality
- Professional yet approachable
- Concise and clear in communication
- Proactive about potential issues
- Transparent about what I can and cannot do

## Principles
1. Always confirm before taking destructive actions
2. Log important decisions and actions
3. Respect rate limits and resource constraints
4. Escalate when uncertain
SOULEOF
}

write_user_file() {
    cat > "$1" <<'USEREOF'
# User Preferences

## Communication Style
- Preferred language: English
- Verbosity: Medium
- Notifications: Important events only

## Schedule
- Timezone: UTC
- Active hours: 09:00-18:00 (for non-urgent notifications)
- Critical alerts: Anytime

## Channels
Configure your preferred channels in config/openclaw.env
USEREOF
}

write_agents_file() {
    cat > "$1" <<'AGENTSEOF'
# Agent Configuration

## Primary Agent: Clawd
- Model: claude-sonnet-4-20250514
- Max tokens: 4096
- Temperature: 0.7

## Task Routing
- Default handler: Clawd
- Escalation: Notify user via primary channel

## Skills
Skills are stored in the skills/ directory. Each skill is a markdown
file describing a capability that Clawd can learn and execute.

## Memory
Persistent memory is stored in the memory/ directory. Clawd uses this
to remember context across sessions.
AGENTSEOF
}

write_heartbeat_file() {
    cat > "$1" <<'HBEOF'
# Heartbeat

## Health Check Configuration
- Interval: 60 seconds
- Timeout: 10 seconds
- Retries: 3

## Monitored Services
- [x] OpenClaw process
- [x] VNC server
- [x] Network connectivity
- [ ] Custom checks (add below)

## Custom Health Checks
Add your own health check commands below. Each should exit 0 for
healthy, non-zero for unhealthy.

```bash
# Example: Check if a website is reachable
# curl -sf https://example.com > /dev/null
```
HBEOF
}

write_config() {
    step "Writing configuration..."

    local env_file="${WORKSPACE_DIR}/config/openclaw.env"

    if [[ -f "${env_file}" ]]; then
        warn "${env_file} already exists"
        if ! confirm "    Overwrite?" "n"; then
            info "  Keeping existing configuration"
            return 0
        fi
        cp "${env_file}" "${env_file}.bak.$(date +%s)"
        ok "Existing config backed up"
    fi

    cat > "${env_file}" <<ENVEOF
# OpenClaw Configuration
# Generated by install-openclaw.sh v${SCRIPT_VERSION} on $(date -Iseconds)
#
# WARNING: This file contains secrets. Protect it accordingly.
#   chmod 600 ${env_file}

# --- Anthropic ---
ANTHROPIC_API_KEY=${CFG_ANTHROPIC_KEY}

# --- Discord ---
DISCORD_BOT_TOKEN=${CFG_DISCORD_TOKEN:-}
DISCORD_CHANNEL_ID=${CFG_DISCORD_CHANNEL:-}

# --- Telegram ---
TELEGRAM_BOT_TOKEN=${CFG_TELEGRAM_TOKEN:-}
TELEGRAM_CHAT_ID=${CFG_TELEGRAM_CHAT:-}

# --- Signal ---
SIGNAL_PHONE_NUMBER=${CFG_SIGNAL_PHONE:-}

# --- Workspace ---
OPENCLAW_WORKSPACE=${WORKSPACE_DIR}

# --- VNC ---
VNC_DISPLAY=${VNC_DISPLAY}
VNC_PORT=${VNC_PORT}
ENVEOF

    chmod 600 "${env_file}"
    ok "Configuration written to ${env_file}"
}

setup_vnc() {
    step "Configuring VNC..."

    local vnc_dir="${HOME}/.vnc"
    mkdir -p "${vnc_dir}"

    echo "${CFG_VNC_PASSWORD}" | tigervncpasswd -f > "${vnc_dir}/passwd" 2>/dev/null
    chmod 600 "${vnc_dir}/passwd"
    ok "VNC password set"

    local chromium_bin="chromium-browser"
    if ! command -v chromium-browser > /dev/null 2>&1; then
        chromium_bin="chromium"
    fi

    local xstartup="${vnc_dir}/xstartup"
    if [[ -f "${xstartup}" ]]; then
        warn "${xstartup} already exists"
        if ! confirm "    Overwrite?" "n"; then
            info "  Keeping existing xstartup"
            return 0
        fi
    fi

    cat > "${xstartup}" <<VNCEOF
#!/bin/sh
# OpenClaw VNC session startup
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS

export XKL_XMODMAP_DISABLE=1

# Start a basic terminal
if command -v xterm > /dev/null 2>&1; then
    xterm -geometry 80x24+10+10 -ls -title "OpenClaw Terminal" &
fi

# Set display resolution
xrandr --output VNC-0 --mode 1920x1080 2>/dev/null || \
xrandr -s 1920x1080 2>/dev/null || true

# Launch Chromium
exec ${chromium_bin} \
    --no-first-run \
    --disable-translate \
    --disable-infobars \
    --disable-suggestions-service \
    --disable-save-password-bubble \
    --disable-default-apps \
    --no-sandbox \
    --start-maximized \
    --window-size=1920,1080 \
    --user-data-dir="\${HOME}/.config/openclaw-chromium" \
    "https://openclaw.dev/dashboard" 2>/dev/null &

# Keep session alive
wait
VNCEOF

    chmod 755 "${xstartup}"
    ok "VNC xstartup configured"
}

setup_systemd() {
    step "Setting up systemd service..."

    local env_file="${WORKSPACE_DIR}/config/openclaw.env"

    if [[ -f "${SYSTEMD_UNIT}" ]]; then
        warn "${SYSTEMD_UNIT} already exists"
        if ! confirm "    Overwrite?" "n"; then
            info "  Keeping existing service file"
            systemctl daemon-reload
            return 0
        fi
    fi

    local openclaw_bin
    openclaw_bin="$(command -v openclaw 2>/dev/null || echo '/usr/bin/openclaw')"

    cat > "${SYSTEMD_UNIT}" <<UNITEOF
[Unit]
Description=OpenClaw Autonomous Agent
Documentation=https://docs.openclaw.dev
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${WORKSPACE_DIR}
EnvironmentFile=${env_file}
ExecStart=${openclaw_bin} run
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=300
StartLimitBurst=5

# Hardening
NoNewPrivileges=false
ProtectSystem=full
PrivateTmp=true

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=openclaw

[Install]
WantedBy=multi-user.target
UNITEOF

    systemctl daemon-reload
    ok "Systemd service created at ${SYSTEMD_UNIT}"
}

start_vnc() {
    step "Starting VNC server..."

    if pgrep -f "Xtigervnc.*${VNC_DISPLAY}" > /dev/null 2>&1; then
        info "VNC already running on ${VNC_DISPLAY}, restarting..."
        tigervncserver -kill "${VNC_DISPLAY}" 2>/dev/null || true
        sleep 1
    fi

    tigervncserver "${VNC_DISPLAY}" \
        -geometry 1920x1080 \
        -depth 24 \
        -localhost no \
        >> "${LOG_FILE}" 2>&1

    ok "VNC server started on display ${VNC_DISPLAY} (port ${VNC_PORT})"
}

start_service() {
    step "Starting OpenClaw service..."

    systemctl enable openclaw >> "${LOG_FILE}" 2>&1
    systemctl start openclaw  >> "${LOG_FILE}" 2>&1

    ok "Service enabled and started"

    info "Waiting for service to become active..."
    local attempts=0
    local max_attempts=30

    while (( attempts < max_attempts )); do
        if systemctl is-active --quiet openclaw 2>/dev/null; then
            printf "\r%*s\r" 40 ""
            ok "Service is active and running"
            return 0
        fi
        attempts=$((attempts + 1))
        sleep 1
        printf "\r  ${DIM}Waiting... %d/%d${RESET}" "${attempts}" "${max_attempts}"
    done

    echo ""
    warn "Service did not become active within ${max_attempts} seconds."
    warn "Check logs with: journalctl -u openclaw -n 50 --no-pager"
    info "The service may still be starting. Run --status to check later."
}

# ---------------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------------
print_summary() {
    local server_ip
    server_ip="$(get_primary_ip)"
    server_ip="${server_ip:-<your-server-ip>}"

    echo ""
    echo ""
    echo -e "${BOLD}========================================================${RESET}"
    echo -e "${BOLD}  OpenClaw Installation Complete${RESET}"
    echo -e "${BOLD}========================================================${RESET}"
    echo ""

    echo -e "  ${BOLD}Installed components:${RESET}"
    echo -e "    ${GREEN}✓${RESET} Node.js $(node --version 2>/dev/null || echo 'v22')"
    echo -e "    ${GREEN}✓${RESET} OpenClaw (npm global)"
    echo -e "    ${GREEN}✓${RESET} Chromium"
    echo -e "    ${GREEN}✓${RESET} TigerVNC server"
    echo -e "    ${GREEN}✓${RESET} X11 utilities (scrot, xdotool, xterm)"
    echo -e "    ${GREEN}✓${RESET} UFW firewall configured"
    echo -e "    ${GREEN}✓${RESET} Workspace at ${WORKSPACE_DIR}"
    echo -e "    ${GREEN}✓${RESET} Systemd service (openclaw.service)"

    echo ""
    echo -e "  ${BOLD}VNC Connection:${RESET}"
    echo -e "    Server   : ${CYAN}${server_ip}:${VNC_PORT}${RESET}"
    echo -e "    Password : ${CYAN}${CFG_VNC_PASSWORD}${RESET}"
    echo -e "    ${DIM}Use any VNC client (RealVNC, TigerVNC viewer, etc.)${RESET}"

    echo ""
    echo -e "  ${BOLD}Useful commands:${RESET}"
    echo -e "    ${CYAN}bash install-openclaw.sh --status${RESET}       Check health"
    echo -e "    ${CYAN}journalctl -u openclaw -f${RESET}               Follow logs"
    echo -e "    ${CYAN}systemctl restart openclaw${RESET}              Restart service"
    echo -e "    ${CYAN}bash install-openclaw.sh --uninstall${RESET}    Clean removal"

    echo ""
    echo -e "  ${BOLD}Next steps:${RESET}"
    echo -e "    1. Connect to VNC at ${CYAN}${server_ip}:${VNC_PORT}${RESET}"
    echo -e "    2. Configure your messaging channels in the dashboard"
    echo -e "    3. Customize ${WORKSPACE_DIR}/SOUL.md with your agent's personality"
    echo -e "    4. Add skills to ${WORKSPACE_DIR}/skills/"

    echo ""
    echo -e "  ${BOLD}Configuration:${RESET}  ${WORKSPACE_DIR}/config/openclaw.env"
    echo -e "  ${BOLD}Install log:${RESET}    ${LOG_FILE}"

    echo ""
    echo -e "  ${DIM}Thank you for choosing OpenClaw.${RESET}"
    echo -e "  ${DIM}Support: support@openclaw.dev | Docs: https://docs.openclaw.dev${RESET}"
    echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    case "${1:-}" in
        --help|-h)
            show_help
            exit 0
            ;;
        --version|-v)
            show_version
            exit 0
            ;;
        --status)
            do_status
            exit 0
            ;;
        --uninstall)
            do_uninstall
            exit 0
            ;;
        "")
            ;;
        *)
            die "Unknown option: $1. Use --help for usage."
            ;;
    esac

    # --- Banner ---
    echo ""
    echo -e "${BOLD}  ╔═══════════════════════════════════════════════╗${RESET}"
    echo -e "${BOLD}  ║                                               ║${RESET}"
    echo -e "${BOLD}  ║            OpenClaw Installer                 ║${RESET}"
    echo -e "${BOLD}  ║            v${SCRIPT_VERSION}                              ║${RESET}"
    echo -e "${BOLD}  ║                                               ║${RESET}"
    echo -e "${BOLD}  ╚═══════════════════════════════════════════════╝${RESET}"
    echo ""

    # Initialize log
    mkdir -p "$(dirname "${LOG_FILE}")"
    echo "=== OpenClaw Installer v${SCRIPT_VERSION} ===" >  "${LOG_FILE}"
    echo "Started: $(date -Iseconds)"                    >> "${LOG_FILE}"
    echo "System:  $(uname -a)"                          >> "${LOG_FILE}"
    echo ""                                              >> "${LOG_FILE}"

    # Run installation pipeline
    preflight_checks          # Step  1
    collect_configuration     # Step  2
    install_prerequisites     # Step  3
    install_nodejs            # Step  4
    install_openclaw          # Step  5
    install_chromium          # Step  6
    install_vnc               # Step  7
    install_x11_tools         # Step  8
    configure_ufw             # Step  9
    create_workspace          # Step 10
    write_config              # Step 11
    setup_vnc                 # Step 12
    setup_systemd             # Step 13
    start_vnc                 # Step 14
    start_service             # Step 15

    print_summary

    log "Installation completed successfully."
}

main "$@"
