// ── COMPARE-ON-ALERT: PEER CONTEXT FOR RED FLAG NOTIFICATIONS ──
// When a red flag fires on a watchlist or portfolio ticker, this module selects the single most
// informative peer for the triggered metric and generates a factual comparison sentence to attach
// to the alert body. Informational only — never personalized recommendations or "you should" language,
// consistent with the regulatory constraint used throughout APEX's Agent features.
//
// Peers come from fresh.competitors (already populated by lib/stockAnalysis.js's fetchCompetitors()
// via the prior scan) — no new peer-fetching pipeline. Only one lightweight Finnhub /stock/metric
// call is made (for the selected peer), and only when a red flag actually fires.

// Maps each red-flag id to:
//   - metricKey: the key in rawMetrics (primary ticker's value, already in the fresh scan)
//   - finnhubField: the field to read out of Finnhub's metric.metric object for the peer
//   - label: how to describe the metric in the comparison sentence
//   - unit: suffix for the formatted value ('x' for ratios, '%' for margins/returns, '' for others)
//   - direction: 'lower_is_better' or 'higher_is_better' — used to determine "informative contrast"
const FLAG_METRIC_MAP = {
  high_debt_to_equity: {
    metricKey: 'debtEquityRaw',
    finnhubField: 'totalDebt/totalEquityAnnual',
    label: 'debt-to-equity ratio',
    unit: 'x',
    direction: 'lower_is_better'
  },
  low_current_ratio: {
    metricKey: 'currentRatioRaw',
    finnhubField: 'currentRatioAnnual',
    label: 'current ratio',
    unit: 'x',
    direction: 'higher_is_better'
  },
  declining_free_cash_flow: {
    metricKey: 'fcfMarginRaw',
    finnhubField: 'fcfMarginAnnual',
    // Finnhub returns this as a decimal fraction in the metric object (same convention as the
    // series object handled in lib/redFlags.js's getFcfMarginSeries) — multiply by 100.
    scale: 100,
    label: 'FCF margin',
    unit: '%',
    direction: 'higher_is_better'
  },
  declining_revenue_trend: {
    metricKey: 'revenuePerShareRaw',    // not in rawMetrics — revenue is series-only; fall back to profitMarginRaw
    fallbackMetricKey: 'profitMarginRaw',
    finnhubField: 'netProfitMarginAnnual',
    label: 'net profit margin',
    unit: '%',
    direction: 'higher_is_better'
  },
  insider_selling_spike: {
    // No single comparable metric for insider activity — use profit margin as a proxy for
    // overall business health context when this flag fires.
    metricKey: 'profitMarginRaw',
    finnhubField: 'netProfitMarginAnnual',
    label: 'net profit margin',
    unit: '%',
    direction: 'higher_is_better'
  }
};

// Fetches a single Finnhub metric field for a peer ticker. Returns null on any failure —
// callers treat null as "this peer has no usable data for comparison."
async function fetchPeerMetricValue(peerTicker, finnhubField, scale, finnhubKey) {
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(peerTicker)}&metric=all&token=${finnhubKey}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    let v = data?.metric?.[finnhubField];
    if (v == null || !Number.isFinite(Number(v))) return null;
    v = Number(v);
    if (scale) v *= scale;
    return v;
  } catch {
    return null;
  }
}

// Formats a metric value for the comparison sentence (e.g. 1.23 + 'x' → '1.23x', 14.5 + '%' → '14.5%').
function formatValue(v, unit) {
  if (unit === 'x') return `${v.toFixed(2)}x`;
  if (unit === '%') return `${v.toFixed(1)}%`;
  return v.toFixed(2);
}

// Given the triggered flag's direction preference and a primary vs. peer value, quantifies how
// informative the contrast is. A peer that shows the OPPOSITE trajectory (i.e. the primary is
// struggling but the peer is healthy) provides the most useful "is this company-specific or
// industry-wide?" signal. Returns a numeric score — higher = more informative.
function contrastScore(primaryValue, peerValue, direction) {
  if (primaryValue == null || peerValue == null) return -Infinity;
  const diff = direction === 'lower_is_better'
    ? primaryValue - peerValue   // primary is high (bad), peer is lower (better) → positive = good contrast
    : peerValue - primaryValue;  // primary is low (bad), peer is higher (better) → positive = good contrast
  return diff;
}

// Selects the single most informative peer for the primary (most severe) red flag. Fetches one
// Finnhub metric call per candidate peer (up to 3). Returns { peer, peerValue } or null if no
// peer yields usable data.
export async function selectBestPeer(peers, primaryFlagId, primaryMetricValue, finnhubKey) {
  if (!Array.isArray(peers) || peers.length === 0) return null;
  const spec = FLAG_METRIC_MAP[primaryFlagId];
  if (!spec) return null;

  const candidates = peers.slice(0, 3); // cap to 3 Finnhub calls max
  const results = await Promise.all(
    candidates.map(async peer => {
      const peerValue = await fetchPeerMetricValue(peer.ticker, spec.finnhubField, spec.scale, finnhubKey);
      return { peer, peerValue };
    })
  );

  const withData = results.filter(r => r.peerValue != null);
  if (!withData.length) return null;

  // Pick the peer whose metric provides the greatest informative contrast against the primary.
  return withData.reduce((best, r) => {
    const rScore = contrastScore(primaryMetricValue, r.peerValue, spec.direction);
    const bestScore = contrastScore(primaryMetricValue, best.peerValue, spec.direction);
    return rScore > bestScore ? r : best;
  });
}

// Generates the factual, plain-language comparison sentence for the alert body.
// Returns null if either value is missing — caller omits the line rather than showing a stub.
export function buildComparisonSentence(ticker, peerTicker, peerCompanyName, flagId, primaryValue, peerValue) {
  if (primaryValue == null || peerValue == null) return null;
  const spec = FLAG_METRIC_MAP[flagId];
  if (!spec) return null;

  const unit = spec.unit;
  const label = spec.label;
  const peerName = peerCompanyName || peerTicker;

  // For FCF margin and profit margin: if primary shows a decline/drop, describe it in delta terms
  // when the flag specifically calls out a drop. For ratio flags, compare current levels directly.
  const primaryStr = formatValue(primaryValue, unit);
  const peerStr = formatValue(peerValue, unit);

  const primaryBetter = spec.direction === 'lower_is_better'
    ? primaryValue <= peerValue
    : primaryValue >= peerValue;

  if (primaryBetter) {
    // Unusual case: primary is actually better than peer on this metric despite the flag firing
    // (flag fired due to absolute threshold, not relative comparison) — still factual.
    return `${ticker}'s ${label} is ${primaryStr}; ${peerName}'s is ${peerStr} over the same period.`;
  }

  const dirWord = spec.direction === 'lower_is_better' ? 'higher' : 'lower';
  return `${ticker}'s ${label} stands at ${primaryStr}; ${peerName}'s is ${peerStr} over the same period.`;
}

// Top-level entry point called by lib/scoreMonitor.js. Given a red_flag notification (which has
// access to fresh.competitors and fresh.rawMetrics via the `fresh` scan), returns the comparison
// sentence string, or null if unavailable. Never throws — any failure returns null so the alert
// still fires without the comparison line.
export async function getPeerComparisonLine(fresh, primaryFlagId, finnhubKey) {
  try {
    const peers = Array.isArray(fresh?.competitors) ? fresh.competitors : [];
    if (!peers.length) return null;

    const spec = FLAG_METRIC_MAP[primaryFlagId];
    if (!spec) return null;

    const rawMetrics = fresh?.rawMetrics || {};
    // Prefer the direct metricKey; fall back to fallbackMetricKey for flags where the primary
    // metric isn't stored in rawMetrics (e.g. revenue-per-share is series-only, not in rawMetrics).
    let primaryValue = rawMetrics[spec.metricKey];
    if (primaryValue == null && spec.fallbackMetricKey) primaryValue = rawMetrics[spec.fallbackMetricKey];
    if (primaryValue == null || !Number.isFinite(primaryValue)) return null;

    const best = await selectBestPeer(peers, primaryFlagId, primaryValue, finnhubKey);
    if (!best) return null;

    return buildComparisonSentence(
      fresh.ticker || '',
      best.peer.ticker,
      best.peer.companyName,
      primaryFlagId,
      primaryValue,
      best.peerValue
    );
  } catch {
    return null;
  }
}
