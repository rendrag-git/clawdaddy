import { get_daily_summary, get_daily_total } from './usage-db.js';

const REPORT_WEBHOOK_URL = process.env.REPORT_WEBHOOK_URL || '';
const CUSTOMER_ID = process.env.CUSTOMER_ID || 'unknown';

function get_yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

export async function send_daily_report(date) {
  const reportDate = date || get_yesterday();

  const modelRows = get_daily_summary(reportDate);
  const totals = get_daily_total(reportDate);

  const models = {};
  for (const row of modelRows) {
    models[row.model] = { cost: row.cost, requests: row.requests };
  }

  const payload = {
    customer_id: CUSTOMER_ID,
    date: reportDate,
    spend: totals.spend,
    requests: totals.requests,
    models,
  };

  if (!REPORT_WEBHOOK_URL) {
    console.warn('[reporter] No REPORT_WEBHOOK_URL set, logging report locally');
    console.log('[reporter] Daily report:', JSON.stringify(payload));
    return payload;
  }

  try {
    const res = await fetch(REPORT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[reporter] Webhook returned ${res.status}: ${await res.text()}`);
    } else {
      console.log(`[reporter] Daily report sent for ${reportDate}`);
    }
  } catch (err) {
    console.error('[reporter] Failed to send report:', err.message);
  }

  return payload;
}

let reportInterval = null;

export function start_daily_reporter() {
  // Send report once at startup for yesterday, then every 24h
  send_daily_report().catch(err => console.error('[reporter] Initial report error:', err.message));

  reportInterval = setInterval(() => {
    send_daily_report().catch(err => console.error('[reporter] Scheduled report error:', err.message));
  }, 24 * 60 * 60 * 1000);

  console.log('[reporter] Daily reporter started (24h interval)');
  return reportInterval;
}

export function stop_daily_reporter() {
  if (reportInterval) {
    clearInterval(reportInterval);
    reportInterval = null;
  }
}
