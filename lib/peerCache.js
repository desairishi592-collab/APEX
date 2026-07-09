// ── PEER COMPARISON CACHE ──
// Shared, cross-user cache of peer companies' key comparison metrics (score, sub-scores, P/E,
// D/E) — keyed by ticker, ~24h expiry ("daily is probably fine, fundamentals don't change that
// often" per the task). This is what keeps peer comparisons cheap: a peer scanned once (by
// anyone, for any reason) serves every other user's comparison table referencing that same peer
// for the rest of the day, instead of paying a fresh Groq+Finnhub scan on every view.
//
// Populated two ways: (1) api/peer-comparison.js, when a cache miss forces a fresh scan of a
// peer ticker, and (2) lib/stockAnalysis.js itself, as a side effect of every normal primary
// stock scan — so a popular ticker scanned directly by many users also warms its own cache entry
// for whenever it shows up as someone ELSE's peer, not just when it's fetched as a peer directly.

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Returns the cached row (already shaped for direct use: score, sub_scores, pe_ratio,
// debt_equity, company_name) if one exists and is still fresh, or null on a miss/expiry/error.
export async function getCachedPeerScan(serviceRoleKey, ticker) {
  try {
    const since = new Date(Date.now() - CACHE_TTL_MS).toISOString();
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/peer_scan_cache?select=*&ticker=eq.${encodeURIComponent(ticker)}&cached_at=gte.${since}&limit=1`,
      { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  } catch {
    return null;
  }
}

// Upserts one ticker's comparison metrics. Best-effort: a failed write just means this ticker
// gets re-scanned next time it's requested as a peer, same as a cache miss — never blocks or
// throws for the caller.
export async function setCachedPeerScan(serviceRoleKey, { ticker, companyName, score, subScores, peRatio, debtEquity }) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/peer_scan_cache?on_conflict=ticker`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        ticker,
        company_name: companyName ?? null,
        score: score ?? null,
        sub_scores: subScores ?? null,
        pe_ratio: peRatio ?? null,
        debt_equity: debtEquity ?? null,
        cached_at: new Date().toISOString()
      })
    });
  } catch {
    // Non-fatal: worst case this ticker just gets re-scanned next time it's requested as a peer
  }
}
