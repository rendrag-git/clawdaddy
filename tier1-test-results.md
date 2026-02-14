# Tier 1 Install Test — 2026-02-12

## Test Environment
- **Instance:** clawdaddy-test-tier1 (Lightsail micro_3_0)
- **IP:** 100.29.188.169
- **OS:** Ubuntu 24.04
- **RAM:** 1GB (914MB usable)
- **CPU:** 2 vCPU

## Result: ❌ FAILED

### Output
```
╔═══════════════════════════════════════════════╗
║            OpenClaw Installer                 ║
║            v1.0.0                              ║
╚═══════════════════════════════════════════════╝

[1/15] Running pre-flight checks...
 ✓  Running as root
 ✓  Ubuntu 24.04 detected
 ✓  Architecture: x86_64
 ✗  Insufficient RAM: 914 MB. Minimum 1 GB required.
```

### Root Cause
Script enforces minimum 1GB RAM, but micro instances report ~914MB usable (OS overhead). 

### Fix Options
1. Lower RAM check to 512MB (OpenClaw runs fine on less)
2. Use small_3_0 bundle (2GB, $12/mo) instead of micro (1GB, $7/mo)
3. Recommended: lower the check — saves customers money

### Next Steps
- Redesign install script as guided wizard (chat platform selection, bot setup walkthrough, API key validation, test message)
- Fix RAM threshold
- Retest on micro instance
