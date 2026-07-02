export const config = { runtime: 'edge' };

import { lookupUserByApiKey } from '../../lib/apiKeys.js';
import { checkAndIncrementRateLimit } from '../../lib/rateLimit.js';
import { handleStockAnalysis } from '../../lib/stockAnalysis.js';
import { searchFinnhub } from '../../lib/finnhubSearch.js';

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';

function errorResponse(status, error, extra) {
  return new Response(JSON.stringify({ error, ...extra }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

// External API v1 — POST { ticker: "AAPL" } or { company: "Apple" } with
// Authorization: Bearer <api key> → the same scan/health report (including red flags) the
// web app itself produces for a public-stock scan. See API.md for the full contract.
export default async function handler(req) {
  if (req.method !== 'POST') {
    return errorResponse(405, 'Method not allowed');
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const finnhubKey = process.env.FINNHUB_API_KEY;
  if (!serviceRoleKey || !finnhubKey) {
    return errorResponse(500, 'Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY or FINNHUB_API_KEY');
  }

  // ── AUTH ──
  const authHeader = req.headers.get('authorization') || '';
  const apiKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!apiKey) {
    return errorResponse(401, 'Missing API key. Send it as "Authorization: Bearer <key>".');
  }

  let userId;
  try {
    userId = await lookupUserByApiKey(apiKey, SUPABASE_URL, serviceRoleKey);
  } catch (e) {
    return errorResponse(502, 'Could not verify API key', { detail: e.message });
  }
  if (!userId) {
    return errorResponse(401, 'Invalid API key.');
  }

  // ── RATE LIMIT ──
  const rateLimit = await checkAndIncrementRateLimit(userId, SUPABASE_URL, serviceRoleKey);
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please slow down.', retryAfterSeconds: rateLimit.retryAfterSeconds }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(rateLimit.retryAfterSeconds) }
    });
  }

  // ── REQUEST BODY ──
  let body;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, 'Malformed request body — expected JSON.');
  }

  const ticker = typeof body?.ticker === 'string' ? body.ticker.trim() : '';
  const company = typeof body?.company === 'string' ? body.company.trim() : '';
  if (!ticker && !company) {
    return errorResponse(400, 'Request must include either "ticker" (e.g. "AAPL") or "company" (e.g. "Apple Inc").');
  }

  // ── RESOLVE TICKER (company name → best-match symbol, same lookup the web app's search uses) ──
  let resolvedTicker = ticker;
  let resolvedCompanyName = company || undefined;
  if (!resolvedTicker) {
    let matches;
    try {
      matches = await searchFinnhub(company, finnhubKey);
    } catch (e) {
      return errorResponse(502, 'Could not reach market data provider', { detail: e.message });
    }
    const best = matches.find(m => m.symbol) || null;
    if (!best) {
      return errorResponse(400, `Could not resolve "${company}" to a known ticker symbol.`);
    }
    resolvedTicker = best.symbol;
    resolvedCompanyName = best.description || company;
  }

  return await handleStockAnalysis(resolvedTicker, resolvedCompanyName);
}
