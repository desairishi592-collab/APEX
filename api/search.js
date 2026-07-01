export const config = { runtime: 'edge' };

// Curated defaults shown before the user types anything. Each has a best-guess
// preferred symbol (validated against Finnhub's own results below, so a wrong
// exchange-suffix guess self-corrects to whatever Finnhub actually returns).
const POPULAR_COMPANIES = [
  { name: 'Apple', preferredSymbol: 'AAPL' },
  { name: 'Microsoft', preferredSymbol: 'MSFT' },
  { name: 'Alphabet', preferredSymbol: 'GOOGL' },
  { name: 'Amazon', preferredSymbol: 'AMZN' },
  { name: 'Tesla', preferredSymbol: 'TSLA' },
  { name: 'Samsung Electronics', preferredSymbol: '005930.KS' },
  { name: 'Toyota Motor', preferredSymbol: '7203.T' },
  { name: 'LVMH Moet Hennessy', preferredSymbol: 'MC.PA' },
  { name: 'Alibaba', preferredSymbol: 'BABA' },
  { name: 'Meta Platforms', preferredSymbol: 'META' },
  { name: 'Netflix', preferredSymbol: 'NFLX' },
  { name: 'Nvidia', preferredSymbol: 'NVDA' }
];

async function searchFinnhub(query, finnhubKey) {
  const res = await fetch(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&token=${finnhubKey}`);
  if (!res.ok) return [];
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

  // Default list shown before the user has typed anything — resolved live against
  // Finnhub so exchange-suffix conventions (e.g. Samsung on KRX, Toyota on TSE,
  // LVMH on Euronext Paris) are always correct rather than hardcoded guesses.
  if (popular && !q) {
    let resolved;
    try {
      resolved = await Promise.all(POPULAR_COMPANIES.map(async (c) => {
        try {
          const matches = await searchFinnhub(c.name, finnhubKey);
          if (!matches.length) return null;
          const best = matches.find(m => m.symbol === c.preferredSymbol) || matches[0];
          return { symbol: best.symbol, description: best.description || c.name, type: best.type || '' };
        } catch {
          return null;
        }
      }));
    } catch (fetchErr) {
      return new Response(JSON.stringify({ error: 'Could not reach market data provider' }), {
        status: 502, headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ results: resolved.filter(Boolean) }), {
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
    return new Response(JSON.stringify({ error: 'Could not reach market data provider' }), {
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
