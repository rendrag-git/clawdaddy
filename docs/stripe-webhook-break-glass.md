# Stripe Webhook Break-Glass Runbook

## Purpose
Recover Stripe → webhook ingestion when checkout events are not creating customers/provisioning.

## Symptoms
- Paid checkout completes in Stripe, but no customer appears in onboarding DB
- `/api/onboarding` returns `Customer not found. Payment may still be processing.`
- No recent webhook logs for `checkout.session.completed`

## Current Architecture
- Stripe webhook receiver: `https://api.clawdaddy.sh/webhook`
- Nginx proxy on control plane routes `/webhook` → `127.0.0.1:3000`
- Webhook app: `/home/ubuntu/clawdaddy/script/webhook-server/server.js`
- Service: `openclaw-webhook.service`
- Secrets:
  - `/home/ubuntu/clawdaddy/.secrets/stripe-key`
  - `/home/ubuntu/clawdaddy/.secrets/stripe-webhook-secret`

## 1) Quick Health Checks
```bash
# service status
sudo systemctl status openclaw-webhook --no-pager

# local health
curl -s http://127.0.0.1:3000/health

# public health via proxy
curl -s https://api.clawdaddy.sh/health

# recent logs
journalctl -u openclaw-webhook -n 100 --no-pager
```

## 2) Verify Stripe Endpoint Exists (test or live mode)
```bash
cd /home/ubuntu/clawdaddy/script/webhook-server
node -e "
import('stripe').then(({default:Stripe}) => {
  const fs = require('fs');
  const s = new Stripe(fs.readFileSync('/home/ubuntu/clawdaddy/.secrets/stripe-key','utf8').trim());
  s.webhookEndpoints.list({limit:20}).then(r => console.log(r.data.map(e=>({id:e.id,url:e.url,status:e.status,events:e.enabled_events}))));
});
"
```

Expected URL: `https://api.clawdaddy.sh/webhook`

## 3) Create Endpoint (if missing)
```bash
cd /home/ubuntu/clawdaddy/script/webhook-server
node -e "
import('stripe').then(({default:Stripe}) => {
  const fs = require('fs');
  const s = new Stripe(fs.readFileSync('/home/ubuntu/clawdaddy/.secrets/stripe-key','utf8').trim());
  s.webhookEndpoints.create({
    url: 'https://api.clawdaddy.sh/webhook',
    enabled_events: [
      'checkout.session.completed',
      'customer.subscription.deleted',
      'invoice.payment_failed'
    ]
  }).then(ep => {
    console.log('ID', ep.id);
    console.log('SECRET', ep.secret);
  });
});
"
```

Save returned secret:
```bash
sudo install -m 600 /dev/null /home/ubuntu/clawdaddy/.secrets/stripe-webhook-secret
# paste secret value:
sudo tee /home/ubuntu/clawdaddy/.secrets/stripe-webhook-secret >/dev/null
```

## 4) Restart Webhook Service
```bash
sudo systemctl daemon-reload
sudo systemctl restart openclaw-webhook
sudo systemctl status openclaw-webhook --no-pager
```

## 5) Replay Missed Events
List recent checkout completions:
```bash
cd /home/ubuntu/clawdaddy/script/webhook-server
node -e "
import('stripe').then(({default:Stripe}) => {
  const fs = require('fs');
  const s = new Stripe(fs.readFileSync('/home/ubuntu/clawdaddy/.secrets/stripe-key','utf8').trim());
  s.events.list({limit:20, type:'checkout.session.completed'}).then(r => {
    r.data.forEach(e => console.log(e.id, new Date(e.created*1000).toISOString(), e.data.object.id));
  });
});
"
```

For each missed event, replay from Stripe Dashboard (Developers → Events → event → Resend) to endpoint `https://api.clawdaddy.sh/webhook`.

## 6) Verify End-to-End
- Make one test checkout
- Confirm webhook log shows `Received event: checkout.session.completed`
- Confirm customer row + onboarding session created
- Confirm provisioning starts

## Mode Safety (Important)
Stripe **test** and **live** modes are separate:
- separate API keys
- separate webhook endpoints
- separate webhook signing secrets

When switching modes, repeat endpoint + secret setup.
