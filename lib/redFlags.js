// ── RED FLAG ALERTS ──
// Deterministic, threshold-based checks run fresh on every public-stock scan — not AI-generated,
// not scheduled, not emailed. Reuses data already pulled from Finnhub for the main scan report
// (stock/metric series + insider transactions); no new API calls are made here.
//
// Only applies to public stock scans: the checks below (D/E, current ratio, FCF, revenue trend,
// insider activity) are public-company financial-statement concepts backed by real Finnhub data.
// Private-business scans (owner mode, or investor evaluating a private business) don't have this
// data at all — user-typed monthly revenue/expenses isn't a substitute for filed financials — so
// this module is not wired into that path.

// Named thresholds — tune these here, not buried in the logic below.
const DEBT_TO_EQUITY_HIGH = 2.0;           // D/E above this is flagged as high leverage risk (industry-agnostic default)
const CURRENT_RATIO_MIN = 1.0;             // current ratio below this signals liquidity risk (can't cover short-term liabilities)
const FCF_MARGIN_DECLINE_PP = 10;          // FCF-margin drop (percentage points) over the lookback window that counts as "sharply declining"
const FCF_LOOKBACK_QUARTERS = 4;           // how many quarters back to compare FCF margin against
const REVENUE_DECLINE_QUARTERS = 3;        // consecutive quarters of declining revenue-per-share needed to flag
const INSIDER_RECENT_WINDOW_DAYS = 90;     // "recent" window checked for an insider-selling spike
const INSIDER_BASELINE_WINDOW_DAYS = 365;  // trailing window (immediately before the recent one) used as the baseline
const INSIDER_BASELINE_MIN_SELLS = 2;      // minimum baseline sell transactions required for a meaningful comparison
const INSIDER_SELL_SPIKE_MULTIPLIER = 3;   // recent sell $ volume vs. baseline average (normalized to the same window length) to call it a "spike"

// Finnhub's own field naming is inconsistent between its point-in-time "metric" object and its
// historical "series" object (already worked around elsewhere in this codebase via nz()) — try a
// few known variants rather than assuming one exact key name.
function getSeries(metricsResponse, candidateKeys, granularity = 'quarterly') {
  const bucket = metricsResponse?.series?.[granularity];
  if (!bucket) return null;
  for (const key of candidateKeys) {
    const arr = bucket[key];
    if (Array.isArray(arr) && arr.length) return arr;
  }
  return null;
}

// Normalizes a raw Finnhub series into [{period: Date, v: number}], sorted most-recent-first —
// don't trust the API's own ordering.
function normalizeSeries(rawSeries) {
  return rawSeries
    .map(pt => ({ period: new Date(pt.period), v: Number(pt.v) }))
    .filter(pt => !isNaN(pt.period.getTime()) && Number.isFinite(pt.v))
    .sort((a, b) => b.period - a.period);
}

function checkDebtToEquity(deRatio) {
  if (deRatio == null || !Number.isFinite(deRatio)) return null; // data not available for this ticker — skip, don't fake
  if (deRatio <= DEBT_TO_EQUITY_HIGH) return null;
  return {
    id: 'high_debt_to_equity',
    name: 'High debt-to-equity ratio',
    severity: deRatio > DEBT_TO_EQUITY_HIGH * 1.5 ? 'high' : 'medium',
    explanation: `Debt-to-equity is ${deRatio.toFixed(2)}, above the ${DEBT_TO_EQUITY_HIGH.toFixed(1)} threshold — this company relies heavily on debt financing.`,
    value: `D/E ratio: ${deRatio.toFixed(2)}`
  };
}

function checkCurrentRatio(currentRatio) {
  if (currentRatio == null || !Number.isFinite(currentRatio)) return null;
  if (currentRatio >= CURRENT_RATIO_MIN) return null;
  return {
    id: 'low_current_ratio',
    name: 'Current ratio below 1',
    severity: currentRatio < 0.5 ? 'high' : 'medium',
    explanation: `Current ratio is ${currentRatio.toFixed(2)}, below the ${CURRENT_RATIO_MIN.toFixed(1)} threshold — current liabilities exceed current assets, a liquidity risk.`,
    value: `Current ratio: ${currentRatio.toFixed(2)}`
  };
}

function checkFreeCashFlowTrend(metricsResponse) {
  const rawSeries = getSeries(metricsResponse, ['fcfMargin', 'focfMargin', 'freeCashFlowMargin']);
  if (!rawSeries) return null; // not reliably available for this ticker — skip rather than fake it
  const series = normalizeSeries(rawSeries);
  if (series.length < 2) return null;

  const latest = series[0].v;
  const lookbackIdx = Math.min(FCF_LOOKBACK_QUARTERS, series.length - 1);
  const past = series[lookbackIdx].v;
  const declinePP = past - latest;

  const negative = latest < 0;
  const sharplyDeclining = declinePP >= FCF_MARGIN_DECLINE_PP;
  if (!negative && !sharplyDeclining) return null;

  let severity, explanation;
  if (negative && sharplyDeclining) {
    severity = 'high';
    explanation = `Free cash flow margin is negative (${latest.toFixed(1)}%) and has fallen ${declinePP.toFixed(1)} points over the last ${lookbackIdx} quarters.`;
  } else if (negative) {
    severity = 'medium';
    explanation = `Free cash flow margin is negative (${latest.toFixed(1)}%) — the business is burning cash relative to revenue.`;
  } else {
    severity = 'low';
    explanation = `Free cash flow margin has fallen ${declinePP.toFixed(1)} percentage points over the last ${lookbackIdx} quarters (from ${past.toFixed(1)}% to ${latest.toFixed(1)}%), though still positive.`;
  }

  return { id: 'declining_free_cash_flow', name: 'Negative or sharply declining free cash flow', severity, explanation, value: `FCF margin: ${latest.toFixed(1)}%` };
}

function checkRevenueTrend(metricsResponse) {
  const rawSeries = getSeries(metricsResponse, ['salesPerShare', 'revenuePerShare']);
  if (!rawSeries) return null;
  const series = normalizeSeries(rawSeries);
  if (series.length < REVENUE_DECLINE_QUARTERS + 1) return null;

  let consecutiveDeclines = 0;
  for (let i = 0; i < REVENUE_DECLINE_QUARTERS; i++) {
    if (series[i].v < series[i + 1].v) consecutiveDeclines++;
    else break;
  }
  if (consecutiveDeclines < REVENUE_DECLINE_QUARTERS) return null;

  const latest = series[0].v;
  const oldest = series[REVENUE_DECLINE_QUARTERS].v;
  const pctChange = oldest !== 0 ? ((latest - oldest) / Math.abs(oldest)) * 100 : null;
  const severity = pctChange != null && pctChange <= -20 ? 'high' : pctChange != null && pctChange <= -5 ? 'medium' : 'low';

  return {
    id: 'declining_revenue_trend',
    name: 'Declining revenue trend',
    severity,
    explanation: `Revenue per share has declined for ${consecutiveDeclines} consecutive reported quarters${pctChange != null ? ` (down ${Math.abs(pctChange).toFixed(1)}% over that span)` : ''}.`,
    value: `Revenue per share: $${latest.toFixed(2)} (latest quarter)`
  };
}

function checkInsiderSellingSpike(insiderRecords) {
  if (!Array.isArray(insiderRecords) || insiderRecords.length === 0) return null;

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const recentCutoff = now - INSIDER_RECENT_WINDOW_DAYS * dayMs;
  const baselineCutoff = now - (INSIDER_RECENT_WINDOW_DAYS + INSIDER_BASELINE_WINDOW_DAYS) * dayMs;

  let recentSellValue = 0, baselineSellValue = 0, baselineSellCount = 0;
  insiderRecords.forEach(t => {
    if (t.transactionCode !== 'S') return;
    const date = new Date(t.transactionDate).getTime();
    if (isNaN(date)) return;
    const shares = Math.abs(t.change || t.share || 0);
    const value = shares * (t.transactionPrice || 0);
    if (date >= recentCutoff) {
      recentSellValue += value;
    } else if (date >= baselineCutoff) {
      baselineSellValue += value;
      baselineSellCount++;
    }
  });

  // Not enough baseline history to say what's "normal" for this company — skip rather than guess.
  if (baselineSellCount < INSIDER_BASELINE_MIN_SELLS || baselineSellValue <= 0) return null;

  const baselineAvgPerWindow = baselineSellValue / (INSIDER_BASELINE_WINDOW_DAYS / INSIDER_RECENT_WINDOW_DAYS);
  if (recentSellValue < baselineAvgPerWindow * INSIDER_SELL_SPIKE_MULTIPLIER) return null;

  return {
    id: 'insider_selling_spike',
    name: 'Insider selling spike',
    severity: recentSellValue >= baselineAvgPerWindow * INSIDER_SELL_SPIKE_MULTIPLIER * 2 ? 'high' : 'medium',
    explanation: `Insider sell volume in the last ${INSIDER_RECENT_WINDOW_DAYS} days (~$${Math.round(recentSellValue).toLocaleString()}) is over ${INSIDER_SELL_SPIKE_MULTIPLIER}x the trailing baseline rate (~$${Math.round(baselineAvgPerWindow).toLocaleString()}).`,
    value: `Recent insider sells: ~$${Math.round(recentSellValue).toLocaleString()}`
  };
}

// TODO: qualitative/news-based flags (lawsuits, leadership changes, etc.) are an explicit
// non-goal for v1 — financial-metrics only, per the current spec.

// Runs every check against data already fetched for the main scan report and returns only the
// flags that actually triggered. A check returns null (and is simply omitted) whenever the
// underlying data isn't available for this ticker — never fabricated.
export function computeRedFlags({ metricsResponse, debtToEquity, currentRatio, insiderRecords }) {
  return [
    checkDebtToEquity(debtToEquity),
    checkCurrentRatio(currentRatio),
    checkFreeCashFlowTrend(metricsResponse),
    checkRevenueTrend(metricsResponse),
    checkInsiderSellingSpike(insiderRecords)
  ].filter(Boolean);
}
