export const config = { runtime: 'edge' };

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

  if (!q) {
    return new Response(JSON.stringify({ results: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  let data;
  try {
    const res = await fetch(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${finnhubKey}`);
    data = res.ok ? await res.json() : null;
  } catch (fetchErr) {
    return new Response(JSON.stringify({ error: 'Could not reach market data provider' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Prefer primary US-listed common stock, skip dotted foreign-exchange duplicates, cap the list
  const results = (data?.result || [])
    .filter(r => r.symbol && !r.symbol.includes('.'))
    .slice(0, 8)
    .map(r => ({ symbol: r.symbol, description: r.description || '', type: r.type || '' }));

  return new Response(JSON.stringify({ results }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
