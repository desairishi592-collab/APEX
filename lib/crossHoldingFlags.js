// ── APEX AGENT: CROSS-HOLDING RED-FLAG PATTERN DETECTION ──
// A grouping step over red flags already computed this run (lib/redFlags.js, via freshByTicker)
// — no new detection logic, no new data fetches. When 2+ of a user's watchlist/portfolio holdings
// trigger the SAME flag id in the same cron run, that's a pattern worth surfacing as one
// consolidated notification ("possible shared sector/macro exposure") instead of N separate,
// disconnected pings for what's really one underlying signal. Strictly informational, same bar as
// every other APEX Agent notification — never a personalized recommendation.

import { createNotification, hasRecentNotification } from './notifications.js';

const CROSS_HOLDING_DEDUP_HOURS = 24 * 7; // don't re-notify about a still-shared flag every day
const PORTFOLIO_SENTINEL_TICKER = 'PORTFOLIO'; // not a real ticker — this alert spans holdings

function triggeredFlagsFor(fresh) {
  return Array.isArray(fresh?.redFlags)
    ? fresh.redFlags.filter(f => f?.severity === 'high' || f?.severity === 'medium')
    : [];
}

// Pure — no I/O, no randomness, safe to unit test directly. Given ALL of a run's watchlist +
// portfolio rows (across every user) and the shared freshByTicker map, groups already-triggered
// flags by (user, flag id) and returns one pattern per flag id shared by 2+ DISTINCT tickers for
// the SAME user this run. Generic over flag id — works for any of lib/redFlags.js's flag types,
// not just the two the task calls out as examples. A ticker held in both watchlist and portfolio
// counts once (Set dedup), so it can never masquerade as "2 holdings" on its own.
export function findCrossHoldingPatterns(rows, freshByTicker) {
  const byKey = new Map();

  for (const row of rows) {
    const fresh = freshByTicker[row.ticker];
    for (const flag of triggeredFlagsFor(fresh)) {
      const key = `${row.user_id}::${flag.id}`;
      if (!byKey.has(key)) {
        byKey.set(key, { userId: row.user_id, flagId: flag.id, flagName: flag.name, action: flag.action, tickers: new Set() });
      }
      byKey.get(key).tickers.add(row.ticker);
    }
  }

  const patterns = [];
  for (const entry of byKey.values()) {
    if (entry.tickers.size >= 2) {
      patterns.push({ ...entry, tickers: [...entry.tickers].sort() });
    }
  }
  return patterns;
}

function formatTickerList(tickers) {
  if (tickers.length === 2) return `${tickers[0]} and ${tickers[1]}`;
  return `${tickers.slice(0, -1).join(', ')}, and ${tickers[tickers.length - 1]}`;
}

// Pure — builds the single consolidated notification for one cross-holding pattern. Deliberately
// generic (no per-flag-id hardcoding): the same template works for any flag id by plugging in its
// own name/action text. Language stays strictly informational — names the shared signal and
// affected tickers, frames it as a coincidence "worth a closer look," never an instruction to act.
export function buildConsolidatedAlert(pattern) {
  const { flagName, tickers, action } = pattern;
  const list = formatTickerList(tickers);
  const verb = tickers.length === 2 ? 'both' : 'all';
  return {
    type: 'red_flag_pattern',
    title: `${tickers.length} holdings share the same flag: ${flagName}`,
    body: `${list} ${verb} show "${flagName}" this week — possible shared sector/macro exposure worth a closer look.${action ? ` ${action}` : ''}`
  };
}

// I/O runner: finds cross-holding patterns across a user's full combined watchlist + portfolio
// rows for this run, creates one consolidated notification per pattern (deduped per user+flag id
// via a composite sentinel ticker — a single real ticker can't represent "this affects N
// holdings"), and returns which (ticker -> flag ids) were consolidated so the caller can suppress
// the matching individual per-ticker red_flag notifications elsewhere in this same run.
export async function runCrossHoldingFlagMonitor(serviceRoleKey, allRows, freshByTicker) {
  const patterns = findCrossHoldingPatterns(allRows, freshByTicker);

  const suppressedFlagsByTicker = new Map();
  for (const pattern of patterns) {
    for (const ticker of pattern.tickers) {
      if (!suppressedFlagsByTicker.has(ticker)) suppressedFlagsByTicker.set(ticker, new Set());
      suppressedFlagsByTicker.get(ticker).add(pattern.flagId);
    }
  }

  let notified = 0;
  for (const pattern of patterns) {
    const dedupTicker = `${PORTFOLIO_SENTINEL_TICKER}:${pattern.flagId}`;
    const alreadyNotified = await hasRecentNotification(serviceRoleKey, pattern.userId, dedupTicker, 'red_flag_pattern', CROSS_HOLDING_DEDUP_HOURS);
    if (alreadyNotified) continue;

    const alert = buildConsolidatedAlert(pattern);
    const created = await createNotification(serviceRoleKey, {
      userId: pattern.userId,
      type: alert.type,
      ticker: dedupTicker,
      companyName: null,
      title: alert.title,
      body: alert.body
    });
    if (created) notified++;
  }

  return { checked: patterns.length, notified, suppressedFlagsByTicker };
}
