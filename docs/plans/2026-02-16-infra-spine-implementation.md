# Infra Spine Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire real Lightsail provisioning into the onboarding flow, push generated personality files to customer instances via SCP, and automate DNS record creation.

**Architecture:** The onboarding server (port 3848) spawns provision.sh directly as a child process, parsing stdout for stage markers to give the frontend real-time progress. SSH keys are generated per-instance before the Lightsail box is created, so the onboarding server can SCP files later. DNS A records are created inside provision.sh via Route 53 UPSERT.

**Tech Stack:** Node.js (Express), Bash (provision.sh), AWS CLI (Lightsail + Route 53), ssh-keygen, scp

**Design doc:** `docs/plans/2026-02-15-infra-spine-design.md`

---

## Task Map

```
Task 1: provision.sh --username flag + naming
Task 2: provision.sh SSH keygen + user-data injection
Task 3: provision.sh stage markers
Task 4: provision.sh DNS automation
Task 5: provision.sh customer record + machine-readable output
Task 6: api/lib/provisioner.js (new file)
Task 7: onboarding-server.js — remove fake timers
Task 8: onboarding-server.js — wire real provisioning
Task 9: onboarding-server.js — update buildWebchatUrl()
Task 10: onboarding-server.js — SCP file push
Task 11: webhook server — double-provision gate + welcome email
Task 12: onboarding frontend — buffer page
```

Dependencies: 1→2→3→4→5 (provision.sh, sequential). 6 depends on 3+5. 7→8 depends on 6. 9 depends on 4. 10 depends on 8. 11 and 12 are independent of each other and of 6-10.

---

### Task 1: provision.sh — Add `--username` flag and use it for naming

**Files:**
- Modify: `script/provision.sh:107-118` (arg declarations)
- Modify: `script/provision.sh:120-151` (usage text)
- Modify: `script/provision.sh:154-242` (parse_args)
- Modify: `script/provision.sh:768-769` (instance/IP naming)

**Step 1: Add ARG_USERNAME declaration**

In `script/provision.sh`, after line 118 (`ARG_STRIPE_CHECKOUT_SESSION_ID=""`), add:

```bash
ARG_USERNAME=""
```

**Step 2: Add --username to usage text**

In the usage() function, after the `--stripe-checkout-session-id` line (line 140), add:

```
  --username           Customer username for DNS and instance naming (3-20 chars, lowercase alphanumeric + hyphens)
```

And add to the Environment section:

```
  SSH_KEY_DIR          Persistent directory for SSH keys (default: ~/.ssh/customer-keys/)
  ROUTE53_HOSTED_ZONE_ID  Route 53 hosted zone ID for clawdaddy.sh DNS
```

**Step 3: Add --username case to parse_args**

In the case statement inside `parse_args()`, after the `--stripe-checkout-session-id` case (before `--help`), add:

```bash
            --username)
                ARG_USERNAME="${2:?--username requires a value}"
                shift 2
                ;;
```

**Step 4: Add username validation to parse_args**

After the existing validation block (after line 241, before the closing `}`), add:

```bash
    # Validate --username if provided
    if [[ -n "${ARG_USERNAME}" ]]; then
        if [[ ${#ARG_USERNAME} -lt 3 || ${#ARG_USERNAME} -gt 20 ]]; then
            die "--username must be 3-20 characters"
        fi
        if [[ ! "${ARG_USERNAME}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
            die "--username must be lowercase alphanumeric with hyphens, no leading/trailing hyphens"
        fi
    fi
```

**Step 5: Use username for instance and IP naming**

Replace line 768:
```bash
    local instance_name="openclaw-${customer_id}"
```
with:
```bash
    local instance_name="openclaw-${ARG_USERNAME:-${customer_id}}"
```

Replace line 769:
```bash
    local static_ip_name="openclaw-${customer_id}"
```
with:
```bash
    local static_ip_name="openclaw-${ARG_USERNAME:-${customer_id}}"
```

**Step 6: Verify the script still parses**

Run: `bash script/provision.sh --help`
Expected: Shows usage text with new `--username` flag listed.

Run: `bash -n script/provision.sh`
Expected: No syntax errors.

**Step 7: Commit**

```bash
git add script/provision.sh
git commit -m "feat(provision): add --username flag for instance and IP naming"
```

---

### Task 2: provision.sh — SSH keypair generation + user-data injection

**Files:**
- Modify: `script/provision.sh:285-295` (generate_user_data signature)
- Modify: `script/provision.sh:777-804` (main, before instance creation)

**Step 1: Generate SSH keypair before instance creation**

In the `main()` function, after the vnc_password generation (after line 769, after the new instance_name/static_ip_name lines) and before "Step 1: Generate user-data" (line 778), add:

```bash
    # ------------------------------------------------------------------
    # Step 0b: Generate SSH keypair for control plane access
    # ------------------------------------------------------------------
    local ssh_key_path=""
    if [[ -n "${ARG_USERNAME}" ]]; then
        local key_dir="${SSH_KEY_DIR:-${HOME}/.ssh/customer-keys}"
        mkdir -p "${key_dir}" && chmod 700 "${key_dir}"
        ssh_key_path="${key_dir}/openclaw-${ARG_USERNAME}"
        if [[ -f "${ssh_key_path}" ]]; then
            warn "SSH key already exists at ${ssh_key_path}, reusing"
        else
            ssh-keygen -t ed25519 -f "${ssh_key_path}" -N "" -C "openclaw-${ARG_USERNAME}" >> "${LOG_FILE}" 2>&1
            chmod 600 "${ssh_key_path}"
            ok "SSH keypair generated: ${ssh_key_path}"
        fi
    fi
```

**Step 2: Add public key parameter to generate_user_data**

The `generate_user_data()` function currently accepts 10 positional args (lines 285-295). Add an 11th. Change:

```bash
    local tier="${9:-byok}"
```

After it (the 10th arg is already the customer_id on line 476), add after the existing parameter list:

```bash
    local ssh_pub_key="${11:-}"
```

**Step 3: Inject public key into user-data script**

In the user-data output, after the `USERDATA_VARS` heredoc (after line 318), add a new section that appends the public key to authorized_keys:

```bash
    if [[ -n "${ssh_pub_key}" ]]; then
        cat <<USERDATA_SSHKEY

# ---------------------------------------------------------------------------
# Add control plane SSH public key
# ---------------------------------------------------------------------------
mkdir -p /home/ubuntu/.ssh
chmod 700 /home/ubuntu/.ssh
echo '${ssh_pub_key}' >> /home/ubuntu/.ssh/authorized_keys
chmod 600 /home/ubuntu/.ssh/authorized_keys
chown -R ubuntu:ubuntu /home/ubuntu/.ssh
USERDATA_SSHKEY
    fi
```

**Step 4: Pass public key and SSH key path to generate_user_data call**

In `main()`, the `generate_user_data` call (lines 791-802) currently passes 10 args. Read the public key and pass it as arg 11:

```bash
    local ssh_pub_key_contents=""
    if [[ -n "${ssh_key_path}" && -f "${ssh_key_path}.pub" ]]; then
        ssh_pub_key_contents="$(cat "${ssh_key_path}.pub")"
    fi
```

Then add `"${ssh_pub_key_contents}"` as the 11th arg to the generate_user_data call:

```bash
    generate_user_data \
        "${effective_api_key}" \
        "${ARG_DISCORD_TOKEN}" \
        "${ARG_DISCORD_CHANNEL}" \
        "${ARG_TELEGRAM_TOKEN}" \
        "${ARG_TELEGRAM_CHAT}" \
        "${ARG_SIGNAL_PHONE}" \
        "${vnc_password}" \
        "${INSTALL_SCRIPT_URL}" \
        "${ARG_TIER}" \
        "${customer_id}" \
        "${ssh_pub_key_contents}" \
        > "${userdata_file}"
```

**Step 5: Verify syntax**

Run: `bash -n script/provision.sh`
Expected: No syntax errors.

**Step 6: Commit**

```bash
git add script/provision.sh
git commit -m "feat(provision): generate per-instance SSH keypair and inject into user-data"
```

---

### Task 3: provision.sh — Add stage markers to stdout

**Files:**
- Modify: `script/provision.sh` (lines 809, 848, 856, 893, 897, 914)

**Step 1: Add stage markers before each major step**

Insert `echo "STAGE=<name>"` lines at these locations:

Before line 809 (`info "Creating Lightsail instance..."`):
```bash
    echo "STAGE=creating_instance"
```

Before line 848 (`if ! wait_for_instance`):
```bash
    echo "STAGE=waiting_for_instance"
```

Before line 856 (`info "Allocating static IP..."`):
```bash
    echo "STAGE=allocating_ip"
```

After line 892 (`update_customer_status "${customer_id}" "provisioning" "${static_ip}"`) — this is where DNS will go in Task 4, but add the firewall marker now:

Before line 897 (`info "Configuring Lightsail firewall ports..."`):
```bash
    echo "STAGE=configuring_firewall"
```

Before line 914 (`if wait_for_health`):
```bash
    echo "STAGE=waiting_for_health"
```

**Step 2: Verify syntax**

Run: `bash -n script/provision.sh`
Expected: No syntax errors.

**Step 3: Commit**

```bash
git add script/provision.sh
git commit -m "feat(provision): add STAGE= stdout markers for real-time progress tracking"
```

---

### Task 4: provision.sh — DNS automation via Route 53

**Files:**
- Modify: `script/provision.sh` (after line 892, before firewall config)

**Step 1: Add DNS record creation**

After line 892 (`update_customer_status "${customer_id}" "provisioning" "${static_ip}"`) and before the `STAGE=configuring_firewall` marker (from Task 3), add:

```bash
    # ------------------------------------------------------------------
    # Step 4b: Create DNS record
    # ------------------------------------------------------------------
    local dns_created="false"
    if [[ -n "${ARG_USERNAME}" && -n "${ROUTE53_HOSTED_ZONE_ID:-}" ]]; then
        echo "STAGE=creating_dns"
        info "Creating DNS record: ${ARG_USERNAME}.clawdaddy.sh -> ${static_ip}"

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
            dns_created="true"
        else
            warn "DNS record creation failed (non-fatal)"
        fi
    elif [[ -n "${ARG_USERNAME}" && -z "${ROUTE53_HOSTED_ZONE_ID:-}" ]]; then
        warn "ROUTE53_HOSTED_ZONE_ID not set, skipping DNS record creation"
    fi
```

**Step 2: Verify syntax**

Run: `bash -n script/provision.sh`
Expected: No syntax errors.

**Step 3: Commit**

```bash
git add script/provision.sh
git commit -m "feat(provision): add Route 53 DNS A record creation for <username>.clawdaddy.sh"
```

---

### Task 5: provision.sh — Add username to customer record + machine-readable output

**Files:**
- Modify: `script/provision.sh:577-636` (add_customer_record)
- Modify: `script/provision.sh:834-843` (provisioning record call)
- Modify: `script/provision.sh:824-829` (failed record call)
- Modify: `script/provision.sh:935-939` (machine-readable output)

**Step 1: Add username parameter to add_customer_record**

In `add_customer_record()`, after line 591 (`local stripe_checkout_session_id="${14:-}"`), add:

```bash
    local username="${15:-}"
```

In the jq template (line 614-632), after the `destroy_scheduled_at: null` line (line 631), add:

```
            username: (if $username == "" then null else $username end),
```

And add to the jq args (before the closing `'`):

```
       --arg username "${username}" \
```

**Step 2: Pass username to all add_customer_record calls**

There are two calls to `add_customer_record` in `main()`:

1. The "failed" call (around line 824-829) — add `"${ARG_USERNAME}"` as the 15th argument
2. The "provisioning" call (around line 839-843) — add `"${ARG_USERNAME}"` as the 15th argument

**Step 3: Add to machine-readable output**

After line 939 (`echo "TIER=${ARG_TIER}"`), add:

```bash
        if [[ -n "${ARG_USERNAME}" ]]; then
            echo "USERNAME=${ARG_USERNAME}"
        fi
        if [[ -n "${ssh_key_path}" ]]; then
            echo "SSH_KEY_PATH=${ssh_key_path}"
        fi
        if [[ "${dns_created}" == "true" ]]; then
            echo "DNS_HOSTNAME=${ARG_USERNAME}.clawdaddy.sh"
        fi
```

**Step 4: Verify syntax**

Run: `bash -n script/provision.sh`
Expected: No syntax errors.

**Step 5: Commit**

```bash
git add script/provision.sh
git commit -m "feat(provision): store username in customer record, add SSH/DNS to machine-readable output"
```

---

### Task 6: Create api/lib/provisioner.js

**Files:**
- Create: `api/lib/provisioner.js`

**Step 1: Create the provisioner module**

```js
const { spawn } = require('node:child_process');
const { createWriteStream } = require('node:fs');
const path = require('node:path');

const PROVISION_SCRIPT = path.resolve(process.env.PROVISION_SCRIPT || path.join(__dirname, '..', '..', 'script', 'provision.sh'));
const DISCORD_OPS_WEBHOOK_URL = process.env.DISCORD_OPS_WEBHOOK_URL;

function logAppend(logFile, msg) {
  const stream = createWriteStream(logFile, { flags: 'a' });
  stream.write(`[${new Date().toISOString()}] ${msg}\n`);
  stream.end();
}

async function discordAlert(message) {
  if (!DISCORD_OPS_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_OPS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
  } catch (err) {
    console.error(`Discord alert failed: ${err.message}`);
  }
}

function spawnProvision(params, onStageChange) {
  return new Promise((resolve, reject) => {
    const args = ['--email', params.email];

    if (params.username) args.push('--username', params.username);
    if (params.tier) args.push('--tier', params.tier);
    if (params.apiKey && params.tier !== 'managed') args.push('--api-key', params.apiKey);
    if (params.discordToken) {
      args.push('--discord-token', params.discordToken);
      args.push('--discord-channel', params.discordChannel || '');
    }
    if (params.telegramToken) {
      args.push('--telegram-token', params.telegramToken);
      args.push('--telegram-chat', params.telegramChat || '');
    }
    if (params.signalPhone) args.push('--signal-phone', params.signalPhone);
    if (params.region) args.push('--region', params.region);
    if (params.stripeCustomerId) args.push('--stripe-customer-id', params.stripeCustomerId);
    if (params.stripeSubscriptionId) args.push('--stripe-subscription-id', params.stripeSubscriptionId);
    if (params.stripeCheckoutSessionId) args.push('--stripe-checkout-session-id', params.stripeCheckoutSessionId);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const logFile = path.join(__dirname, '..', `provision-onboarding-${timestamp}.log`);

    logAppend(logFile, `Spawning provision.sh for ${params.email} (username: ${params.username || 'none'})`);

    const child = spawn('bash', [PROVISION_SCRIPT, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      logAppend(logFile, `[stdout] ${text.trim()}`);

      // Parse stage markers in real-time
      const lines = text.split('\n');
      for (const line of lines) {
        const stageMatch = line.match(/^STAGE=(.+)$/);
        if (stageMatch && onStageChange) {
          onStageChange(stageMatch[1].trim());
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      logAppend(logFile, `[stderr] ${text.trim()}`);
    });

    child.on('close', async (code) => {
      if (code === 0) {
        const result = {
          customerId: (stdout.match(/CUSTOMER_ID=(.+)/) || [])[1]?.trim() || null,
          serverIp: (stdout.match(/SERVER_IP=(.+)/) || [])[1]?.trim() || null,
          vncPassword: (stdout.match(/VNC_PASSWORD=(.+)/) || [])[1]?.trim() || null,
          sshKeyPath: (stdout.match(/SSH_KEY_PATH=(.+)/) || [])[1]?.trim() || null,
          username: (stdout.match(/USERNAME=(.+)/) || [])[1]?.trim() || null,
          dnsHostname: (stdout.match(/DNS_HOSTNAME=(.+)/) || [])[1]?.trim() || null,
          tier: (stdout.match(/TIER=(.+)/) || [])[1]?.trim() || null,
        };
        logAppend(logFile, `Provisioning complete: ${JSON.stringify(result)}`);
        resolve(result);
      } else {
        const msg = `Provision failed for ${params.email} (exit ${code}): ${stderr.slice(-500)}`;
        logAppend(logFile, msg);
        await discordAlert(`@here Provision FAILED for ${params.email} (username: ${params.username || 'none'}) -- exit code ${code}. Check ${logFile}`);
        reject(new Error(msg));
      }
    });

    child.on('error', async (err) => {
      const msg = `Provision spawn error for ${params.email}: ${err.message}`;
      logAppend(logFile, msg);
      await discordAlert(`@here Provision spawn FAILED for ${params.email}: ${err.message}`);
      reject(new Error(msg));
    });
  });
}

module.exports = { spawnProvision };
```

**Step 2: Verify it loads without errors**

Run: `node -e "require('./api/lib/provisioner.js'); console.log('OK')"`
Expected: `OK`

**Step 3: Commit**

```bash
git add api/lib/provisioner.js
git commit -m "feat: add api/lib/provisioner.js — spawn + parse provision.sh with stage callbacks"
```

---

### Task 7: onboarding-server.js — Remove fake timer logic

**Files:**
- Modify: `api/onboarding-server.js:16-18` (constants)
- Modify: `api/onboarding-server.js:194-223` (advanceStatus function)
- Modify: `api/onboarding-server.js:300-332` (status endpoint)

**Step 1: Remove fake timer constants**

Delete these three lines (16-18):

```js
const QUEUED_TO_PROVISIONING_MS = Number(process.env.QUEUED_TO_PROVISIONING_MS || 15000);
const PROVISIONING_TO_READY_MS = Number(process.env.PROVISIONING_TO_READY_MS || 45000);
const AUTO_PROGRESS = process.env.ONBOARDING_AUTO_PROGRESS !== 'false';
```

**Step 2: Remove advanceStatus function**

Delete the entire function (lines 194-223):

```js
function advanceStatus(record, nowMs) {
  ...
}
```

**Step 3: Update status endpoint to remove auto-advance**

In the GET `/api/onboarding/status/:sessionId` handler (line 300), remove the `AUTO_PROGRESS` block (lines 315-322):

```js
    if (AUTO_PROGRESS) {
      const nowMs = Date.now();
      const changed = advanceStatus(record, nowMs);
      if (changed) {
        store.sessions[sessionId] = record;
        await saveStore(store);
      }
    }
```

And update the response to include `provisionStage`. Change line 324-327:

```js
    return res.json({
      status: record.status,
      webchatUrl: record.status === 'ready' ? record.webchatUrl : null
    });
```

To:

```js
    return res.json({
      status: record.status,
      provisionStage: record.provisionStage || null,
      webchatUrl: record.status === 'ready' ? record.webchatUrl : null
    });
```

**Step 4: Verify the server starts**

Run: `node -e "require('./api/onboarding-server.js')" &` then kill it.
Or: `node -c api/onboarding-server.js`
Expected: No syntax errors.

**Step 5: Commit**

```bash
git add api/onboarding-server.js
git commit -m "refactor(onboarding): remove fake AUTO_PROGRESS timers and advanceStatus"
```

---

### Task 8: onboarding-server.js — Wire real provisioning

**Files:**
- Modify: `api/onboarding-server.js:1-8` (imports)
- Modify: `api/onboarding-server.js:225-298` (POST /api/onboarding handler)

**Step 1: Add provisioner import**

After line 8 (`const { generateProfile } = require('./lib/profile-generator');`), add:

```js
const { spawnProvision } = require('./lib/provisioner');
```

**Step 2: Update POST /api/onboarding to fire-and-forget real provisioning**

The handler currently creates the record and returns. After `await saveStore(store)` (line 280) and before the `console.log` (line 282), add the fire-and-forget provisioning call:

```js
    // Fire-and-forget: spawn real provisioning in background
    void spawnProvision({
      email: checkoutSession.customer_details?.email || record.stripeCustomerEmail || '',
      username: record.username,
      tier: 'managed',
      stripeCustomerId: record.stripeCustomerId || '',
      stripeCheckoutSessionId: sessionId,
    }, (stage) => {
      record.provisionStage = stage;
      record.updatedAt = new Date().toISOString();
      saveStore(store);
    }).then(result => {
      record.status = 'ready';
      record.serverIp = result.serverIp;
      record.sshKeyPath = result.sshKeyPath;
      record.customerId = result.customerId;
      record.vncPassword = result.vncPassword;
      record.dnsHostname = result.dnsHostname;
      record.provisionStage = 'complete';
      record.readyAt = new Date().toISOString();
      record.updatedAt = new Date().toISOString();
      if (result.dnsHostname) {
        record.webchatUrl = `https://${result.dnsHostname}`;
      }
      store.sessions[sessionId] = record;
      saveStore(store);
      console.log(`Provisioning complete for session ${sessionId}: ${result.serverIp}`);
    }).catch(err => {
      record.status = 'failed';
      record.provisionError = err.message;
      record.updatedAt = new Date().toISOString();
      store.sessions[sessionId] = record;
      saveStore(store);
      console.error(`Provisioning failed for session ${sessionId}: ${err.message}`);
    });
```

**Step 3: Verify syntax**

Run: `node -c api/onboarding-server.js`
Expected: No errors.

**Step 4: Commit**

```bash
git add api/onboarding-server.js
git commit -m "feat(onboarding): wire real provisioning via spawnProvision fire-and-forget"
```

---

### Task 9: onboarding-server.js — Update buildWebchatUrl

**Files:**
- Modify: `api/onboarding-server.js:69-73` (buildWebchatUrl function)

**Step 1: Update to use dnsHostname with fallback**

Replace the current `buildWebchatUrl` function (lines 69-73):

```js
function buildWebchatUrl(record) {
  const suffix = record.sessionId.slice(-8).toLowerCase();
  const slug = slugify(record.assistantName || record.displayName);
  return `${WEBCHAT_BASE_URL}/${slug}-${suffix}`;
}
```

With:

```js
function buildWebchatUrl(record) {
  if (record.dnsHostname) {
    return `https://${record.dnsHostname}`;
  }
  // Fallback for pre-DNS customers
  const suffix = record.sessionId.slice(-8).toLowerCase();
  const slug = slugify(record.assistantName || record.displayName);
  return `${WEBCHAT_BASE_URL}/${slug}-${suffix}`;
}
```

**Step 2: Verify syntax**

Run: `node -c api/onboarding-server.js`
Expected: No errors.

**Step 3: Commit**

```bash
git add api/onboarding-server.js
git commit -m "feat(onboarding): buildWebchatUrl uses dnsHostname when available"
```

---

### Task 10: onboarding-server.js — SCP file push to instance

**Files:**
- Modify: `api/onboarding-server.js:1-8` (imports)
- Modify: `api/onboarding-server.js:465-522` (write-files endpoint)

**Step 1: Add execFile import**

At the top of the file, after the existing requires, add:

```js
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
```

**Step 2: Add provisioning guard to write-files**

In POST `/api/onboarding/write-files/:sessionId`, after the `!record.generatedFiles` check (line 480-482), add:

```js
    if (record.status !== 'ready' || !record.serverIp || !record.sshKeyPath) {
      return res.status(400).json({ ok: false, error: 'Instance not provisioned yet. Please wait for provisioning to complete.' });
    }
```

**Step 3: Add SCP deployment after local file write**

After the existing `record.filesWritten = true` line (line 509), add:

```js
    // Deploy files to customer instance via SCP
    let filesDeployed = false;
    try {
      const scpOpts = ['-i', record.sshKeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10'];
      const remoteBase = `ubuntu@${record.serverIp}:/home/ubuntu/clawd`;

      for (const filename of ['SOUL.md', 'USER.md', 'IDENTITY.md', 'BOOTSTRAP.md']) {
        await execFileAsync('scp', [...scpOpts, path.join(outputDir, filename), `${remoteBase}/${filename}`]);
      }

      await execFileAsync('ssh', [
        '-i', record.sshKeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
        `ubuntu@${record.serverIp}`,
        'chmod 644 /home/ubuntu/clawd/SOUL.md /home/ubuntu/clawd/USER.md /home/ubuntu/clawd/IDENTITY.md /home/ubuntu/clawd/BOOTSTRAP.md'
      ]);

      filesDeployed = true;
      console.log(`Files deployed to ${record.serverIp} for session ${sessionId}`);
    } catch (scpErr) {
      console.error(`SCP deployment failed for ${sessionId}: ${scpErr.message}`);
      // Don't fail the request — local files were written successfully
    }

    record.filesDeployed = filesDeployed;
```

**Step 4: Update the response**

Change the existing success response (line 517):

```js
    return res.json({ ok: true, written: ['SOUL.md', 'USER.md', 'IDENTITY.md', 'BOOTSTRAP.md'] });
```

To:

```js
    return res.json({
      ok: true,
      written: ['SOUL.md', 'USER.md', 'IDENTITY.md', 'BOOTSTRAP.md'],
      deployed: filesDeployed
    });
```

**Step 5: Verify syntax**

Run: `node -c api/onboarding-server.js`
Expected: No errors.

**Step 6: Commit**

```bash
git add api/onboarding-server.js
git commit -m "feat(onboarding): SCP generated files to customer instance after local write"
```

---

### Task 11: Webhook server — Double-provision gate + welcome email

**Files:**
- Modify: `script/webhook-server/lib/email.js` (add onboarding_welcome template)
- Modify: `script/webhook-server/lib/stripe-handlers.js:22-78` (checkout handler)

**Step 1: Add onboarding_welcome email template**

In `script/webhook-server/lib/email.js`, after the `provisioning_started_managed` function (after line 55), add:

```js
export async function onboarding_welcome(email, checkout_session_id) {
  const onboarding_url = `https://clawdaddy.sh/onboarding/?session_id=${encodeURIComponent(checkout_session_id)}`;
  await send(email, 'Welcome to ClawDaddy — set up your assistant', `Hi there,

Thanks for subscribing to ClawDaddy!

Click the link below to set up your personal AI assistant. You'll choose a name, take a quick personality quiz, and we'll configure everything for you.

Set up your assistant:
${onboarding_url}

This link doesn't expire — you can come back to it anytime.

If you have any questions, reply to this email.

-- ClawDaddy`);
}
```

**Step 2: Import the new email function in stripe-handlers**

In `script/webhook-server/lib/stripe-handlers.js`, update the import at line 2:

```js
import * as email from './email.js';
```

(Already imports all — no change needed. The new function is available via `email.onboarding_welcome()`.)

**Step 3: Add metadata gate to handle_checkout_completed**

At the top of `handle_checkout_completed`, after `const tier = metadata.tier || 'byok';` (line 29), add:

```js
  // If this checkout was initiated via the onboarding flow, don't provision here.
  // The onboarding server owns the provisioning lifecycle.
  if (metadata.onboarding === 'true') {
    console.log(`Onboarding checkout detected for ${customer_email} (session: ${checkout_session_id}). Sending welcome email only.`);
    try {
      await email.onboarding_welcome(customer_email, checkout_session_id);
    } catch (err) {
      console.error(`Failed to send onboarding welcome email to ${customer_email}: ${err.message}`);
    }
    return;
  }
```

**Step 4: Verify syntax**

Run: `node -c script/webhook-server/lib/email.js` (will fail because ESM — use `node --input-type=module -e "import('./script/webhook-server/lib/email.js')"` or just check syntax manually)

Run: `node -c script/webhook-server/lib/stripe-handlers.js` (same ESM caveat)

Alternative: `npx acorn --ecma2022 --module script/webhook-server/lib/stripe-handlers.js` if available, or just check with `node --check` on the server entry point.

**Step 5: Commit**

```bash
git add script/webhook-server/lib/email.js script/webhook-server/lib/stripe-handlers.js
git commit -m "feat(webhook): skip provisioning for onboarding checkouts, send welcome email instead"
```

---

### Task 12: Onboarding frontend — Buffer page

**Files:**
- Modify: `onboarding/index.html`

This task adds a "Thanks for subscribing — ready to set up?" landing screen before the existing wizard. The existing flow currently validates the session_id on page load and jumps straight into the wizard. We add an intermediate screen.

**Step 1: Identify the current entry point**

In `onboarding/index.html`, the script at line 803 validates the session and immediately starts the wizard. We need to insert a welcome screen between session validation (line 819) and the quiz data initialization (line 821).

**Step 2: Add buffer page HTML**

Before the existing wizard content in the `<main>` section, add a new screen (this will be the first visible section, hidden when "Start Setup" is clicked):

Find the opening `<main` tag and add a new section as its first child:

```html
      <!-- Buffer / Welcome Screen -->
      <section id="welcome-screen" class="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 class="text-3xl font-black text-white sm:text-4xl">Welcome to ClawDaddy</h1>
        <p class="mt-4 text-lg text-zinc-300">Thanks for subscribing! Let's set up your personal AI assistant.</p>
        <p class="mt-2 text-sm text-zinc-400">You'll choose a name, take a quick personality quiz, and we'll spin up a dedicated instance just for you.</p>
        <button id="start-setup-btn" class="mt-8 inline-flex min-h-[46px] items-center justify-center rounded-xl bg-lobster px-8 py-3 font-bold text-white transition hover:bg-red-500">Start Setup</button>
      </section>
```

**Step 3: Add JavaScript to handle the Start Setup click**

In the `<script>` section, after the session validation block (after line 819), add:

```js
        // ======== Buffer Page ========
        const welcomeScreen = document.getElementById('welcome-screen');
        const wizardContent = document.getElementById('wizard-content'); // wrap existing wizard in this id

        document.getElementById('start-setup-btn').addEventListener('click', () => {
          welcomeScreen.style.display = 'none';
          wizardContent.style.display = '';
        });
```

And wrap the existing wizard sections in a container div with `id="wizard-content"` and `style="display: none"` so it's hidden by default.

**Step 4: Verify the page loads in a browser**

Open `onboarding/index.html?session_id=cs_test_1234567890` in a browser. Expected: see the welcome screen with "Start Setup" button. Clicking it reveals the wizard.

**Step 5: Commit**

```bash
git add onboarding/index.html
git commit -m "feat(onboarding): add buffer welcome page before wizard to prevent accidental provisions"
```

---

## Execution Order

**Sequential (provision.sh):** Tasks 1 → 2 → 3 → 4 → 5

**Then:** Task 6 (provisioner.js, depends on provision.sh having stage markers)

**Then sequential (onboarding-server):** Task 7 → 8 → 9 → 10

**Independent (can run anytime):** Tasks 11, 12

**Parallelizable groups:**
- Group A: Tasks 1-5 (provision.sh changes)
- Group B: Task 11 (webhook server)
- Group C: Task 12 (frontend)

Groups B and C can run in parallel with Group A. Group A must complete before Tasks 6-10.

---

## Manual Steps (Not Code)

After all code tasks are complete:

1. **Stripe Dashboard:** Add `onboarding: true` to the metadata on the ClawDaddy Payment Link
2. **Environment variables on the control plane server:**
   - `ROUTE53_HOSTED_ZONE_ID` — look up via `aws route53 list-hosted-zones`
   - `DISCORD_OPS_WEBHOOK_URL` — same value as webhook server
   - `PROVISION_SCRIPT` — path to provision.sh from onboarding server's working directory
3. **Create SSH key directory:** `mkdir -p ~/.ssh/customer-keys && chmod 700 ~/.ssh/customer-keys`
4. **Restart onboarding server** to pick up new code
