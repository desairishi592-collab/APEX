// ── SECTOR-CALIBRATED SCORING BENCHMARKS ──
// Static reference table of "typical" values for the metrics that vary meaningfully by
// industry (leverage, margins, ROE, volatility, liquidity). Used to replace flat/universal
// thresholds elsewhere (lib/stockAnalysis.js quality score, lib/redFlags.js) with sector-
// relative ones — a utility running D/E 1.5 is normal, a software company running D/E 1.5
// is a real warning sign. Simply Wall St's biggest documented gap is scoring every company
// against the same bar regardless of industry; this table is what lets APEX not do that.
//
// Numbers here are broad, defensible reference points (not scraped/computed from live data)
// — good enough to meaningfully separate sectors without needing a live peer-data pipeline.
// Revisit with real aggregate data once scan volume is high enough to compute this dynamically.
//
// Each metric is a { good, median, poor } triplet consumed by scoreAgainstBenchmark() below.
// "good"/"poor" are the reference points a raw value maps to 100/0, not hard cutoffs.
//
// fcfMargin (free cash flow / revenue) feeds Financial Health alongside debt/equity and current
// ratio — added because a static balance-sheet snapshot alone can misjudge a company like Apple,
// which deliberately runs elevated debt/equity and a sub-1.0 current ratio funded by buybacks and
// cash-flow-backed borrowing, not distress. Cash generation capacity is what actually determines
// whether a company can service that debt, and it's a genuinely different signal from the other
// two — a company can look "poor" on both leverage ratios while still converting a large share of
// revenue into real cash, which is precisely the case a pure ratio-snapshot approach misses.
const SECTOR_TABLE = {
  Technology: {
    label: 'Technology',
    benchmarks: {
      profitMargin: { good: 25, median: 12, poor: -5 },
      roe: { good: 30, median: 15, poor: -5 },
      debtEquity: { good: 0.1, median: 0.4, poor: 1.2 },
      beta: { good: 0.9, median: 1.3, poor: 2.2 },
      currentRatio: { good: 2.5, median: 1.8, poor: 0.9 },
      peRatio: { good: 15, median: 28, poor: 55 }, // growth premium makes a higher P/E normal here
      fcfMargin: { good: 30, median: 15, poor: -10 } // mega-cap tech (Apple, Microsoft) routinely converts 25-30%+ of revenue to FCF
    }
  },
  Healthcare: {
    label: 'Healthcare',
    benchmarks: {
      profitMargin: { good: 20, median: 8, poor: -15 }, // biotech pre-revenue losses are common
      roe: { good: 20, median: 10, poor: -10 },
      debtEquity: { good: 0.2, median: 0.6, poor: 1.5 },
      beta: { good: 0.7, median: 1.0, poor: 1.8 },
      currentRatio: { good: 3.0, median: 2.0, poor: 1.0 },
      peRatio: { good: 12, median: 22, poor: 45 },
      fcfMargin: { good: 20, median: 5, poor: -30 } // pre-revenue biotech cash burn can be severe
    }
  },
  Financials: {
    label: 'Financials',
    benchmarks: {
      profitMargin: { good: 30, median: 20, poor: 0 },
      roe: { good: 15, median: 10, poor: 0 },
      // Banks/insurers run high leverage by design — this is the sector the current flat
      // D/E > 2.0 threshold most obviously mis-scores.
      debtEquity: { good: 1.5, median: 3.5, poor: 8.0 },
      beta: { good: 0.8, median: 1.1, poor: 1.8 },
      currentRatio: { good: 1.5, median: 1.1, poor: 0.7 }, // less meaningful for banks, kept lenient
      peRatio: { good: 8, median: 12, poor: 20 }, // banks/insurers typically trade at a discount multiple
      fcfMargin: { good: 25, median: 15, poor: -5 } // "FCF margin" isn't a standard bank metric — Finnhub often won't have it, skipped gracefully when absent
    }
  },
  'Consumer Discretionary': {
    label: 'Consumer Discretionary',
    benchmarks: {
      profitMargin: { good: 12, median: 5, poor: -5 },
      roe: { good: 25, median: 12, poor: -5 },
      debtEquity: { good: 0.3, median: 0.9, poor: 2.0 },
      beta: { good: 0.9, median: 1.2, poor: 2.0 },
      currentRatio: { good: 2.0, median: 1.3, poor: 0.7 },
      peRatio: { good: 12, median: 20, poor: 35 },
      fcfMargin: { good: 12, median: 5, poor: -10 }
    }
  },
  'Consumer Staples': {
    label: 'Consumer Staples',
    benchmarks: {
      profitMargin: { good: 10, median: 5, poor: -2 },
      roe: { good: 25, median: 15, poor: 0 },
      debtEquity: { good: 0.4, median: 1.0, poor: 2.2 },
      beta: { good: 0.5, median: 0.7, poor: 1.2 },
      currentRatio: { good: 1.8, median: 1.2, poor: 0.7 },
      peRatio: { good: 15, median: 22, poor: 32 },
      fcfMargin: { good: 10, median: 6, poor: -3 }
    }
  },
  Industrials: {
    label: 'Industrials',
    benchmarks: {
      profitMargin: { good: 12, median: 6, poor: -3 },
      roe: { good: 20, median: 12, poor: -5 },
      debtEquity: { good: 0.4, median: 1.0, poor: 2.2 },
      beta: { good: 0.9, median: 1.2, poor: 2.0 },
      currentRatio: { good: 2.0, median: 1.4, poor: 0.8 },
      peRatio: { good: 12, median: 18, poor: 30 },
      fcfMargin: { good: 12, median: 6, poor: -8 }
    }
  },
  Energy: {
    label: 'Energy',
    benchmarks: {
      profitMargin: { good: 15, median: 6, poor: -10 }, // cyclical — commodity price swings hit margins hard
      roe: { good: 18, median: 8, poor: -10 },
      debtEquity: { good: 0.3, median: 0.7, poor: 1.6 },
      beta: { good: 1.0, median: 1.3, poor: 2.2 },
      currentRatio: { good: 1.8, median: 1.2, poor: 0.7 },
      peRatio: { good: 8, median: 12, poor: 22 }, // cyclical, often depressed multiples mid-cycle
      fcfMargin: { good: 15, median: 5, poor: -15 } // capex-heavy, swings hard with commodity cycles
    }
  },
  Utilities: {
    label: 'Utilities',
    benchmarks: {
      profitMargin: { good: 15, median: 10, poor: 0 },
      roe: { good: 12, median: 9, poor: 2 },
      // Regulated utilities are the textbook example of "high debt by design" — rate-of-return
      // regulation and capital-intensive infrastructure make this normal, not risky.
      debtEquity: { good: 0.9, median: 1.4, poor: 2.6 },
      beta: { good: 0.3, median: 0.5, poor: 1.0 },
      currentRatio: { good: 1.2, median: 0.9, poor: 0.5 }, // utilities routinely run current ratio < 1
      peRatio: { good: 14, median: 18, poor: 25 },
      fcfMargin: { good: 8, median: 2, poor: -10 } // constant heavy infrastructure capex keeps FCF thin even when healthy
    }
  },
  'Real Estate': {
    label: 'Real Estate',
    benchmarks: {
      profitMargin: { good: 30, median: 15, poor: -5 },
      roe: { good: 12, median: 7, poor: -5 },
      // REITs carry mortgage-style leverage as a normal part of the business model.
      debtEquity: { good: 0.8, median: 1.5, poor: 3.0 },
      beta: { good: 0.7, median: 1.0, poor: 1.8 },
      currentRatio: { good: 1.5, median: 1.0, poor: 0.5 },
      peRatio: { good: 12, median: 18, poor: 30 }, // FFO multiples run differently, but P/E is used as a rough proxy
      fcfMargin: { good: 15, median: 5, poor: -15 }
    }
  },
  Materials: {
    label: 'Materials',
    benchmarks: {
      profitMargin: { good: 12, median: 6, poor: -8 },
      roe: { good: 18, median: 10, poor: -8 },
      debtEquity: { good: 0.3, median: 0.8, poor: 1.8 },
      beta: { good: 1.0, median: 1.3, poor: 2.2 },
      currentRatio: { good: 2.0, median: 1.4, poor: 0.8 },
      peRatio: { good: 10, median: 15, poor: 25 },
      fcfMargin: { good: 10, median: 4, poor: -12 }
    }
  },
  'Communication Services': {
    label: 'Communication Services',
    benchmarks: {
      profitMargin: { good: 18, median: 8, poor: -10 },
      roe: { good: 20, median: 10, poor: -8 },
      debtEquity: { good: 0.5, median: 1.2, poor: 2.5 }, // telecom infrastructure carries real debt load
      beta: { good: 0.7, median: 1.0, poor: 1.8 },
      currentRatio: { good: 1.5, median: 1.0, poor: 0.6 },
      peRatio: { good: 12, median: 18, poor: 30 },
      fcfMargin: { good: 15, median: 5, poor: -15 } // telecom capex is heavy too
    }
  },
  // Fallback for any Finnhub industry string that doesn't match a keyword below. Values here
  // approximate today's pre-existing flat formulas/thresholds (which had their own internal
  // quirks/discontinuities) so an unmapped industry scores in the same ballpark as current
  // behavior instead of being treated like a specific, possibly wrong, sector.
  Default: {
    label: 'General Market',
    benchmarks: {
      profitMargin: { good: 30, median: 15, poor: -15 }, // approximates old (raw/30)*100 curve
      roe: { good: 30, median: 15, poor: -20 }, // approximates old 40+(roe/30)*60 / 20+roe curve
      debtEquity: { good: 0, median: 1.43, poor: 2.86 }, // matches old 100 - de*35 (0 at de=2.86)
      beta: { good: 1.3, median: 1.3, poor: 3.7 }, // approximates old flat-80-below-1.3 curve
      currentRatio: { good: 2.5, median: 1.0, poor: 0.3 },
      peRatio: { good: 15, median: 20, poor: 35 },
      fcfMargin: { good: 20, median: 8, poor: -20 }
    }
  }
};

// Keyword → sector bucket. Checked in order, first match wins. Finnhub's `finnhubIndustry`
// values aren't a fixed documented enum (they vary in granularity by ticker), so this matches
// on substrings rather than assuming an exact string list.
const KEYWORD_RULES = [
  [/real estate|reit\b/i, 'Real Estate'], // checked before Financials so REITs don't get misrouted to bank/insurance benchmarks
  [/bank|insurance|asset management|capital markets|financial services/i, 'Financials'],
  [/software|semiconductor|hardware|internet|information technology|^technology$/i, 'Technology'],
  [/biotech|pharma|health care|healthcare|medical|life sciences/i, 'Healthcare'],
  [/utilit/i, 'Utilities'],
  [/oil|gas|energy|coal/i, 'Energy'],
  [/chemical|mining|metals|materials|paper|packaging/i, 'Materials'],
  [/telecom|media|communication|broadcast|publishing/i, 'Communication Services'],
  [/grocery|food|beverage|tobacco|household|personal products|staples/i, 'Consumer Staples'],
  [/retail|apparel|auto|leisure|hotel|restaurant|entertainment|discretionary/i, 'Consumer Discretionary'],
  [/industrial|manufactur|aerospace|defense|transport|airline|railroad|machinery|construction/i, 'Industrials']
];

// Resolves a raw Finnhub industry string (e.g. "Software", "Utilities—Regulated Electric",
// "Specialty Retail") to a sector bucket with benchmark reference points.
export function resolveSector(finnhubIndustry) {
  const raw = typeof finnhubIndustry === 'string' ? finnhubIndustry.trim() : '';
  for (const [pattern, key] of KEYWORD_RULES) {
    if (pattern.test(raw)) {
      return { key, label: SECTOR_TABLE[key].label, matched: true, benchmarks: SECTOR_TABLE[key].benchmarks };
    }
  }
  return { key: 'Default', label: SECTOR_TABLE.Default.label, matched: false, benchmarks: SECTOR_TABLE.Default.benchmarks };
}

// Score a raw value lands on once it's past the "poor" reference point, before any hard floor
// is applied — see the big comment on scoreAgainstBenchmark below for why this isn't 0.
const POOR_REFERENCE_SCORE = 20;

// Maps a raw metric value to a 0-100 score using a sector's { good, median, poor } reference
// points, via piecewise-linear interpolation: poor->20, median->50, good->100.
//
// The "good" side hard-clamps at 100 once a value passes "good" — exceptional performance
// maxing out the score is fine, nobody's complained about that direction.
//
// The "poor" side does NOT hard-clamp to 0 the moment a value crosses "poor". A company sitting
// just past the sector's "poor" reference on one metric (e.g. Apple's real debt/equity is a bit
// above the Technology sector's poor threshold, a genuine but non-catastrophic weakness) would
// otherwise score identically to a company in actual financial distress on that same metric —
// both landing on a flat 0. Instead, the same slope from median->poor continues past "poor",
// so being moderately worse than "poor" keeps costing score gradually, and only a value roughly
// 1.5x further past "poor" (measured in the same median-to-poor distance) than "poor" itself
// actually bottoms out at 0. Real distress still zeroes out — it just takes real distress to
// get there, not merely being on the wrong side of a single threshold.
export function scoreAgainstBenchmark(rawValue, triplet, higherIsBetter) {
  if (rawValue == null || !Number.isFinite(rawValue) || !triplet) return null;
  const { good, median, poor } = triplet;

  // lo/mid/hi are the raw-value breakpoints in ascending order, regardless of the metric's
  // real-world direction (handled separately below).
  const [lo, mid, hi] = higherIsBetter ? [poor, median, good] : [good, median, poor];
  const value = rawValue;

  let score;
  if (higherIsBetter) {
    if (value >= hi) score = 100;
    else if (value >= mid) score = 50 + ((value - mid) / (hi - mid)) * 50;
    else {
      const slope = (50 - POOR_REFERENCE_SCORE) / (mid - lo);
      score = POOR_REFERENCE_SCORE + (value - lo) * slope;
    }
  } else {
    // lo=good (smallest raw value), hi=poor (largest raw value) — smaller is better
    if (value <= lo) score = 100;
    else if (value <= mid) score = 100 - ((value - lo) / (mid - lo)) * 50;
    else {
      const slope = (50 - POOR_REFERENCE_SCORE) / (hi - mid);
      score = POOR_REFERENCE_SCORE - (value - hi) * slope;
    }
  }
  return Math.max(0, Math.min(100, score));
}
