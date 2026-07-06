export const config = { runtime: 'edge' };

import { checkAndIncrementIpRateLimit, getClientIp } from '../lib/rateLimit.js';

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
const IP_RATE_LIMIT_MAX_REQUESTS = 60; // per hour, per IP — cheap endpoint (no LLM), but still proxies
                                        // Finnhub's own rate-limited API and has no auth requirement.
const MAX_TICKERS_PER_REQUEST = 50; // a watchlist has no hard cap elsewhere; this just bounds one request's Finnhub fan-out

// Proxies Finnhub's quote endpoint for a batch of tickers so the API key stays server-side —
// used by the watchlist page to show live price/change per saved stock.
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
  const tickersParam = (searchParams.get('tickers') || '').trim();
  const tickers = [...new Set(
    tickersParam.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
  )].slice(0, MAX_TICKERS_PER_REQUEST);

  if (!tickers.length) {
    return new Response(JSON.stringify({ quotes: {} }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  const entries = await Promise.all(tickers.map(async (symbol) => {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${finnhubKey}`);
      if (!res.ok) return [symbol, null];
      const q = await res.json();
      // Finnhub returns c:0 (and every other field 0) for a ticker it doesn't recognize,
      // rather than an error status — treat that as "no data" instead of a real $0 quote.
      if (!q || typeof q.c !== 'number' || q.c === 0) return [symbol, null];
      return [symbol, {
        price: q.c,
        change: typeof q.d === 'number' ? q.d : null,
        percentChange: typeof q.dp === 'number' ? q.dp : null
      }];
    } catch {
      return [symbol, null];
    }
  }));

  return new Response(JSON.stringify({ quotes: Object.fromEntries(entries) }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
