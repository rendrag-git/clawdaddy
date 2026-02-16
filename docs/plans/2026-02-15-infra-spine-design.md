# Infra Spine Design: Provisioning + File Push + DNS

**Date:** 2026-02-15
**Scope:** Gaps #1-3 from the verified gaps summary
**Status:** Approved

---

## Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Server architecture | Onboarding server calls provision.sh directly | Webhook server stays for Stripe webhooks only. Onboarding server owns the provisioning lifecycle. |
| Progress tracking | Spawn + stdout parsing (Approach A) | Proven pattern from webhook server's provisioner.js. Real-time stage tracking. |
| DNS location | Inside provision.sh | Co-located with infrastructure. ~10 lines after static IP allocation. |
| SSH key strategy | Per-instance key generated during provision | Generated before instance creation, public key injected into user-data. |
| Username in customers.json | Stored alongside oc_ ID (Option 2) | oc_<hex> stays as stable internal ID. Username used for human-facing names (instance, IP, DNS, SSH key). |

---

## Section 1: Wire Real Provisioning Into Onboarding

### provision.sh Changes

**New flag: `--username`**
- New `ARG_USERNAME` variable, parsed in `parse_args()`
- Validated: required when called, 3-20 chars, lowercase alphanumeric + hyphens
- Used for naming:
  - `instance_name="openclaw-${ARG_USERNAME}"` (replaces `openclaw-${customer_id}` at line 768)
  - `static_ip_name="openclaw-${ARG_USERNAME}"` (replaces line 769)

**SSH keypair generation (before instance creation, before line 808):**
```
KEY_DIR="${SSH_KEY_DIR:-${HOME}/.ssh/customer-keys}"
mkdir -p "${KEY_DIR}" && chmod 700 "${KEY_DIR}"
ssh-keygen -t ed25519 -f "${KEY_DIR}/openclaw-${ARG_USERNAME}" -N "" -C "openclaw-${ARG_USERNAME}"
chmod 600 "${KEY_DIR}/openclaw-${ARG_USERNAME}"
```
Public key contents read and injected into `generate_user_data()` output — appended to `/home/ubuntu/.ssh/authorized_keys` on first boot via the user-data script.

**Stage markers (new stdout lines between existing steps):**
- `STAGE=creating_instance` — before line 809
- `STAGE=waiting_for_instance` — before line 848
- `STAGE=allocating_ip` — before line 856
- `STAGE=configuring_firewall` — before line 897
- `STAGE=waiting_for_health` — before line 914

**Customer record gets `username` field:**
- `add_customer_record()` gains a `username` parameter
- Stored in jq template as `.username: $username`

**Machine-readable output block gains:**
```
USERNAME=<username>
SSH_KEY_PATH=~/.ssh/customer-keys/openclaw-<username>
```

### New File: api/lib/provisioner.js

Port of `script/webhook-server/lib/provisioner.js`, adapted for onboarding server:

```
spawnProvision(params, onStageChange) → Promise<{
  customerId, serverIp, vncPassword, sshKeyPath, username, tier
}>
```

- Spawns `bash provision.sh --email <email> --username <username> --tier managed --stripe-checkout-session-id <id>`
- Parses stdout line-by-line for `STAGE=*` markers → calls `onStageChange(stage)`
- Parses final output for `CUSTOMER_ID=`, `SERVER_IP=`, `VNC_PASSWORD=`, `SSH_KEY_PATH=`, `USERNAME=`
- Logs to `provision-onboarding-<timestamp>.log`
- Rejects promise on non-zero exit code

### onboarding-server.js Changes

**POST `/api/onboarding` (line 225):**

Triggered by explicit user action — the "Start Setup" button in the wizard, after username and bot name are chosen. NOT triggered by the initial page load (buffer page handles that).

1. Validate Stripe session (unchanged)
2. Create session record with `status: 'queued'` (unchanged)
3. **Return immediately** with `{ ok: true, status: 'queued' }`
4. After response, fire-and-forget:
   ```js
   void spawnProvision({
     email: record.email,
     username: record.username,
     tier: 'managed',
     stripeCheckoutSessionId: sessionId,
     // ... other params from Stripe metadata
   }, (stage) => {
     record.provisionStage = stage;
     record.updatedAt = new Date().toISOString();
     saveStore(store); // async, no await needed for stage updates
   }).then(result => {
     record.status = 'ready';
     record.serverIp = result.serverIp;
     record.sshKeyPath = result.sshKeyPath;
     record.customerId = result.customerId;
     record.vncPassword = result.vncPassword;
     record.provisionStage = 'complete';
     saveStore(store);
   }).catch(err => {
     record.status = 'failed';
     record.provisionError = err.message;
     saveStore(store);
   });
   ```

**GET `/api/onboarding/status/:sessionId` (line 300):**
- Remove `AUTO_PROGRESS` check and `advanceStatus()` call
- Return `{ status, provisionStage, webchatUrl }` directly from record

**Cleanup — remove entirely:**
- `AUTO_PROGRESS` constant (line 18)
- `QUEUED_TO_PROVISIONING_MS` constant (line 16)
- `PROVISIONING_TO_READY_MS` constant (line 17)
- `advanceStatus()` function (wherever it's defined)

### Welcome Email with Onboarding Link

After payment, Stripe fires `checkout.session.completed`. The webhook server's handler (when `metadata.onboarding === 'true'`) sends a welcome email containing the onboarding URL: `https://clawdaddy.sh/onboarding/?session_id=cs_...`. This lets the customer close the browser after paying and come back later via the email link.

**No change to onboarding server** — this is a webhook server email template update. Add a new `onboarding_welcome` template to `script/webhook-server/lib/email.js` that includes the onboarding URL constructed from the checkout session ID.

### Buffer Page Before Onboarding Wizard

When the customer hits `/onboarding/?session_id=cs_...` (via Stripe redirect or email link), the frontend shows a **"Thanks for subscribing — ready to set up?"** landing page with a **Start Setup** button. This is a frontend-only change in `onboarding/index.html`.

**Provisioning does NOT fire on page load.** The POST `/api/onboarding` call that triggers provisioning only happens after explicit user action deeper in the wizard flow (after the customer has chosen a username and bot name). This prevents wasted provisions from:
- Bounced visits (customer lands on page, leaves)
- Accidental reloads
- Link previews from email clients

### Double-Provision Prevention

**Problem:** Customer pays → Stripe fires `checkout.session.completed` → webhook server provisions. Meanwhile customer hits onboarding page → onboarding server also provisions. Two instances.

**Solution (two layers):**

1. **Stripe metadata gate:** Add `onboarding: true` to Stripe checkout session metadata (configured on the Payment Link in Stripe Dashboard). In webhook server's `handle_checkout_completed` (stripe-handlers.js line 22):
   - Check `metadata.onboarding === 'true'`
   - If true: send welcome email with onboarding link only, skip `spawn_provision()`
   - If false: provision as before (covers direct/non-onboarding purchases)

2. **Buffer page delay:** Provisioning only starts when the customer explicitly submits the setup form, not on page load. Even if both servers somehow tried to provision, there's a human-speed gap between the webhook firing and the customer clicking "Start Setup".

---

## Section 2: Push Generated Files to Customer Instance

### Target Path

`install-openclaw.sh` sets `WORKSPACE_DIR="${HOME}/clawd"` (line 22) and writes SOUL.md/USER.md there (lines 807-833). Target path: `/home/ubuntu/clawd/`.

### onboarding-server.js — write-files endpoint changes

POST `/api/onboarding/write-files/:sessionId` (line 465) becomes:

1. **Guard:** If `record.status !== 'ready'` or `!record.serverIp` or `!record.sshKeyPath`, return 400 "Instance not provisioned yet."
2. **Write locally** (unchanged, lines 487-507) — backup + inspection
3. **SCP to instance:**
   ```js
   const scpOpts = ['-i', record.sshKeyPath, '-o', 'StrictHostKeyChecking=no'];
   const remoteBase = `ubuntu@${record.serverIp}:/home/ubuntu/clawd`;

   for (const filename of ['SOUL.md', 'USER.md', 'IDENTITY.md', 'BOOTSTRAP.md']) {
     await execFile('scp', [...scpOpts, path.join(outputDir, filename), `${remoteBase}/${filename}`]);
   }
   ```
4. **Set permissions:**
   ```js
   await execFile('ssh', ['-i', record.sshKeyPath, '-o', 'StrictHostKeyChecking=no',
     `ubuntu@${record.serverIp}`, 'chmod 644 /home/ubuntu/clawd/SOUL.md /home/ubuntu/clawd/USER.md /home/ubuntu/clawd/IDENTITY.md /home/ubuntu/clawd/BOOTSTRAP.md']);
   ```
5. **Update record:** `record.filesDeployed = true` (new field, distinct from existing `filesWritten`)

### Error Handling

- If SCP fails (instance not reachable, SSH key rejected): return 502 with error, keep `filesDeployed = false`
- Frontend can retry the write-files call
- Local files are always written regardless of SCP outcome

---

## Section 3: DNS Automation

### provision.sh — Route 53 A Record

Added after static IP retrieval (after line 889, before firewall config):

```bash
# ------------------------------------------------------------------
# Step 4b: Create DNS record
# ------------------------------------------------------------------
if [[ -n "${ARG_USERNAME}" && -n "${ROUTE53_HOSTED_ZONE_ID}" ]]; then
    info "Creating DNS record: ${ARG_USERNAME}.clawdaddy.sh -> ${static_ip}"
    echo "STAGE=creating_dns"

    local dns_change
    dns_change="$(cat <<DNSEOF
{
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "${ARG_USERNAME}.clawdaddy.sh",
      "Type": "A",
      "TTL": 300,
      "ResourceRecords": [{"Value": "${static_ip}"}]
    }
  }]
}
DNSEOF
)"

    if aws route53 change-resource-record-sets \
        --hosted-zone-id "${ROUTE53_HOSTED_ZONE_ID}" \
        --change-batch "${dns_change}" \
        >> "${LOG_FILE}" 2>&1; then
        ok "DNS record created: ${ARG_USERNAME}.clawdaddy.sh"
    else
        warn "DNS record creation failed (non-fatal)"
    fi
fi
```

### Environment Variable

- `ROUTE53_HOSTED_ZONE_ID` — the hosted zone ID for `clawdaddy.sh`. Required for DNS creation. If unset, DNS step is skipped with a warning.

### Machine-Readable Output

Adds `DNS_HOSTNAME=<username>.clawdaddy.sh` to the final output block (only if DNS was created).

### Stage Marker

`STAGE=creating_dns` — added to the stage sequence between `allocating_ip` and `configuring_firewall`.

Full stage sequence becomes:
`creating_instance` → `waiting_for_instance` → `allocating_ip` → `creating_dns` → `configuring_firewall` → `waiting_for_health`

---

## Failure Modes & Recovery

### Customer-facing state on failure

| Failure point | Customer sees | Instance state | Recovery |
|---------------|---------------|----------------|----------|
| provision.sh exits non-zero (any stage) | `status: 'failed'`, `provisionError` in status response | Partial — instance/IP may exist | Ops investigates, customer retries or contacts support |
| Provision succeeds, DNS fails | `status: 'ready'` — DNS failure is non-fatal | Fully running, no subdomain | Ops creates DNS manually, or customer retries provision (idempotent UPSERT) |
| Provision succeeds, file push (SCP) fails | `status: 'ready'`, `filesDeployed: false` | Running with default SOUL.md/USER.md from install-openclaw.sh | Frontend retries write-files endpoint. Customer has a working instance either way. |

### Cleanup on failure

**No automatic cleanup.** If provisioning fails halfway (instance created, IP allocated, DNS not done), resources are left in place. Rationale:
- You need to SSH in and read `/var/log/openclaw-userdata.log` to debug
- Automatic teardown destroys evidence
- Lightsail nano instances cost ~$3.50/mo — a stale one for a few days is negligible

**Manual cleanup path:** `manage.sh destroy <customer_id>` already handles instance + IP teardown. After investigation, ops runs this to clean up. The `customers.json` record with `status: 'failed'` serves as the audit trail.

**Future consideration:** A cron job that reaps `failed` records older than 72 hours. Not in scope for this design.

### Logging & alerting

| Event | Where it's logged | Who's notified |
|-------|-------------------|----------------|
| Provision spawn | `provision-onboarding-<timestamp>.log` (new provisioner.js) | Console only |
| Provision stage changes | Session record (`provisionStage` field) | Frontend via status polling |
| Provision failure | Session record + log file | **Discord ops webhook** (port from webhook server's `discord_alert()` pattern) + console |
| SCP/file push failure | Console | Frontend gets 502, can retry |
| DNS failure | provision.sh log file | Console warning (non-fatal) |

The webhook server already has `DISCORD_OPS_WEBHOOK_URL` for alerting. The onboarding server's provisioner.js should accept the same env var and send alerts on provision failure. Same pattern as `script/webhook-server/lib/provisioner.js` lines 14-25.

---

## Files Changed (Summary)

| File | Type | What |
|------|------|------|
| `script/provision.sh` | Edit | Add --username flag, --key-dir flag, SSH keygen to persistent dir, stage markers, DNS automation, username in customer record |
| `api/lib/provisioner.js` | New | Spawn + parse provision.sh with stage callbacks, Discord alerting |
| `api/onboarding-server.js` | Edit | Wire real provisioning, remove fake timers, add SCP file push, update `buildWebchatUrl()` to use `dnsHostname` |
| `script/webhook-server/lib/stripe-handlers.js` | Edit | Skip provisioning when `metadata.onboarding === 'true'`, send welcome email instead |
| `script/webhook-server/lib/email.js` | Edit | Add `onboarding_welcome` email template with onboarding URL |
| `onboarding/index.html` | Edit | Add buffer page ("Thanks for subscribing") before wizard starts |
| Stripe Payment Link (Dashboard) | Config | Add `onboarding: true` to metadata on the Payment Link in Stripe Dashboard |

## Environment Variables (New)

| Variable | Where | Purpose |
|----------|-------|---------|
| `ROUTE53_HOSTED_ZONE_ID` | provision.sh | Hosted zone for clawdaddy.sh DNS |
| `PROVISION_SCRIPT` | onboarding-server | Path to provision.sh (default: `../script/provision.sh`) |
| `DISCORD_OPS_WEBHOOK_URL` | onboarding-server | Discord webhook for provision failure alerts (same as webhook server) |
| `SSH_KEY_DIR` | provision.sh | Persistent SSH key directory (default: `~/.ssh/customer-keys/`) |

---

## Resolved Questions

1. **Stripe checkout metadata** — Checkout sessions are created via **Stripe Payment Links** (configured in Stripe Dashboard), not in code. The onboarding page reads `session_id` from URL params after Stripe redirects to `/onboarding/?session_id=cs_...`. Adding `metadata.onboarding: 'true'` is a **Stripe Dashboard config change** on the Payment Link settings. No code change in this repo.

2. **SSH key storage** — Persistent directory, not `/tmp/`. Store at `~/.ssh/customer-keys/` on the control plane server. Key files: `openclaw-<username>` (private, chmod 600) and `openclaw-<username>.pub`. Directory: chmod 700. provision.sh writes keys there. Session record stores the full path. Survives restarts, also gives a recoverable key archive for future config pushes. Update `PROVISION_SCRIPT` env or pass `--key-dir` to provision.sh.

3. **Webchat URL format** — `buildWebchatUrl(record)` updated to check `record.dnsHostname` (populated from `DNS_HOSTNAME=` in provision output). If set: return `https://${record.dnsHostname}`. If not (fallback for pre-DNS customers): keep old `<slug>-<suffix>` logic. This ships with the DNS work — not optional. Status endpoint and any email templates that reference webchat URL also updated.
