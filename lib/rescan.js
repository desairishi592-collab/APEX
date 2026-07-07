// Shared helper for re-running a public-stock scan server-to-server (cron/background contexts,
// not the user-facing scan flow) — extracted out of api/weekly-digest.js so the new score/red-flag
// monitoring in api/check-market-alerts.js can reuse the exact same call instead of duplicating
// it, and so both get the FULL scan result (score, subScores, redFlags, stockAnalysis, ...) rather
// than each hand-rolling its own reduced shape.

// Re-runs the same public-stock analysis the app itself uses (via api/analyze.js, which is the
// one place that owns scoring logic), so "the score changed" means exactly what the user would
// see if they re-scanned the ticker themselves. Returns null on any failure or non-stock result
// — callers treat a missing fresh result as "skip this ticker this run", never fabricate one.
export async function fetchFreshAnalysis(origin, ticker, companyName) {
  try {
    const res = await fetch(`${origin}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subMode: 'public', stockTicker: ticker, stockCompanyName: companyName })
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.isPublicStock) return null;
    return data;
  } catch {
    return null;
  }
}
