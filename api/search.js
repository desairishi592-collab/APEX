export const config = { runtime: 'edge' };

import { searchFinnhub } from '../lib/finnhubSearch.js';
import { checkAndIncrementIpRateLimit, getClientIp } from '../lib/rateLimit.js';

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
const IP_RATE_LIMIT_MAX_REQUESTS = 60; // per hour, per IP — cheap endpoint (no LLM), but still proxies
                                        // Finnhub's own rate-limited API and has no auth requirement.

// These tickers are unambiguous and don't need live validation — skip the Finnhub
// round-trip entirely to keep the default list cheap on API rate limits.
const POPULAR_COMPANIES_STATIC = [
  { symbol: 'AAPL', description: 'APPLE INC', type: 'Common Stock' },
  { symbol: 'MSFT', description: 'MICROSOFT CORP', type: 'Common Stock' },
  { symbol: 'GOOGL', description: 'ALPHABET INC', type: 'Common Stock' },
  { symbol: 'AMZN', description: 'AMAZON.COM INC', type: 'Common Stock' },
  { symbol: 'TSLA', description: 'TESLA INC', type: 'Common Stock' },
  { symbol: 'BABA', description: 'ALIBABA GROUP HOLDING LTD', type: 'Common Stock' },
  { symbol: 'META', description: 'META PLATFORMS INC', type: 'Common Stock' },
  { symbol: 'NFLX', description: 'NETFLIX INC', type: 'Common Stock' },
  { symbol: 'NVDA', description: 'NVIDIA CORP', type: 'Common Stock' }
];

// US-only support: Finnhub represents non-US listings with a dot-suffixed symbol
// (e.g. "005930.KS", "7203.T", "MC.PA", "0700.HK") — plain symbols with no dot are
// NYSE/NASDAQ-listed. Filtering on the dot keeps this simple with no exchange allow-list to maintain.
const isUsTicker = (symbol) => typeof symbol === 'string' && symbol.length > 0 && !symbol.includes('.');

// Proxies Finnhub's symbol search so the API key stays server-side.
export default async function handler(req) {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }

  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!finnhubKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration: FINNHUB_API_KEY is not set' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceRoleKey) {
    const ip = getClientIp(req);
    const rateLimit = await checkAndIncrementIpRateLimit(ip, IP_RATE_LIMIT_MAX_REQUESTS, SUPABASE_URL, serviceRoleKey);
    if (!rateLimit.allowed) {
      return new Response(JSON.stringify({ error: 'Too many requests — please slow down and try again shortly.', retryAfterSeconds: rateLimit.retryAfterSeconds }), {
        status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(rateLimit.retryAfterSeconds) }
      });
    }
  }

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').trim();
  const popular = searchParams.get('popular') === '1';

  // Default list shown before the user has typed anything — the 9 unambiguous
  // US megacaps, static so this always renders even if Finnhub is down or rate-limited.
  if (popular && !q) {
    return new Response(JSON.stringify({ results: POPULAR_COMPANIES_STATIC }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!q) {
    return new Response(JSON.stringify({ results: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  let matches;
  try {
    matches = await searchFinnhub(q, finnhubKey);
  } catch (fetchErr) {
    console.error('Finnhub search failed:', fetchErr.message);
    return new Response(JSON.stringify({ error: 'Could not reach market data provider' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  // US exchanges only (NYSE/NASDAQ) — international listings are excluded for now.
  const results = matches
    .filter(r => r.symbol && isUsTicker(r.symbol))
    .slice(0, 10)
    .map(r => ({ symbol: r.symbol, description: r.description || '', type: r.type || '' }));

  return new Response(JSON.stringify({ results }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
