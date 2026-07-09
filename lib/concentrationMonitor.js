// ── APEX AGENT: PORTFOLIO CONCENTRATION MONITORING ──
// Computes sector concentration across a user's COMBINED watchlist + portfolio holdings, reusing
// sector.label already resolved per ticker by every scan (lib/sectorBenchmarks.js's
// resolveSector(), surfaced as sectorBenchmark.sector in the scan response) — no new Finnhub
// calls. This reuses the SAME freshByTicker map api/check-market-alerts.js already builds for
// score monitoring (one re-scan per unique watchlist/portfolio ticker), so concentration
// awareness is a pure aggregation step on top of data already being fetched that run, not a new
// data source. This is the "connect the dots across a user's full portfolio in ways a human
// wouldn't easily piece together by eyeballing separate stock reports" idea.
//
// REGULATORY CONSTRAINT: strictly informational — "X of Y holdings (Z%) share <sector> exposure"
// only, never a recommendation to act on it ("you should diversify/sell..."). Same posture as
// lib/agentChecklist.js and lib/portfolioDigest.js elsewhere in the Agent.

import { createNotification, hasRecentNotification } from './notifications.js';

const CONCENTRATION_ALERT_THRESHOLD = 0.4;       // 40% of resolved-sector holdings in one sector
const MIN_HOLDINGS_FOR_CONCENTRATION_ALERT = 3;  // a "concentration" claim needs a few holdings to
                                                  // be meaningful — 1-2 holdings are trivially
                                                  // "100% in one sector," not a genuine signal
const CONCENTRATION_DEDUP_HOURS = 24 * 7;        // fire once per week while still elevated, not
                                                  // once a day for as long as the condition holds
// Sentinel, same precedent as api/weekly-digest.js's portfolio-level notification: this alert
// spans a user's whole tracked list, not one ticker, and every other notification type always has
// a real ticker, so a placeholder keeps the (unknown-to-us) column nullability assumption safe.
const PORTFOLIO_SENTINEL_TICKER = 'PORTFOLIO';

// Pure — no I/O. Groups {ticker, sector} pairs (sector may be null for a ticker whose fresh scan
// this run failed or is still resolving to "General Market" unmatched — simply excluded, not
// guessed at) and finds the single largest sector's share among the resolved subset.
export function computeSectorConcentration(tickerSectorPairs) {
  const resolved = tickerSectorPairs.filter(p => p.sector);
  if (!resolved.length) return null;

  const bySector = {};
  for (const p of resolved) {
    if (!bySector[p.sector]) bySector[p.sector] = [];
    bySector[p.sector].push(p.ticker);
  }

  const [dominantSector, dominantTickers] = Object.entries(bySector)
    .reduce((best, entry) => (entry[1].length > best[1].length ? entry : best));

  return {
    totalResolved: resolved.length,
    dominantSector,
    dominantTickers,
    dominantShare: dominantTickers.length / resolved.length
  };
}

// Pure — no I/O. Decides whether a concentration notification is warranted right now, and builds
// its (strictly descriptive, never prescriptive) title/body. Returns null when there's nothing to
// say — too few resolved holdings to be meaningful, or no sector currently crosses the threshold.
export function decideConcentrationAlert(concentration) {
  if (!concentration) return null;
  if (concentration.totalResolved < MIN_HOLDINGS_FOR_CONCENTRATION_ALERT) return null;
  if (concentration.dominantShare < CONCENTRATION_ALERT_THRESHOLD) return null;

  const { dominantSector, dominantTickers, dominantShare, totalResolved } = concentration;
  const pct = Math.round(dominantShare * 100);

  return {
    type: 'concentration_risk',
    title: `${pct}% of your tracked holdings are in ${dominantSector}`,
    body: `${dominantTickers.length} of ${totalResolved} tracked holdings (${dominantTickers.join(', ')}) share ${dominantSector} sector exposure.`
  };
}

// I/O runner: given ALL watchlist + portfolio rows (already fetched once by the cron handler) and
// the shared freshByTicker map (already fetched there for score monitoring — reused here, no new
// Finnhub/Groq call), computes and alerts on concentration PER USER across their own combined
// watchlist + portfolio, deduped weekly per user so it doesn't re-fire daily while still elevated.
export async function runConcentrationMonitor(serviceRoleKey, watchlistRows, portfolioRows, freshByTicker) {
  const byUser = new Map(); // userId -> Map(ticker -> companyName), deduped across both tables
  for (const row of [...watchlistRows, ...portfolioRows]) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, new Map());
    byUser.get(row.user_id).set(row.ticker, row.company_name);
  }

  let checked = 0, notified = 0;

  for (const [userId, tickerMap] of byUser) {
    checked++;

    const pairs = [...tickerMap.keys()].map(ticker => ({
      ticker,
      sector: freshByTicker[ticker]?.sectorBenchmark?.sector ?? null
    }));
    const alert = decideConcentrationAlert(computeSectorConcentration(pairs));
    if (!alert) continue;

    const alreadyNotified = await hasRecentNotification(serviceRoleKey, userId, PORTFOLIO_SENTINEL_TICKER, alert.type, CONCENTRATION_DEDUP_HOURS);
    if (alreadyNotified) continue;

    const created = await createNotification(serviceRoleKey, {
      userId,
      type: alert.type,
      ticker: PORTFOLIO_SENTINEL_TICKER,
      companyName: null,
      title: alert.title,
      body: alert.body
    });
    if (created) notified++;
  }

  return { checked, notified };
}
