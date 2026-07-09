// ── APEX AGENT: SCORE/RED-FLAG MONITORING ──
// Table-agnostic (works for both `watchlist` and `portfolio_holdings`, which share the same
// score/safety_score/signal columns) diffing logic used by api/check-market-alerts.js to turn a
// fresh re-scan into "is this worth alerting the user about" decisions. Reuses the sub-score
// breakdown (lib/subScores.js, via the fresh scan result) for the alert's "why" instead of
// inventing a separate explanation — and deliberately does NOT cite a fabricated percentile,
// consistent with how lib/subScores.js itself phrases things.
//
// Each notification decideAlerts() below produces also carries an (optional) `checklist`
// descriptor — a threshold TYPE (lib/agentChecklist.js) plus the context needed to generate an
// actionable research checklist for it. Attaching the descriptor here keeps decideAlerts() pure
// (still no I/O, no Groq call); the actual checklist generation happens in runScoreMonitor below,
// same pure-decision/I/O-runner split this file already used before the checklist upgrade.

import { createNotification, hasRecentNotification } from './notifications.js';
import { generateChecklist, checklistTypeForCategory, checklistTypeForRedFlag } from './agentChecklist.js';

const SCORE_CHANGE_THRESHOLD = 8;      // out of 100 — meaningful day-over-day move, not noise
const RED_FLAG_DEDUP_HOURS = 24 * 7;   // don't re-notify about a still-present flag every single day

function weakestSubScore(subScores) {
  if (!Array.isArray(subScores) || !subScores.length) return null;
  return subScores.reduce((worst, s) => (!worst || s.score < worst.score) ? s : worst, null);
}

// Up to 3 peer companies already fetched for this scan (lib/stockAnalysis.js's
// fetchCompetitors(), via Finnhub's stock/peers) — reused as-is for checklist context, no new
// Finnhub call.
function peerContext(fresh) {
  return Array.isArray(fresh?.competitors) ? fresh.competitors.slice(0, 3) : [];
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
      const weakest = weakestSubScore(fresh.subScores);
      const why = weakest ? `${weakest.category} is now the weakest area (${weakest.score}/10) — ${weakest.reason}` : null;
      notifications.push({
        type: 'score_change',
        title: `${row.ticker} APEX score ${direction} from ${row.score} to ${freshScore}`,
        body: why || 'Re-check the latest scan for full details on what moved.',
        checklist: {
          type: weakest ? checklistTypeForCategory(weakest.category) : 'generic_score_change',
          ctx: {
            ticker: row.ticker,
            companyName: row.company_name,
            direction: delta > 0 ? 'up' : 'down',
            scoreFrom: row.score,
            scoreTo: freshScore,
            detail: weakest?.reason || null,
            value: null,
            peers: peerContext(fresh)
          }
        }
      });
    }
  }

  const triggeredFlags = Array.isArray(fresh?.redFlags)
    ? fresh.redFlags.filter(f => f?.severity === 'high' || f?.severity === 'medium')
    : [];
  if (triggeredFlags.length) {
    // Multiple flag types can fire in the same run — the checklist is generated for the most
    // severe one (ties go to whichever was found first), since a checklist needs one specific
    // angle of investigation, not a blend of unrelated ones.
    const primary = triggeredFlags.reduce((worst, f) => (!worst || (f.severity === 'high' && worst.severity !== 'high')) ? f : worst, null);
    const checklistType = checklistTypeForRedFlag(primary?.id);
    notifications.push({
      type: 'red_flag',
      title: `${row.ticker} has ${triggeredFlags.length > 1 ? 'new red flags' : 'a new red flag'}`,
      body: triggeredFlags.map(f => f.name).join(', '),
      // Not persisted here — the dedup check itself needs I/O (a DB read), so it's applied by
      // the caller (runScoreMonitor) before this notification is actually created.
      dedupType: 'red_flag',
      checklist: checklistType ? {
        type: checklistType,
        ctx: {
          ticker: row.ticker,
          companyName: row.company_name,
          detail: primary.explanation,
          value: primary.value,
          peers: peerContext(fresh)
        }
      } : null
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

// Appends a Groq-generated research checklist to a notification's body, if one was requested and
// generation succeeds — best-effort: any failure here just leaves the plain alert body intact,
// never blocks the notification itself from going out.
async function withChecklist(n) {
  if (!n.checklist) return n.body;
  try {
    const items = await generateChecklist(n.checklist.type, n.checklist.ctx);
    if (!items?.length) return n.body;
    return `${n.body}\n\nWorth checking:\n${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}`;
  } catch (e) {
    console.error('Checklist generation failed:', e.message);
    return n.body;
  }
}

// I/O runner: loops over the rows already fetched for one table, applies decideAlerts() to
// each, creates whatever notifications it called for (respecting red-flag dedup, which needs a
// DB read decideAlerts itself can't do — and generating each notification's actionable research
// checklist, which needs a Groq call decideAlerts itself can't make), and rolls the baseline
// forward regardless of whether anything notified — so tomorrow's diff is always against today's
// numbers.
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
      const body = await withChecklist(n);
      const created = await createNotification(serviceRoleKey, {
        userId: row.user_id,
        type: n.type,
        ticker: row.ticker,
        companyName: row.company_name,
        title: n.title,
        body
      });
      if (created) notified++;
    }

    await patchBaseline(serviceRoleKey, supabaseUrl, table, row.user_id, row.ticker, baselineUpdate);
  }

  return { checked, notified };
}
