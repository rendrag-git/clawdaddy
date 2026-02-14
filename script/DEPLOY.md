# ClawDaddy Control Plane — Deployment Guide

## What It Does

The control plane server is the brain of ClawDaddy's managed hosting platform:

- **Receives Stripe webhooks** — new subscriptions, cancellations, payment events
- **Provisions customer instances** — spins up AWS Lightsail boxes via `provision.sh`
- **Monitors fleet health** — cron jobs run health checks, metrics collection, and expired instance cleanup
- **Sends notifications** — Discord ops channel + email via Resend

## Launch & Bootstrap

### 1. Launch an EC2 Instance

- **AMI:** Ubuntu 24.04 LTS (amd64)
- **Size:** `t3.small` or larger (this is control plane only, not running customer workloads)
- **Storage:** 20 GB gp3
- **Security group:** Allow inbound 22, 80, 443
- **Key pair:** Your SSH key

### 2. Run the Bootstrap

```bash
ssh ubuntu@<your-ec2-ip>
git clone https://github.com/rendrag-git/clawdaddy.git /tmp/clawdaddy-bootstrap
sudo bash /tmp/clawdaddy-bootstrap/script/bootstrap-server.sh
```

This installs everything: Node.js 22, Docker, AWS CLI, PM2, nginx, certbot, cloudflared, and configures the webhook server as a managed service.

## Post-Bootstrap Configuration

### Secrets (required)

Edit `/opt/clawdaddy/script/webhook-server/.env` and fill in all `CHANGEME` values:

| Variable | Where to get it |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Webhooks → Signing secret |
| `RESEND_API_KEY` | Resend dashboard |
| `DISCORD_OPS_WEBHOOK_URL` | Discord channel settings → Integrations → Webhooks |
| `STRIPE_PRODUCT_BYOK` | Stripe product ID for BYOK tier |
| `STRIPE_PRODUCT_MANAGED` | Stripe product ID for managed tier |
| `OPERATOR_API_KEY` | Anthropic Console |
| `PROXY_BUNDLE_URL` | URL to the proxy config bundle |

Then restart: `sudo -u clawdaddy pm2 restart clawdaddy-webhook`

### AWS Credentials (required for provisioning)

```bash
sudo -u clawdaddy aws configure
# Region: us-east-1 (or wherever you run Lightsail instances)
# Output: json
```

The `clawdaddy` user needs IAM permissions for Lightsail (create/delete instances, manage firewall, etc.).

### DNS & SSL

1. Create an A record: `api.clawdaddy.sh` → EC2 public IP (or Elastic IP)
2. Run: `sudo certbot --nginx -d api.clawdaddy.sh`
3. Certbot auto-renews via systemd timer

### Stripe Webhook

In Stripe Dashboard, add a webhook endpoint:
- **URL:** `https://api.clawdaddy.sh/webhook`
- **Events:** `checkout.session.completed`, `customer.subscription.deleted`, `invoice.payment_failed` (and others as needed)

## Verify It's Working

```bash
# Check the service
sudo -u clawdaddy pm2 status
sudo -u clawdaddy pm2 logs clawdaddy-webhook --lines 20

# Hit the health endpoint
curl -s https://api.clawdaddy.sh/health

# Check monitoring crons are installed
cat /etc/cron.d/clawdaddy-monitoring

# Check nginx
sudo nginx -t && curl -I http://localhost

# Check logs
tail -f /var/log/clawdaddy/health-check.log
```

## Updating

```bash
cd /opt/clawdaddy
sudo -u clawdaddy git pull
cd script/webhook-server && sudo -u clawdaddy npm install --omit=dev
sudo -u clawdaddy pm2 restart clawdaddy-webhook
```

Or re-run the bootstrap script — it's idempotent.
