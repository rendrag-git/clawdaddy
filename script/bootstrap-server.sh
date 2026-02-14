#!/usr/bin/env bash
###############################################################################
# ClawDaddy Control Plane - Bootstrap Script
#
# Sets up a fresh Ubuntu EC2 instance as the ClawDaddy control plane server.
# Idempotent — safe to re-run.
#
# Usage: curl -sL <raw-url> | sudo bash
#    or: sudo bash bootstrap-server.sh
###############################################################################
set -euo pipefail

REPO_URL="https://github.com/rendrag-git/clawdaddy.git"
INSTALL_DIR="/opt/clawdaddy"
SERVICE_USER="clawdaddy"
WEBHOOK_DIR="${INSTALL_DIR}/script/webhook-server"
MONITORING_DIR="${INSTALL_DIR}/script/monitoring"
DOMAIN="api.clawdaddy.sh"
NODE_MAJOR=22

log() { echo -e "\n\033[1;36m===> $1\033[0m"; }

# Must be root
[[ $(id -u) -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }

###############################################################################
log "1. System update & base packages"
###############################################################################
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl wget git unzip jq software-properties-common \
    apt-transport-https ca-certificates gnupg lsb-release

###############################################################################
log "2. Node.js ${NODE_MAJOR}"
###############################################################################
if ! command -v node &>/dev/null || ! node -v | grep -q "v${NODE_MAJOR}"; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
    apt-get install -y -qq nodejs
fi
echo "  node $(node -v)  npm $(npm -v)"

###############################################################################
log "3. Docker"
###############################################################################
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | bash
fi
systemctl enable --now docker

###############################################################################
log "4. AWS CLI v2"
###############################################################################
if ! command -v aws &>/dev/null; then
    cd /tmp
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
    unzip -qo awscliv2.zip
    ./aws/install --update
    rm -rf aws awscliv2.zip
fi
echo "  $(aws --version)"

###############################################################################
log "5. PM2"
###############################################################################
if ! command -v pm2 &>/dev/null; then
    npm install -g pm2
fi

###############################################################################
log "6. Cloudflared"
###############################################################################
if ! command -v cloudflared &>/dev/null; then
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
        | gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
        > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -qq
    apt-get install -y -qq cloudflared
fi

###############################################################################
log "7. Nginx & Certbot"
###############################################################################
apt-get install -y -qq nginx certbot python3-certbot-nginx
systemctl enable nginx

###############################################################################
log "8. Create system user: ${SERVICE_USER}"
###############################################################################
if ! id "${SERVICE_USER}" &>/dev/null; then
    useradd --system --shell /usr/sbin/nologin --home-dir "${INSTALL_DIR}" "${SERVICE_USER}"
fi

###############################################################################
log "9. Clone / update repo → ${INSTALL_DIR}"
###############################################################################
if [[ -d "${INSTALL_DIR}/.git" ]]; then
    echo "  Repo exists, pulling latest..."
    git -C "${INSTALL_DIR}" pull --ff-only || true
else
    git clone "${REPO_URL}" "${INSTALL_DIR}"
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

###############################################################################
log "10. Install webhook server dependencies"
###############################################################################
cd "${WEBHOOK_DIR}"
sudo -u "${SERVICE_USER}" npm install --omit=dev

###############################################################################
log "11. Create .env template (if not present)"
###############################################################################
ENV_FILE="${WEBHOOK_DIR}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
    cat > "${ENV_FILE}" <<'ENVEOF'
PORT=3000
STRIPE_SECRET_KEY=sk_test_CHANGEME
STRIPE_WEBHOOK_SECRET=whsec_CHANGEME
RESEND_API_KEY=re_CHANGEME
FROM_EMAIL=noreply@openclaw.dev
DISCORD_OPS_WEBHOOK_URL=https://discord.com/api/webhooks/CHANGEME
CUSTOMERS_FILE=../customers.json
PROVISION_SCRIPT=../provision.sh
STRIPE_PRODUCT_BYOK=prod_CHANGEME
STRIPE_PRODUCT_MANAGED=prod_CHANGEME
OPERATOR_API_KEY=sk-ant-CHANGEME
PROXY_BUNDLE_URL=https://CHANGEME
REPORT_WEBHOOK_URL=http://localhost:3000/usage-report
DEFAULT_BUDGET=40
ENVEOF
    chown "${SERVICE_USER}:${SERVICE_USER}" "${ENV_FILE}"
    chmod 600 "${ENV_FILE}"
    echo "  Created ${ENV_FILE} — fill in real values!"
else
    echo "  ${ENV_FILE} already exists, skipping."
fi

###############################################################################
log "12. PM2 — register webhook server"
###############################################################################
# Stop existing if running
sudo -u "${SERVICE_USER}" bash -c "cd ${WEBHOOK_DIR} && pm2 delete clawdaddy-webhook 2>/dev/null || true"
sudo -u "${SERVICE_USER}" bash -c "cd ${WEBHOOK_DIR} && pm2 start server.js --name clawdaddy-webhook --node-args='--env-file=.env'"
sudo -u "${SERVICE_USER}" bash -c "pm2 save"

# PM2 startup (generates systemd unit)
pm2_startup_cmd=$(pm2 startup systemd -u "${SERVICE_USER}" --hp "${INSTALL_DIR}" 2>&1 | grep 'sudo' | tail -1 || true)
if [[ -n "${pm2_startup_cmd}" ]]; then
    eval "${pm2_startup_cmd}" || true
fi

###############################################################################
log "13. Nginx reverse proxy"
###############################################################################
NGINX_CONF="/etc/nginx/sites-available/clawdaddy"
cat > "${NGINX_CONF}" <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
NGINX

ln -sf "${NGINX_CONF}" /etc/nginx/sites-enabled/clawdaddy
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

###############################################################################
log "14. Firewall (ufw)"
###############################################################################
ufw allow 22/tcp   >/dev/null
ufw allow 80/tcp   >/dev/null
ufw allow 443/tcp  >/dev/null
ufw --force enable

###############################################################################
log "15. Monitoring cron jobs"
###############################################################################
chmod +x "${MONITORING_DIR}"/*.sh 2>/dev/null || true
# Rewrite paths to use our install dir and run as clawdaddy user
CRON_FILE="/etc/cron.d/clawdaddy-monitoring"
cat > "${CRON_FILE}" <<CRON
# ClawDaddy monitoring jobs — managed by bootstrap-server.sh
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

*/5 * * * *  ${SERVICE_USER}  ${MONITORING_DIR}/health-check.sh  >> /var/log/clawdaddy/health-check.log 2>&1
0   3 * * *  ${SERVICE_USER}  ${MONITORING_DIR}/daily-metrics.sh  >> /var/log/clawdaddy/daily-metrics.log 2>&1
0   9 * * 1  ${SERVICE_USER}  ${MONITORING_DIR}/weekly-report.sh  >> /var/log/clawdaddy/weekly-report.log 2>&1
0   4 * * *  ${SERVICE_USER}  ${MONITORING_DIR}/destroy-expired.sh >> /var/log/clawdaddy/destroy-expired.log 2>&1
CRON
chmod 644 "${CRON_FILE}"
mkdir -p /var/log/clawdaddy
chown "${SERVICE_USER}:${SERVICE_USER}" /var/log/clawdaddy

###############################################################################
log "16. Done! Post-bootstrap checklist"
###############################################################################
cat <<'SUMMARY'

╔══════════════════════════════════════════════════════════════════╗
║                  ClawDaddy Bootstrap Complete                   ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║  1. Fill in secrets:                                             ║
║     sudo nano /opt/clawdaddy/script/webhook-server/.env          ║
║                                                                  ║
║  2. Configure AWS credentials:                                   ║
║     sudo -u clawdaddy aws configure                              ║
║                                                                  ║
║  3. Point DNS: api.clawdaddy.sh → this server's public IP       ║
║                                                                  ║
║  4. Get SSL certificate:                                         ║
║     sudo certbot --nginx -d api.clawdaddy.sh                    ║
║                                                                  ║
║  5. Restart webhook server after .env changes:                   ║
║     sudo -u clawdaddy pm2 restart clawdaddy-webhook             ║
║                                                                  ║
║  6. Verify:                                                      ║
║     curl https://api.clawdaddy.sh/health                        ║
║     sudo -u clawdaddy pm2 logs clawdaddy-webhook                ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
SUMMARY
