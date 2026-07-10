export const config = { runtime: 'edge' };

import { handleStockAnalysis } from '../lib/stockAnalysis.js';
import { getCachedPeerScan, setCachedPeerScan } from '../lib/peerCache.js';
import { checkAndIncrementIpRateLimit, getClientIp } from '../lib/rateLimit.js';

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
// Lower than /api/analyze's 30/hour: a single call here can trigger up to 4 full Groq+Finnhub
// scans on a cold cache (one per peer), so the worst-case cost per request is much higher.
const IP_RATE_LIMIT_MAX_REQUESTS = 15;
const MAX_PEERS_PER_REQUEST = 4; // matches fetchCompetitors()'s own cap in lib/stockAnalysis.js

// Runs handleStockAnalysis directly (in-process), same as api/analyze.js already does — this is
// a live, user-facing request (not a background cron), so avoiding an extra HTTP round-trip to
// itself (the way api/check-market-alerts.js's fetchFreshAnalysis does) keeps latency down.
async function scanPeerFresh(ticker, companyName) {
  const response = await handleStockAnalysis(ticker, companyName);
  const data = await response.json();
  if (!data?.isPublicStock || typeof data.score !== 'number') return null;
  return {
    ticker,
    companyName: companyName || ticker,
    score: data.score,
    subScores: Array.isArray(data.subScores) ? data.subScores : [],
    peRatio: data.rawMetrics?.peRaw ?? null,
    debtEquity: data.rawMetrics?.debtEquityRaw ?? null
  };
}

// For each requested peer: serve from the shared cache (lib/peerCache.js) if fresh, otherwise
// run it through the same scan pipeline the primary scan uses and cache the result. Cache hits
// and misses are resolved in parallel across peers — one slow/cold peer doesn't block the others.
async function buildComparisons(serviceRoleKey, peers) {
  const results = await Promise.all(peers.map(async (peer) => {
    const ticker = String(peer?.ticker || '').toUpperCase();
    if (!ticker) return null;

    const cached = await getCachedPeerScan(serviceRoleKey, ticker);
    if (cached) {
      return {
        ticker,
        companyName: cached.company_name || peer.companyName || ticker,
        score: cached.score,
        subScores: Array.isArray(cached.sub_scores) ? cached.sub_scores : [],
        peRatio: cached.pe_ratio,
        debtEquity: cached.debt_equity,
        cached: true
      };
    }

    try {
      const fresh = await scanPeerFresh(ticker, peer.companyName);
      if (!fresh) return null;
      await setCachedPeerScan(serviceRoleKey, fresh);
      return { ...fresh, cached: false };
    } catch (e) {
      console.error(`Peer scan failed for ${ticker}:`, e.message);
      return null;
    }
  }));

  return results.filter(Boolean);
}

// Renders a real side-by-side peer comparison table (score, sub-scores, P/E, D/E) for the
// scan report screen, using peers lib/stockAnalysis.js's fetchCompetitors() already identified.
// Unauthenticated + IP-rate-limited, same posture as /api/analyze — guests can already view a
// full scan report, so peer comparison (an extension of that same report) stays open to them too.
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!serviceRoleKey || !finnhubKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY or FINNHUB_API_KEY' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const ip = getClientIp(req);
  const rateLimit = await checkAndIncrementIpRateLimit(ip, IP_RATE_LIMIT_MAX_REQUESTS, SUPABASE_URL, serviceRoleKey);
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({ error: 'Too many requests — please slow down and try again shortly.', retryAfterSeconds: rateLimit.retryAfterSeconds }), {
      status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(rateLimit.retryAfterSeconds) }
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Malformed request body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const peers = Array.isArray(body?.peers) ? body.peers.slice(0, MAX_PEERS_PER_REQUEST) : [];
  if (!peers.length) {
    return new Response(JSON.stringify({ comparisons: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  const comparisons = await buildComparisons(serviceRoleKey, peers);

  return new Response(JSON.stringify({ comparisons }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
