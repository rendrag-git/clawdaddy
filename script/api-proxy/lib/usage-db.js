import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DB_PATH = process.env.DB_PATH || '/var/lib/openclaw-proxy/usage.db';

let db;

export function init_db() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cost_estimate REAL NOT NULL,
      billing_cycle TEXT NOT NULL
    );
  `);
  return db;
}

export function log_usage(model, input_tokens, output_tokens, cost_estimate, billing_cycle) {
  const stmt = db.prepare(
    'INSERT INTO usage (model, input_tokens, output_tokens, cost_estimate, billing_cycle) VALUES (?, ?, ?, ?, ?)'
  );
  return stmt.run(model, input_tokens, output_tokens, cost_estimate, billing_cycle);
}

export function get_monthly_spend(billing_cycle) {
  const row = db.prepare(
    'SELECT COALESCE(SUM(cost_estimate), 0) AS total FROM usage WHERE billing_cycle = ?'
  ).get(billing_cycle);
  return row.total;
}

export function get_daily_breakdown(billing_cycle) {
  return db.prepare(
    `SELECT DATE(timestamp) AS date,
            SUM(cost_estimate) AS spend,
            COUNT(*) AS requests,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens
     FROM usage WHERE billing_cycle = ?
     GROUP BY DATE(timestamp)
     ORDER BY date`
  ).all(billing_cycle);
}

export function get_model_breakdown(billing_cycle) {
  return db.prepare(
    `SELECT model,
            SUM(cost_estimate) AS cost,
            COUNT(*) AS requests,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens
     FROM usage WHERE billing_cycle = ?
     GROUP BY model`
  ).all(billing_cycle);
}

export function get_daily_summary(date) {
  return db.prepare(
    `SELECT model,
            SUM(cost_estimate) AS cost,
            COUNT(*) AS requests
     FROM usage WHERE DATE(timestamp) = ?
     GROUP BY model`
  ).all(date);
}

export function get_daily_total(date) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(cost_estimate), 0) AS spend,
            COUNT(*) AS requests
     FROM usage WHERE DATE(timestamp) = ?`
  ).get(date);
  return row;
}

export function get_stats(billing_cycle) {
  const monthly_spend = get_monthly_spend(billing_cycle);
  const daily_breakdown = get_daily_breakdown(billing_cycle);
  const model_breakdown = get_model_breakdown(billing_cycle);
  return { monthly_spend, daily_breakdown, model_breakdown };
}
