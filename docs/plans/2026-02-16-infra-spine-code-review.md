# Infra Spine Code Review

**Branch:** `feat/infra-spine`
**Date:** 2026-02-16
**Reviewer:** Claude Code (automated)
**Status:** Review complete — critical fixes needed before merge

---

## Critical Issues (Must Fix Before Merge)

### 1. Command Injection Risk in SCP/SSH Calls

**File:** `api/onboarding-server.js` (write-files endpoint)

`record.serverIp` and `record.sshKeyPath` are interpolated into SCP/SSH commands without validation. While `execFileAsync` prevents shell injection (no shell spawned), malformed values could still cause unexpected behavior.

**Fix:** Validate before use:
```js
const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
if (!record.serverIp || !ipPattern.test(record.serverIp)) {
  return res.status(400).json({ ok: false, error: 'Invalid server IP' });
}
const keyPathPattern = /^\/[\w\-/.]+$/;
if (!record.sshKeyPath || !keyPathPattern.test(record.sshKeyPath)) {
  return res.status(400).json({ ok: false, error: 'Invalid SSH key path' });
}
```

### 2. Missing `$10` Parameter in `generate_user_data()`

**File:** `script/provision.sh` (~line 313)

Function jumps from `$9` (tier) to `$11` (ssh_pub_key) without declaring `$10`. The managed tier proxy config references `${10:-unknown}` on line 509 for `customer_id_val`, which will get `"unknown"` instead of the actual customer ID.

**Fix:** Add after `local tier="${9:-byok}"`:
```bash
    local customer_id_val="${10:-}"
    local ssh_pub_key="${11:-}"
```

### 3. saveStore Race Condition

**File:** `api/onboarding-server.js` (fire-and-forget provisioning block)

Multiple unserialized `saveStore(store)` calls in stage callback, `.then()`, and `.catch()`. Concurrent writes can corrupt the JSON file or lose updates.

**Acknowledged as tech debt in code comments.** Low volume makes this acceptable for launch, but needs a write queue before scaling.

### 4. SSH Key Reuse on Reprovision

**File:** `script/provision.sh` (~line 815)

When a username already has an SSH key, it's reused with only a warning. If a customer is reprovisioned, both old and new instances share the same key with no audit trail.

**Fix:** Back up old key and generate fresh:
```bash
if [[ -f "${ssh_key_path}" ]]; then
    local backup="${ssh_key_path}.$(date +%s).bak"
    warn "SSH key already exists, backing up to ${backup}"
    mv "${ssh_key_path}" "${backup}"
    mv "${ssh_key_path}.pub" "${backup}.pub"
fi
```

---

## Important Issues (Should Fix Before Production)

### 5. StrictHostKeyChecking=no

**File:** `api/onboarding-server.js` (SCP/SSH calls)

Disables host key verification, enabling MITM attacks. Use `StrictHostKeyChecking=accept-new` with a dedicated `UserKnownHostsFile` instead — accepts on first connection, verifies on subsequent.

### 6. Missing Error Handling in provisioner.js Log Writes

**File:** `api/lib/provisioner.js:12-16`

`logAppend()` creates a write stream but doesn't handle errors. If disk is full or directory missing, logs silently fail.

**Fix:** Add `stream.on('error', ...)` handler.

### 7. Temp Userdata File Permissions

**File:** `script/provision.sh` (mktemp for userdata)

The temp file containing secrets (VNC password, API keys) is created with default permissions. Add `chmod 600` immediately after `mktemp`.

### 8. DNS TTL Too Low

**File:** `script/provision.sh` (~line 974)

TTL of 300 seconds means 12x more Route 53 queries vs 1-hour TTL. Static IPs don't change. Consider `3600` or make configurable via `DNS_TTL` env var.

### 9. No Validation of Provision Results

**File:** `api/onboarding-server.js` (`.then(result => ...)` block)

Values from provision.sh output are stored directly without validation. Add regex checks for `serverIp`, `sshKeyPath`, `customerId` before storing.

### 10. Hardcoded Remote Path

**File:** `api/onboarding-server.js:528`

`/home/ubuntu/clawd` is hardcoded. Make configurable via `CLAWD_REMOTE_DIR` env var.

---

## Suggestions (Nice-to-Have)

### 11. Rate Limiting on Provisioning Endpoint

Per-session-ID rate limiting to prevent provision spam and AWS cost abuse.

### 12. Log Full Provision Command

Log the complete `args` array in provisioner.js for easier debugging/reproduction.

### 13. Provision Process Timeout

Add a 15-minute timeout to `spawnProvision` to prevent hung processes.

### 14. Frontend Username Validation

Add `pattern` and `minlength`/`maxlength` attributes to the username input for real-time client-side validation.

### 15. DNS Propagation Verification

After Route 53 UPSERT, run `dig` to verify the record is queryable before marking `dns_created=true`.

---

## Positive Observations

- **`execFileAsync` vs `exec`**: Correct choice — array args prevent shell injection
- **Non-fatal DNS**: Instances still provision even if Route 53 is down
- **Idempotent DNS**: UPSERT instead of CREATE — safe to re-run
- **Two-layer double-provision prevention**: Metadata gate + buffer page
- **Timestamped log files**: Each provision gets its own log for debugging
- **Stage marker parsing**: Real-time progress via stdout, matching design spec exactly

---

## Design Doc Compliance

All requirements from `docs/plans/2026-02-15-infra-spine-design.md` are implemented:

| Requirement | Status |
|-------------|--------|
| --username flag | Present |
| SSH keygen before instance creation | Present |
| Stage markers (6 stages) | All present, correct order |
| DNS UPSERT via Route 53 | Present, non-fatal |
| Username in customers.json | Present |
| api/lib/provisioner.js | Present, matches spec |
| Fire-and-forget provisioning | Present |
| Remove fake timers | Done |
| buildWebchatUrl with DNS fallback | Present |
| SCP file push | Present |
| Webhook metadata gate | Present |
| Welcome email | Present, URL format matches |
| Buffer page | Present, validation-first |

---

## Action Items

**Before merge (blocking):**
- [ ] Fix #2: Add missing `$10` parameter declaration in `generate_user_data()`
- [ ] Fix #1: Add IP/key path validation in write-files endpoint
- [ ] Fix #4: Back up old SSH keys on reprovision instead of silent reuse

**Before production (non-blocking):**
- [ ] Fix #5: Switch to `StrictHostKeyChecking=accept-new`
- [ ] Fix #6: Add error handler to `logAppend()`
- [ ] Fix #7: `chmod 600` on userdata temp file
- [ ] Fix #8: Increase DNS TTL or make configurable
- [ ] Fix #9: Validate provision result fields
