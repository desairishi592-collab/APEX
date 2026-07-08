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

// Category weights for the overall APEX score — see computeOverallScore() below. These are
// the ONLY weights in the scoring system: the overall score is derived directly from these
// five sub-scores, nothing else (no separate/parallel "quality score" formula). Red Flags is
// deliberately excluded from the weighted average (see its own comment below) so a serious
// flag can't get mathematically diluted away by strong numbers elsewhere.
const WEIGHTS = {
  Profitability: 0.25,
  'Financial Health': 0.20,
  Valuation: 0.15,
  'Risk (Volatility)': 0.15,
  Momentum: 0.25
};

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
  return { category: 'Profitability', score: to10(avg), scale: '0-10', weight: WEIGHTS.Profitability, reason: capitalize(reasons.join('; ')) + '.' };
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
  return { category: 'Financial Health', score: to10(avg), scale: '0-10', weight: WEIGHTS['Financial Health'], reason: capitalize(reasons.join('; ')) + '.' };
}

function buildValuation({ peRaw }, sector) {
  if (peRaw == null || !Number.isFinite(peRaw) || peRaw < 0) return null; // negative P/E isn't a valuation signal, it's a losses signal — skip rather than misrepresent
  const b = sector.benchmarks;
  const score = scoreAgainstBenchmark(peRaw, b.peRatio, false);
  if (score == null) return null;
  return { category: 'Valuation', score: to10(score), scale: '0-10', weight: WEIGHTS.Valuation, reason: capitalize(describeMetric('P/E', peRaw, b.peRatio, score, sector.label, num1)) + '.' };
}

function buildRisk({ betaRaw }, sector) {
  const b = sector.benchmarks;
  const score = scoreAgainstBenchmark(betaRaw, b.beta, false);
  if (score == null) return null;
  return { category: 'Risk (Volatility)', score: to10(score), scale: '0-10', weight: WEIGHTS['Risk (Volatility)'], reason: capitalize(describeMetric('Beta', betaRaw, b.beta, score, sector.label, num2)) + '.' };
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
    weight: WEIGHTS.Momentum,
    reason: `Stock is ${direction} ${Math.abs(yearReturnRaw).toFixed(1)}% over the past year.`
  };
}

// Red Flags rolls up the already-computed lib/redFlags.js output rather than re-deriving
// anything — a clean pass-through into the same 0-10 sub-score shape as the others. Deliberately
// has no `weight` and is NOT part of computeOverallScore()'s weighted average: a red flag is a
// warning signal, not just one input among five to be smoothed out — averaging it in would let
// strong Profitability/Momentum numbers mathematically cancel out a serious flag, which defeats
// the point of surfacing it. It's shown for information; genuine distress is instead reflected
// via the score ceiling applied in lib/stockAnalysis.js.
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
// Categories that carry a `weight` (i.e. participate in computeOverallScore below) get a
// human-readable `weightLabel` too, e.g. "25% weight", so the UI can show the math isn't
// hidden — Red Flags has neither, since it isn't part of the weighted average (see its own
// comment above).
export function computeSubScores(rawMetrics, sector, redFlags) {
  return [
    buildProfitability(rawMetrics, sector),
    buildFinancialHealth(rawMetrics, sector),
    buildValuation(rawMetrics, sector),
    buildRisk(rawMetrics, sector),
    buildMomentum(rawMetrics),
    buildRedFlags(redFlags)
  ].filter(Boolean).map(s => s.weight != null ? { ...s, weightLabel: `${Math.round(s.weight * 100)}% weight` } : s);
}

// Derives the overall 0-100 APEX score AS a weighted average of the visible sub-scores above —
// this is the ONLY formula behind the top-level score for a stock scan; there is no separate,
// parallel calculation with different weights. Deliberately computed from each sub-score's
// already-rounded /10 display value (not the internal pre-rounding 0-100 number), so the result
// is exactly hand-verifiable from what's on screen: multiply each visible score by 10, by its
// weight, sum, divide by total weight. If a category is missing for this ticker (e.g. no P/E
// data), its weight is dropped and the remaining weights are renormalized rather than treating
// the missing category as a 0.
export function computeOverallScore(subScores) {
  const weighted = subScores.filter(s => s.weight != null);
  if (!weighted.length) return null;
  const totalWeight = weighted.reduce((sum, s) => sum + s.weight, 0);
  const sum = weighted.reduce((sum, s) => sum + (s.score * 10) * s.weight, 0);
  return Math.max(0, Math.min(100, Math.round(sum / totalWeight)));
}
