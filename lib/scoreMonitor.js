// ── APEX AGENT: SCORE/RED-FLAG MONITORING ──
// Table-agnostic (works for both `watchlist` and `portfolio_holdings`, which share the same
// score/safety_score/signal columns) diffing logic used by api/check-market-alerts.js to turn a
// fresh re-scan into "is this worth alerting the user about" decisions. Reuses the sub-score
// breakdown (lib/subScores.js, via the fresh scan result) for the alert's "why" instead of
// inventing a separate explanation — and deliberately does NOT cite a fabricated percentile,
// consistent with how lib/subScores.js itself phrases things.

import { createNotification, hasRecentNotification } from './notifications.js';

const SCORE_CHANGE_THRESHOLD = 8;      // out of 100 — meaningful day-over-day move, not noise
const RED_FLAG_DEDUP_HOURS = 24 * 7;   // don't re-notify about a still-present flag every single day

function weakestSubScoreReason(subScores) {
  if (!Array.isArray(subScores) || !subScores.length) return null;
  const weakest = subScores.reduce((worst, s) => (!worst || s.score < worst.score) ? s : worst, null);
  if (!weakest) return null;
  return `${weakest.category} is now the weakest area (${weakest.score}/10) — ${weakest.reason}`;
}

// Pure — no I/O, no randomness, safe to unit test directly. Given a stored baseline row
// ({ score, safety_score, signal }) and a fresh scan result for the same ticker, decides what
// (if anything) is worth alerting on, and what the new baseline should be recorded as.
export function decideAlerts(row, fresh) {
  const notifications = [];
  const freshScore = typeof fresh?.score === 'number' ? fresh.score : null;

  if (row.score != null && freshScore != null) {
    const delta = freshScore - row.score;
    if (Math.abs(delta) >= SCORE_CHANGE_THRESHOLD) {
      const direction = delta > 0 ? 'rose' : 'dropped';
      const why = weakestSubScoreReason(fresh.subScores);
      notifications.push({
        type: 'score_change',
        title: `${row.ticker} APEX score ${direction} from ${row.score} to ${freshScore}`,
        body: why || 'Re-check the latest scan for full details on what moved.'
      });
    }
  }

  const triggeredFlags = Array.isArray(fresh?.redFlags)
    ? fresh.redFlags.filter(f => f?.severity === 'high' || f?.severity === 'medium')
    : [];
  if (triggeredFlags.length) {
    notifications.push({
      type: 'red_flag',
      title: `${row.ticker} has ${triggeredFlags.length > 1 ? 'new red flags' : 'a new red flag'}`,
      body: triggeredFlags.map(f => f.name).join(', '),
      // Not persisted here — the dedup check itself needs I/O (a DB read), so it's applied by
      // the caller (runScoreMonitor) before this notification is actually created.
      dedupType: 'red_flag'
    });
  }

  return {
    notifications,
    baselineUpdate: {
      score: freshScore ?? row.score,
      safety_score: fresh?.stockAnalysis?.safetyScore ?? row.safety_score,
      signal: fresh?.stockAnalysis?.signal ?? row.signal
    }
  };
}

async function patchBaseline(serviceRoleKey, supabaseUrl, table, userId, ticker, updates) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/${table}?user_id=eq.${userId}&ticker=eq.${encodeURIComponent(ticker)}`, {
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
    // Non-fatal: this row's baseline just stays stale and gets re-diffed against it next run
  }
}

// I/O runner: loops over the rows already fetched for one table, applies decideAlerts() to
// each, creates whatever notifications it called for (respecting red-flag dedup, which needs a
// DB read decideAlerts itself can't do), and rolls the baseline forward regardless of whether
// anything notified — so tomorrow's diff is always against today's numbers.
export async function runScoreMonitor(serviceRoleKey, supabaseUrl, table, rows, freshByTicker) {
  let checked = 0, notified = 0;

  for (const row of rows) {
    const fresh = freshByTicker[row.ticker];
    if (!fresh) continue;
    checked++;

    const { notifications, baselineUpdate } = decideAlerts(row, fresh);

    for (const n of notifications) {
      if (n.dedupType) {
        const alreadyNotified = await hasRecentNotification(serviceRoleKey, row.user_id, row.ticker, n.dedupType, RED_FLAG_DEDUP_HOURS);
        if (alreadyNotified) continue;
      }
      const created = await createNotification(serviceRoleKey, {
        userId: row.user_id,
        type: n.type,
        ticker: row.ticker,
        companyName: row.company_name,
        title: n.title,
        body: n.body
      });
      if (created) notified++;
    }

    await patchBaseline(serviceRoleKey, supabaseUrl, table, row.user_id, row.ticker, baselineUpdate);
  }

  return { checked, notified };
}
