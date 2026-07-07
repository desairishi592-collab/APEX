// ── EXPLAINABLE SCORE BREAKDOWN ──
// Turns the single APEX score into a set of named sub-scores (0-10) with a plain-English
// reason each, so the report shows "why" instead of just "trust us" — the same gap Danelfin
// covers with per-category scores and Simply Wall St's Snowflake only partially closes.
//
// Reuses the sector-benchmark reference table and interpolation helper from
// lib/sectorBenchmarks.js rather than recomputing anything — every sub-score here is derived
// from raw metrics + sector data that lib/stockAnalysis.js has already fetched/resolved.
//
// Deliberately does NOT claim a fabricated percentile like "beats 80% of peers" — the sector
// table is a static set of reference points, not a real empirical distribution, so a specific
// percentile would be manufactured precision. Reasons instead state the raw number against the
// sector median (a literal, always-correct numeric comparison) plus a qualitative strength/
// weakness tag derived from the benchmark score, which is honest about what the data supports.

import { scoreAgainstBenchmark } from './sectorBenchmarks.js';

// Universal (non-sector-relative) scoring for 1-year price return — a good return is a good
// return in any industry, so this doesn't route through the sector benchmark table. Exported
// so lib/stockAnalysis.js's deterministic quality score and this module's Momentum sub-score
// share one formula instead of drifting apart.
export function scoreMomentum(yearReturnRaw) {
  if (yearReturnRaw == null || !Number.isFinite(yearReturnRaw)) return null;
  return Math.max(0, Math.min(100, 50 + yearReturnRaw * 1.2));
}

// Converts a 0-100 benchmark score to the 0-10 scale used for sub-scores (kept visually
// distinct from the main 0-100 APEX score).
function to10(score0to100) {
  return Math.round(score0to100 / 10);
}

// "above/below/in line with the sector median" is a literal numeric comparison — always correct
// regardless of whether a higher raw value is good (margin, ROE) or bad (debt/equity, beta) for
// this particular metric. Direction/favorability is handled separately by qualitativeTag().
function rawVsMedianWord(rawValue, median) {
  const tolerance = Math.max(Math.abs(median) * 0.05, 0.01);
  if (rawValue > median + tolerance) return 'above';
  if (rawValue < median - tolerance) return 'below';
  return 'in line with';
}

// Describes how favorable a benchmark score is — direction-aware already, since
// scoreAgainstBenchmark() folds "lower is better" metrics in before this ever sees the score.
function qualitativeTag(score0to100) {
  if (score0to100 >= 80) return 'a clear strength';
  if (score0to100 >= 60) return 'a strength';
  if (score0to100 >= 40) return 'roughly average for the sector';
  if (score0to100 >= 20) return 'a weakness';
  return 'a clear weakness';
}

// Shared sentence-builder for a single metric vs. its sector benchmark, used by every
// category below so the phrasing (and the above/below-vs-favorable distinction) stays
// consistent instead of being re-derived per metric.
function describeMetric(metricLabel, rawValue, triplet, score0to100, sectorLabel, formatValue) {
  const cmp = rawVsMedianWord(rawValue, triplet.median);
  return `${metricLabel} of ${formatValue(rawValue)} is ${cmp} the ${sectorLabel} sector median (~${formatValue(triplet.median)}) — ${qualitativeTag(score0to100)}`;
}

const pct = v => `${v}%`;
const num2 = v => v.toFixed(2);
const num1 = v => v.toFixed(1);

function buildProfitability({ profitMarginRaw, roeRaw }, sector) {
  const b = sector.benchmarks;
  const marginScore = scoreAgainstBenchmark(profitMarginRaw, b.profitMargin, true);
  const roeScore = scoreAgainstBenchmark(roeRaw, b.roe, true);
  const parts = [marginScore, roeScore].filter(v => v != null);
  if (!parts.length) return null;
  const avg = parts.reduce((s, v) => s + v, 0) / parts.length;

  const reasons = [];
  if (marginScore != null) reasons.push(describeMetric('Profit margin', profitMarginRaw, b.profitMargin, marginScore, sector.label, v => pct(num1(v))));
  if (roeScore != null) reasons.push(describeMetric('ROE', roeRaw, b.roe, roeScore, sector.label, v => pct(num1(v))));
  return { category: 'Profitability', score: to10(avg), scale: '0-10', reason: capitalize(reasons.join('; ')) + '.' };
}

function buildFinancialHealth({ debtEquityRaw, currentRatioRaw }, sector) {
  const b = sector.benchmarks;
  const deScore = scoreAgainstBenchmark(debtEquityRaw, b.debtEquity, false);
  const crScore = scoreAgainstBenchmark(currentRatioRaw, b.currentRatio, true);
  const parts = [deScore, crScore].filter(v => v != null);
  if (!parts.length) return null;
  const avg = parts.reduce((s, v) => s + v, 0) / parts.length;

  const reasons = [];
  if (deScore != null) reasons.push(describeMetric('Debt/equity', debtEquityRaw, b.debtEquity, deScore, sector.label, num2));
  if (crScore != null) reasons.push(describeMetric('Current ratio', currentRatioRaw, b.currentRatio, crScore, sector.label, num2));
  return { category: 'Financial Health', score: to10(avg), scale: '0-10', reason: capitalize(reasons.join('; ')) + '.' };
}

function buildValuation({ peRaw }, sector) {
  if (peRaw == null || !Number.isFinite(peRaw) || peRaw < 0) return null; // negative P/E isn't a valuation signal, it's a losses signal — skip rather than misrepresent
  const b = sector.benchmarks;
  const score = scoreAgainstBenchmark(peRaw, b.peRatio, false);
  if (score == null) return null;
  return { category: 'Valuation', score: to10(score), scale: '0-10', reason: capitalize(describeMetric('P/E', peRaw, b.peRatio, score, sector.label, num1)) + '.' };
}

function buildRisk({ betaRaw }, sector) {
  const b = sector.benchmarks;
  const score = scoreAgainstBenchmark(betaRaw, b.beta, false);
  if (score == null) return null;
  return { category: 'Risk (Volatility)', score: to10(score), scale: '0-10', reason: capitalize(describeMetric('Beta', betaRaw, b.beta, score, sector.label, num2)) + '.' };
}

// Momentum is intentionally universal, not sector-relative — a strong 1-year return isn't
// judged against sector norms the way leverage or valuation is.
function buildMomentum({ yearReturnRaw }) {
  const score = scoreMomentum(yearReturnRaw);
  if (score == null) return null;
  const direction = yearReturnRaw >= 0 ? 'up' : 'down';
  return {
    category: 'Momentum',
    score: to10(score),
    scale: '0-10',
    reason: `Stock is ${direction} ${Math.abs(yearReturnRaw).toFixed(1)}% over the past year.`
  };
}

// Red Flags rolls up the already-computed lib/redFlags.js output rather than re-deriving
// anything — a clean pass-through into the same 0-10 sub-score shape as the others.
function buildRedFlags(redFlags) {
  if (!Array.isArray(redFlags)) return null;
  if (redFlags.length === 0) {
    return { category: 'Red Flags', score: 10, scale: '0-10', reason: 'No red flags detected across debt, liquidity, cash flow, revenue, or insider-activity checks.' };
  }
  const deduction = redFlags.reduce((sum, f) => sum + (f.severity === 'high' ? 4 : f.severity === 'medium' ? 2 : 1), 0);
  const score = Math.max(0, 10 - deduction);
  const names = redFlags.map(f => f.name).join(', ');
  return { category: 'Red Flags', score, scale: '0-10', reason: `${redFlags.length} flag${redFlags.length > 1 ? 's' : ''} triggered: ${names}.` };
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Builds the full explainable breakdown for a stock scan. Each entry is independent — a
// missing metric for a given ticker just omits that category rather than faking a score.
export function computeSubScores(rawMetrics, sector, redFlags) {
  return [
    buildProfitability(rawMetrics, sector),
    buildFinancialHealth(rawMetrics, sector),
    buildValuation(rawMetrics, sector),
    buildRisk(rawMetrics, sector),
    buildMomentum(rawMetrics),
    buildRedFlags(redFlags)
  ].filter(Boolean);
}
