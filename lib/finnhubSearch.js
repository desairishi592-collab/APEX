// Shared Finnhub symbol-search helper, used by the web app's search autocomplete
// (api/search.js) and the external scan API's company-name resolution (api/v1/scan.js).

// Retries once on a 429 — a stock scan (quote + profile + metric + insider-transactions)
// shares the same Finnhub rate-limit bucket as a search call, so a search fired right
// after a scan can get momentarily throttled. A short backoff gives that per-minute
// window a chance to clear.
export async function searchFinnhub(query, finnhubKey, attempt = 1) {
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
