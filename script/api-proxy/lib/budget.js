import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { execSync } from 'node:child_process';

const BUDGET_LIMIT = parseFloat(process.env.BUDGET_LIMIT || '40.00');
const BILLING_CYCLE_START = parseInt(process.env.BILLING_CYCLE_START || '1', 10);
const DISCORD_OPS_WEBHOOK_URL = process.env.DISCORD_OPS_WEBHOOK_URL || '';
const REPORT_WEBHOOK_URL = process.env.REPORT_WEBHOOK_URL || '';
const MANAGE_SCRIPT = process.env.MANAGE_SCRIPT || '/opt/openclaw/manage.sh';
const CUSTOMER_ID = process.env.CUSTOMER_ID || 'unknown';
const STATE_PATH = process.env.BUDGET_STATE_PATH || '/var/lib/openclaw-proxy/budget-state.json';

const DEFAULT_STATE = {
  last_action: 'normal',
  downgraded: false,
  throttled: false,
  warned_80: false,
  billing_cycle: null,
};

function load_state() {
  try {
    const data = readFileSync(STATE_PATH, 'utf8');
    return JSON.parse(data);
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function save_state(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function get_budget_limit() {
  return BUDGET_LIMIT;
}

export function get_current_billing_cycle() {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1; // 1-based

  // If current day is before billing cycle start, the cycle started last month
  if (now.getDate() < BILLING_CYCLE_START) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }

  return `${year}-${String(month).padStart(2, '0')}`;
}

export function check_budget(current_spend) {
  const pct = (current_spend / BUDGET_LIMIT) * 100;

  if (pct >= 150) return 'pause';
  if (pct >= 120) return 'throttle';
  if (pct >= 100) return 'downgrade';
  if (pct >= 80) return 'warn';
  return 'normal';
}

export function get_budget_state() {
  const state = load_state();
  const cycle = get_current_billing_cycle();
  // Reset state if billing cycle changed
  if (state.billing_cycle !== cycle) {
    const fresh = { ...DEFAULT_STATE, billing_cycle: cycle };
    save_state(fresh);
    return fresh;
  }
  return state;
}

export function is_downgraded() {
  return get_budget_state().downgraded;
}

async function post_discord(message) {
  if (!DISCORD_OPS_WEBHOOK_URL) {
    console.warn('[budget] No DISCORD_OPS_WEBHOOK_URL set, skipping alert');
    return;
  }
  try {
    await fetch(DISCORD_OPS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
  } catch (err) {
    console.error('[budget] Discord alert failed:', err.message);
  }
}

export async function enforce_budget(action, current_spend) {
  const state = get_budget_state();
  const pct = ((current_spend / BUDGET_LIMIT) * 100).toFixed(1);

  if (action === 'normal') {
    // If we were in a non-normal state but spend dropped (e.g. new cycle), reset
    if (state.last_action !== 'normal') {
      save_state({ ...DEFAULT_STATE, billing_cycle: state.billing_cycle });
    }
    return;
  }

  if (action === 'warn' && !state.warned_80) {
    await post_discord(
      `[OpenClaw] Budget warning for \`${CUSTOMER_ID}\`: spend is at ${pct}% ($${current_spend.toFixed(2)} / $${BUDGET_LIMIT})`
    );
    save_state({ ...state, warned_80: true, last_action: 'warn' });
    return;
  }

  if (action === 'downgrade' && !state.downgraded) {
    await post_discord(
      `[OpenClaw] Budget limit reached for \`${CUSTOMER_ID}\` (${pct}%). Downgrading Opus -> Sonnet.`
    );
    save_state({ ...state, downgraded: true, last_action: 'downgrade' });
    return;
  }

  if (action === 'throttle' && !state.throttled) {
    await post_discord(
      `[OpenClaw] Budget EXCEEDED for \`${CUSTOMER_ID}\` (${pct}%). Throttling instance.`
    );
    // Write throttle flag file
    try {
      writeFileSync('/var/lib/openclaw-proxy/THROTTLED', new Date().toISOString());
    } catch (err) {
      console.error('[budget] Failed to write throttle flag:', err.message);
    }
    save_state({ ...state, throttled: true, last_action: 'throttle' });
    return;
  }

  if (action === 'pause') {
    await post_discord(
      `[OpenClaw] CRITICAL: Budget at ${pct}% for \`${CUSTOMER_ID}\`. Pausing instance.`
    );
    // Notify EC2 to send email
    if (REPORT_WEBHOOK_URL) {
      try {
        await fetch(REPORT_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'pause',
            customer_id: CUSTOMER_ID,
            spend: current_spend,
            budget_limit: BUDGET_LIMIT,
            pct: parseFloat(pct),
          }),
        });
      } catch (err) {
        console.error('[budget] Pause webhook failed:', err.message);
      }
    }
    // Stop instance via manage.sh
    try {
      execSync(`${MANAGE_SCRIPT} stop ${CUSTOMER_ID}`, { timeout: 30000 });
    } catch (err) {
      console.error('[budget] manage.sh stop failed:', err.message);
    }
    save_state({ ...state, last_action: 'pause' });
  }
}
