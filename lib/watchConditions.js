// ── APEX AGENT: USER-DEFINED WATCH CONDITIONS ──
// Lets a user delegate a specific, bounded watch task to the Agent ("alert me if AAPL's P/E
// crosses 35") instead of only reacting to what APEX itself decides is worth flagging (score
// moves, red flags, concentration). The condition itself — metric, operator, threshold — is
// entirely user-defined and stored as-is; this module only ever reports whether it was met, never
// suggests one or interprets it as advice. Same regulatory posture as the rest of the Agent
// (lib/concentrationMonitor.js, lib/scoreMonitor.js): strictly descriptive, never prescriptive.
//
// Reuses the exact same fresh-scan data (freshByTicker) api/check-market-alerts.js already builds
// for score/red-flag monitoring — no new Finnhub/Groq call, just reading different fields off a
// result that's already being fetched for that ticker this run.

import { createNotification } from './notifications.js';

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';

// Each metric maps to a field already computed by lib/stockAnalysis.js for every public-stock
// scan — no new calculation, just reading it back off the fresh result. `format` controls display
// precision only; the raw numeric value (not the formatted string) is what actually gets compared
// against the threshold. Kept in sync with the `metric` CHECK constraint in the watch_conditions
// migration (supabase/migrations/0001_watch_conditions.sql) and the WATCH_CONDITION_METRICS
// mirror in index.html (the static frontend can't import this module directly).
export const WATCH_CONDITION_METRICS = {
  score: {
    label: 'APEX score', unit: '/100',
    extract: (fresh) => typeof fresh?.score === 'number' ? fresh.score : null,
    format: (v) => String(Math.round(v))
  },
  pe_ratio: {
    label: 'P/E ratio', unit: '',
    extract: (fresh) => typeof fresh?.rawMetrics?.peRaw === 'number' ? fresh.rawMetrics.peRaw : null,
    format: (v) => v.toFixed(1)
  },
  debt_equity: {
    label: 'Debt/Equity ratio', unit: '',
    extract: (fresh) => typeof fresh?.rawMetrics?.debtEquityRaw === 'number' ? fresh.rawMetrics.debtEquityRaw : null,
    format: (v) => v.toFixed(2)
  },
  current_ratio: {
    label: 'Current ratio', unit: '',
    extract: (fresh) => typeof fresh?.rawMetrics?.currentRatioRaw === 'number' ? fresh.rawMetrics.currentRatioRaw : null,
    format: (v) => v.toFixed(2)
  },
  roe: {
    label: 'ROE', unit: '%',
    extract: (fresh) => typeof fresh?.rawMetrics?.roeRaw === 'number' ? fresh.rawMetrics.roeRaw : null,
    format: (v) => v.toFixed(1)
  },
  profit_margin: {
    label: 'Profit margin', unit: '%',
    extract: (fresh) => typeof fresh?.rawMetrics?.profitMarginRaw === 'number' ? fresh.rawMetrics.profitMarginRaw : null,
    format: (v) => v.toFixed(1)
  },
  safety_score: {
    label: 'Stock safety score', unit: '/100',
    extract: (fresh) => typeof fresh?.stockAnalysis?.safetyScore === 'number' ? fresh.stockAnalysis.safetyScore : null,
    format: (v) => String(Math.round(v))
  }
};

// Pure — no I/O. `value` is the metric's raw extracted number, `threshold` is the user's own
// stored number; both already validated numeric by the time this is called.
export function evaluateWatchCondition(operator, value, threshold) {
  if (operator === 'above') return value > threshold;
  if (operator === 'below') return value < threshold;
  return false;
}

// Pure — no I/O. Builds the (strictly descriptive, never prescriptive) notification text for a
// condition that just triggered. Returns null for an unrecognized metric key (defensive — the
// CHECK constraint should make this unreachable, but this module shouldn't assume the DB row is
// well-formed).
export function buildWatchConditionAlert(condition, value) {
  const def = WATCH_CONDITION_METRICS[condition.metric];
  if (!def) return null;

  const verb = condition.operator === 'above' ? 'rose above' : 'fell below';
  const thresholdDisplay = `${condition.threshold}${def.unit}`;
  const valueDisplay = `${def.format(value)}${def.unit}`;

  return {
    type: 'watch_condition',
    title: `${def.label} for ${condition.ticker} ${verb} your threshold of ${thresholdDisplay}`,
    body: `${condition.company_name || condition.ticker} is now at ${valueDisplay}. This is a condition you set — not a recommendation from APEX.`
  };
}

async function patchWatchCondition(serviceRoleKey, id, updates) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/watch_conditions?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(updates)
    });
  } catch {
    // Non-fatal: a failed status update just means this condition gets re-checked next run
  }
}

// I/O runner: given ALL active watch_conditions rows (already fetched once by the cron handler)
// and the shared freshByTicker map (already fetched there for score monitoring — reused here, no
// new Finnhub/Groq call), evaluates each condition against its ticker's fresh data. A triggered
// condition is flipped to active=false (same "flip a status flag so it can't match the active-only
// query next run" dedup principle api/check-market-alerts.js's price_alerts already uses) — so a
// condition fires its notification exactly once, not once per day it remains true. Editing a
// triggered condition (index.html) resets active=true / triggered_at=null to re-arm it.
export async function runWatchConditionMonitor(serviceRoleKey, conditions, freshByTicker) {
  let checked = 0, triggeredCount = 0, notifiedCount = 0;

  for (const condition of conditions) {
    const def = WATCH_CONDITION_METRICS[condition.metric];
    if (!def) continue;

    const fresh = freshByTicker[condition.ticker];
    if (!fresh) continue; // couldn't get fresh data for this ticker this run — re-checked next run

    const value = def.extract(fresh);
    if (value == null) continue;
    checked++;

    if (!evaluateWatchCondition(condition.operator, value, condition.threshold)) continue;

    triggeredCount++;
    await patchWatchCondition(serviceRoleKey, condition.id, {
      active: false,
      triggered_at: new Date().toISOString(),
      triggered_value: value
    });

    const alert = buildWatchConditionAlert(condition, value);
    if (!alert) continue;
    const created = await createNotification(serviceRoleKey, {
      userId: condition.user_id,
      type: alert.type,
      ticker: condition.ticker,
      companyName: condition.company_name,
      title: alert.title,
      body: alert.body
    });
    if (created) notifiedCount++;
  }

  return { checked, triggered: triggeredCount, notified: notifiedCount };
}
