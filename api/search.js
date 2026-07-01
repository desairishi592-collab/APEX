export const config = { runtime: 'edge' };

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

// Only these have real exchange-suffix ambiguity worth resolving live against
// Finnhub (e.g. confirming Samsung's KRX suffix rather than guessing it).
const POPULAR_COMPANIES_DYNAMIC = [
  { name: 'Samsung Electronics', preferredSymbol: '005930.KS' },
  { name: 'Toyota Motor', preferredSymbol: '7203.T' },
  { name: 'LVMH Moet Hennessy', preferredSymbol: 'MC.PA' }
];

// Retries once on a 429 — a stock scan (quote + profile + metric + insider-transactions)
// shares the same Finnhub rate-limit bucket as this search endpoint, so a search fired
// right after a scan (e.g. opening "Compare with another stock") can get momentarily
// throttled. A short backoff gives that per-minute window a chance to clear.
async function searchFinnhub(query, finnhubKey, attempt = 1) {
  const res = await fetch(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&token=${finnhubKey}`);
  if (res.status === 429 && attempt < 2) {
    await new Promise(r => setTimeout(r, 400));
    return searchFinnhub(query, finnhubKey, attempt + 1);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Finnhub returned ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = await res.json();
  return data?.result || [];
}

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

  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').trim();
  const popular = searchParams.get('popular') === '1';

  // Default list shown before the user has typed anything. The 9 unambiguous
  // US megacaps are static (no Finnhub call, so this always renders even if
  // Finnhub is down or rate-limited); only the 3 exchange-suffix-ambiguous
  // international ones are resolved live, each independently best-effort.
  if (popular && !q) {
    const dynamicResults = await Promise.all(POPULAR_COMPANIES_DYNAMIC.map(async (c) => {
      try {
        const matches = await searchFinnhub(c.name, finnhubKey);
        if (!matches.length) return null;
        const best = matches.find(m => m.symbol === c.preferredSymbol) || matches[0];
        return { symbol: best.symbol, description: best.description || c.name, type: best.type || '' };
      } catch {
        return null;
      }
    }));
    return new Response(JSON.stringify({ results: [...POPULAR_COMPANIES_STATIC, ...dynamicResults.filter(Boolean)] }), {
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
    return new Response(JSON.stringify({ error: 'Could not reach market data provider', detail: fetchErr.message }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Keep international exchange listings (e.g. "005930.KS", "7203.T", "MC.PA") —
  // only cap the list length, Finnhub already ranks by relevance.
  const results = matches
    .filter(r => r.symbol)
    .slice(0, 10)
    .map(r => ({ symbol: r.symbol, description: r.description || '', type: r.type || '' }));

  return new Response(JSON.stringify({ results }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
