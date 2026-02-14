import 'dotenv/config';
import express from 'express';
import { init_db, log_usage, get_monthly_spend, get_stats } from './lib/usage-db.js';
import {
  get_current_billing_cycle,
  check_budget,
  enforce_budget,
  is_downgraded,
  get_budget_limit,
  get_budget_state,
} from './lib/budget.js';
import { send_daily_report, start_daily_reporter } from './lib/reporter.js';

const PORT = parseInt(process.env.PROXY_PORT || '3141', 10);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_BASE = 'https://api.anthropic.com';

if (!ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY is required');
  process.exit(1);
}

// Cost rates per 1M tokens
const COST_RATES = {
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
};
const DEFAULT_RATE = { input: 3, output: 15 };

function estimate_cost(model, input_tokens, output_tokens) {
  const rate = COST_RATES[model] || DEFAULT_RATE;
  return (input_tokens * rate.input + output_tokens * rate.output) / 1_000_000;
}

// Downgrade model if budget exceeded
const DOWNGRADE_MODEL = 'claude-sonnet-4-5-20250929';

function maybe_downgrade_model(body) {
  if (!is_downgraded()) return body;

  const model = body.model || '';
  if (model.includes('opus')) {
    console.log(`[proxy] Downgrading model from ${model} to ${DOWNGRADE_MODEL}`);
    return { ...body, model: DOWNGRADE_MODEL };
  }
  return body;
}

// Build headers for forwarding to Anthropic
function build_upstream_headers(incomingHeaders) {
  const headers = {};
  // Forward relevant headers
  const forward = [
    'content-type',
    'anthropic-version',
    'anthropic-beta',
    'accept',
  ];
  for (const key of forward) {
    if (incomingHeaders[key]) {
      headers[key] = incomingHeaders[key];
    }
  }
  // Always use our real API key
  headers['x-api-key'] = ANTHROPIC_API_KEY;
  return headers;
}

// Parse SSE stream to extract usage from message_stop event
function parse_sse_usage(chunks) {
  let usage = null;
  let model = null;
  // Parse each SSE event
  const text = chunks.join('');
  const events = text.split('\n\n');
  for (const event of events) {
    const dataLine = event.split('\n').find(l => l.startsWith('data: '));
    if (!dataLine) continue;
    try {
      const data = JSON.parse(dataLine.slice(6));
      if (data.type === 'message_start' && data.message) {
        model = data.message.model;
        if (data.message.usage) {
          usage = { input_tokens: data.message.usage.input_tokens, output_tokens: 0 };
        }
      }
      if (data.type === 'message_delta' && data.usage) {
        if (usage) {
          usage.output_tokens = data.usage.output_tokens || 0;
        } else {
          usage = { input_tokens: 0, output_tokens: data.usage.output_tokens || 0 };
        }
      }
    } catch {
      // Not JSON, skip
    }
  }
  return { usage, model };
}

// Initialize DB
init_db();

const app = express();

// Parse raw body for proxying
app.use('/v1/messages', express.raw({ type: '*/*', limit: '10mb' }));

// Health endpoint
app.get('/health', (req, res) => {
  const cycle = get_current_billing_cycle();
  const monthly_spend = get_monthly_spend(cycle);
  const budget_limit = get_budget_limit();
  const budget_pct = ((monthly_spend / budget_limit) * 100).toFixed(1);
  res.json({ status: 'ok', monthly_spend, budget_limit, budget_pct: parseFloat(budget_pct) });
});

// Stats endpoint
app.get('/stats', (req, res) => {
  const cycle = get_current_billing_cycle();
  const stats = get_stats(cycle);
  const budget_limit = get_budget_limit();
  const budget_pct = ((stats.monthly_spend / budget_limit) * 100).toFixed(1);
  const billing_cycle_start = parseInt(process.env.BILLING_CYCLE_START || '1', 10);
  res.json({
    ...stats,
    budget_limit,
    budget_pct: parseFloat(budget_pct),
    billing_cycle: cycle,
    billing_cycle_start,
  });
});

// Report endpoint - trigger immediate daily report
app.post('/report', async (req, res) => {
  try {
    const payload = await send_daily_report();
    res.json({ status: 'sent', payload });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Main proxy: POST /v1/messages
app.post('/v1/messages', async (req, res) => {
  const budgetState = get_budget_state();
  if (budgetState.last_action === 'pause') {
    return res.status(503).json({ error: 'Service paused due to budget limit exceeded' });
  }

  let body;
  try {
    body = JSON.parse(req.body.toString());
  } catch (err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  // Maybe downgrade model
  body = maybe_downgrade_model(body);
  const requestModel = body.model || 'unknown';
  const isStreaming = body.stream === true;

  const upstreamHeaders = build_upstream_headers(req.headers);

  try {
    const upstreamRes = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify(body),
    });

    if (isStreaming) {
      // Stream response back to client
      res.writeHead(upstreamRes.status, {
        'content-type': upstreamRes.headers.get('content-type') || 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      });

      const chunks = [];
      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          chunks.push(chunk);
          res.write(value);
        }
      } catch (streamErr) {
        console.error('[proxy] Stream error:', streamErr.message);
      } finally {
        res.end();
      }

      // Parse usage from accumulated SSE events
      const { usage, model: streamModel } = parse_sse_usage(chunks);
      const finalModel = streamModel || requestModel;
      if (usage) {
        const cost = estimate_cost(finalModel, usage.input_tokens, usage.output_tokens);
        const cycle = get_current_billing_cycle();
        log_usage(finalModel, usage.input_tokens, usage.output_tokens, cost, cycle);

        // Check and enforce budget
        const spend = get_monthly_spend(cycle);
        const action = check_budget(spend);
        if (action !== 'normal') {
          enforce_budget(action, spend).catch(err =>
            console.error('[proxy] Budget enforcement error:', err.message)
          );
        }
      }
    } else {
      // Non-streaming response
      const responseBody = await upstreamRes.text();

      // Forward status and relevant headers
      res.status(upstreamRes.status);
      const ct = upstreamRes.headers.get('content-type');
      if (ct) res.setHeader('content-type', ct);
      res.send(responseBody);

      // Extract usage from response JSON
      try {
        const data = JSON.parse(responseBody);
        if (data.usage) {
          const finalModel = data.model || requestModel;
          const cost = estimate_cost(finalModel, data.usage.input_tokens, data.usage.output_tokens);
          const cycle = get_current_billing_cycle();
          log_usage(finalModel, data.usage.input_tokens, data.usage.output_tokens, cost, cycle);

          // Check and enforce budget
          const spend = get_monthly_spend(cycle);
          const action = check_budget(spend);
          if (action !== 'normal') {
            enforce_budget(action, spend).catch(err =>
              console.error('[proxy] Budget enforcement error:', err.message)
            );
          }
        }
      } catch {
        // Non-JSON response or no usage field, skip logging
      }
    }
  } catch (err) {
    console.error('[proxy] Upstream request failed:', err.message);
    res.status(502).json({ error: 'Failed to reach Anthropic API', detail: err.message });
  }
});

// Transparent proxy for all other Anthropic API paths
app.all('/v1/*', async (req, res) => {
  const url = `${ANTHROPIC_BASE}${req.path}`;
  const headers = build_upstream_headers(req.headers);

  try {
    let fetchOpts = {
      method: req.method,
      headers,
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Collect body
      const bodyChunks = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk);
      }
      if (bodyChunks.length > 0) {
        fetchOpts.body = Buffer.concat(bodyChunks);
      }
    }

    const upstreamRes = await fetch(url, fetchOpts);
    res.status(upstreamRes.status);
    const ct = upstreamRes.headers.get('content-type');
    if (ct) res.setHeader('content-type', ct);
    const body = await upstreamRes.arrayBuffer();
    res.send(Buffer.from(body));
  } catch (err) {
    console.error('[proxy] Passthrough error:', err.message);
    res.status(502).json({ error: 'Failed to reach Anthropic API', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[proxy] OpenClaw API proxy listening on port ${PORT}`);
  console.log(`[proxy] Billing cycle: ${get_current_billing_cycle()}, Budget: $${get_budget_limit()}`);
  start_daily_reporter();
});
