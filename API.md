# APEX External API (v1)

Internal/early-user reference doc — not a public docs site. v1 is intentionally minimal: no
billing, no plan-tiered rate limits, one endpoint.

## Getting an API key

1. Log in to the app and open your account menu (click your email in the top nav).
2. Under **API Access**, click **Generate API Key**.
3. Copy the key shown — it is only displayed once. It is stored server-side as a hash, never
   in plaintext, and cannot be recovered later.
4. Clicking **Regenerate API Key** invalidates the old key immediately and issues a new one.
   There is one active key per account.

## Authentication

Send your key as a bearer token on every request:

```
Authorization: Bearer apex_<your key>
```

## Endpoint

### `POST /api/v1/scan`

Runs a public-stock scan — the same scan/health report the web app produces (score, status,
summary, metrics, industry comparison, stock analysis, insider sentiment, risk timeline, and
red flags) — and returns it as JSON.

Only public stock tickers are supported in v1 (not the private-business owner/investor scan
form, and not shareable-report retrieval).

#### Request body

Provide **either** `ticker` or `company` (not both required — `ticker` is used directly if
present; `company` is resolved to a ticker via the same search Finnhub-backed lookup the web
app's autocomplete uses).

```json
{ "ticker": "AAPL" }
```

or

```json
{ "company": "Apple" }
```

#### Response — 200 OK

Same shape returned by the web app's stock scan, e.g. (truncated):

```json
{
  "score": 87,
  "status": "Safe",
  "summary": "...",
  "badge": "Strong margins",
  "metrics": [ { "label": "Current Price", "value": "$294.38", "type": "up", "trend": "..." } ],
  "industryComparison": [ { "metric": "Debt/Equity", "percentile": 72, "summary": "...", "color": "grn" } ],
  "costCuts": [ { "title": "...", "desc": "...", "color": "amb" } ],
  "stockAnalysis": { "valuation": {...}, "momentum": {...}, "dividend": {...}, "signal": "Hold", "safetyScore": 61, "verdict": "..." },
  "insiderSentiment": { "sentiment": "Neutral", "summary": "...", "netShares": 0, "buyCount": 1, "sellCount": 2, "recentTransactions": [...] },
  "riskTimeline": [ { "risk": "Valuation correction", "timeframe": "3-6 months", "detail": "...", "severity": "amb" } ],
  "redFlags": [ { "id": "low_current_ratio", "name": "Current ratio below sector norm", "severity": "medium", "explanation": "...", "value": "Current ratio: 0.89" } ],
  "competitors": [ { "ticker": "MSFT", "companyName": "Microsoft Corp" } ],
  "sectorBenchmark": { "sector": "Technology", "matched": true, "note": "Scored against Technology sector peers" }
}
```

`redFlags` is always an array (possibly empty — an empty array means the checks ran and found
nothing, not that they were skipped).

`sectorBenchmark` describes which sector peer group the score and red flags (debt/equity,
current ratio, and the deterministic quality score) were benchmarked against, instead of one
universal threshold for every company — see `lib/sectorBenchmarks.js`. `matched: false` means
Finnhub's industry classification for this ticker didn't map to a specific sector and a
general-market fallback was used. This field is additive; scans generated before it existed
(e.g. old entries in scan history) won't have it.

#### Errors

| Status | Meaning | Body |
|---|---|---|
| 400 | Malformed request — missing/invalid `ticker`/`company`, or unresolvable company name | `{ "error": "..." }` |
| 401 | Missing or invalid API key | `{ "error": "..." }` |
| 429 | Rate limit exceeded | `{ "error": "...", "retryAfterSeconds": <n> }` (also sent as a `Retry-After` header) |
| 502 | Upstream data provider (Finnhub) or AI provider (Groq) unavailable, or Groq's own capacity is temporarily exhausted | `{ "error": "...", "detail": "..." }` |

## Rate limits

Flat limit for all users in v1 — no plan tiers: **20 requests per hour** per API key. Exceeding
it returns `429` with `retryAfterSeconds` until the current window resets.

## Out of scope for v1

- Shareable report generation/retrieval via API
- Private-business (owner/investor) scans via API — stock scans only
- Any other web app feature via API (watchlists, chat, compare, price alerts, etc.)
- Usage-based billing or plan-tiered rate limits
- Multiple API keys per user, key scoping/permissions, or key rotation history
