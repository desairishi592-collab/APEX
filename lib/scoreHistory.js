// ── SCORE HISTORY: SNAPSHOT INFRASTRUCTURE ──
// Records a point-in-time snapshot of each ticker's APEX score, sub-scores, and red flag count
// so future features (weekly digest trend lines, score-vs-price divergence detection, a backtest
// view) have real history to read instead of needing a backfill later. Global per-ticker, not
// per-user — lib/subScores.js computes one score per ticker regardless of who's watching it, so
// one row per ticker per run serves every user tracking it, with no duplication across users
// who share a ticker.
//
// Piggybacks on api/check-market-alerts.js's existing daily re-scan rather than adding a new
// cron (Vercel Hobby caps this project at 2 cron slots, both already spoken for). That handler
// already calls fetchFreshAnalysis() for every unique watchlist/portfolio ticker to power
// score-change alerts (lib/scoreMonitor.js), so recording a snapshot here costs one extra DB
// write per ticker and zero new Finnhub/Groq calls — which is what makes daily cadence free,
// even though weekly would also have been sufficient for the features this unblocks.

// Sub-scores are stored as a flat {category: score} map rather than the full sub-score objects
// (which also carry weight/scale/reason text) — enough for a future trend line or divergence
// check per category, without duplicating the human-readable "reason" prose into every snapshot.
function subScoresToMap(subScores) {
  if (!Array.isArray(subScores)) return null;
  const map = {};
  for (const s of subScores) {
    if (s?.category) map[s.category] = s.score;
  }
  return map;
}

// Bulk-inserts one row per ticker in freshByTicker (the same map api/check-market-alerts.js
// already builds for score-change monitoring) into score_history. Best-effort and isolated from
// the rest of the cron by the caller: a failure here should never block the alert checks that
// already ran this cycle.
export async function recordScoreSnapshots(serviceRoleKey, supabaseUrl, freshByTicker, companyNameByTicker) {
  const rows = Object.entries(freshByTicker)
    .filter(([, fresh]) => typeof fresh?.score === 'number')
    .map(([ticker, fresh]) => ({
      ticker,
      company_name: companyNameByTicker?.[ticker] ?? null,
      score: fresh.score,
      safety_score: fresh.stockAnalysis?.safetyScore ?? null,
      signal: fresh.stockAnalysis?.signal ?? null,
      sub_scores: subScoresToMap(fresh.subScores),
      red_flag_count: Array.isArray(fresh.redFlags) ? fresh.redFlags.length : 0
    }));

  if (!rows.length) return { inserted: 0 };

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/score_history`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(rows)
    });
    if (!res.ok) {
      console.error('Score history insert failed:', res.status, await res.text());
      return { inserted: 0, error: `Insert failed: ${res.status}` };
    }
    return { inserted: rows.length };
  } catch (e) {
    console.error('Score history insert failed:', e.message);
    return { inserted: 0, error: 'Insert failed' };
  }
}
