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
const SECTOR_TABLE = {
  Technology: {
    label: 'Technology',
    benchmarks: {
      profitMargin: { good: 25, median: 12, poor: -5 },
      roe: { good: 30, median: 15, poor: -5 },
      debtEquity: { good: 0.1, median: 0.4, poor: 1.2 },
      beta: { good: 0.9, median: 1.3, poor: 2.2 },
      currentRatio: { good: 2.5, median: 1.8, poor: 0.9 }
    }
  },
  Healthcare: {
    label: 'Healthcare',
    benchmarks: {
      profitMargin: { good: 20, median: 8, poor: -15 }, // biotech pre-revenue losses are common
      roe: { good: 20, median: 10, poor: -10 },
      debtEquity: { good: 0.2, median: 0.6, poor: 1.5 },
      beta: { good: 0.7, median: 1.0, poor: 1.8 },
      currentRatio: { good: 3.0, median: 2.0, poor: 1.0 }
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
      currentRatio: { good: 1.5, median: 1.1, poor: 0.7 } // less meaningful for banks, kept lenient
    }
  },
  'Consumer Discretionary': {
    label: 'Consumer Discretionary',
    benchmarks: {
      profitMargin: { good: 12, median: 5, poor: -5 },
      roe: { good: 25, median: 12, poor: -5 },
      debtEquity: { good: 0.3, median: 0.9, poor: 2.0 },
      beta: { good: 0.9, median: 1.2, poor: 2.0 },
      currentRatio: { good: 2.0, median: 1.3, poor: 0.7 }
    }
  },
  'Consumer Staples': {
    label: 'Consumer Staples',
    benchmarks: {
      profitMargin: { good: 10, median: 5, poor: -2 },
      roe: { good: 25, median: 15, poor: 0 },
      debtEquity: { good: 0.4, median: 1.0, poor: 2.2 },
      beta: { good: 0.5, median: 0.7, poor: 1.2 },
      currentRatio: { good: 1.8, median: 1.2, poor: 0.7 }
    }
  },
  Industrials: {
    label: 'Industrials',
    benchmarks: {
      profitMargin: { good: 12, median: 6, poor: -3 },
      roe: { good: 20, median: 12, poor: -5 },
      debtEquity: { good: 0.4, median: 1.0, poor: 2.2 },
      beta: { good: 0.9, median: 1.2, poor: 2.0 },
      currentRatio: { good: 2.0, median: 1.4, poor: 0.8 }
    }
  },
  Energy: {
    label: 'Energy',
    benchmarks: {
      profitMargin: { good: 15, median: 6, poor: -10 }, // cyclical — commodity price swings hit margins hard
      roe: { good: 18, median: 8, poor: -10 },
      debtEquity: { good: 0.3, median: 0.7, poor: 1.6 },
      beta: { good: 1.0, median: 1.3, poor: 2.2 },
      currentRatio: { good: 1.8, median: 1.2, poor: 0.7 }
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
      currentRatio: { good: 1.2, median: 0.9, poor: 0.5 } // utilities routinely run current ratio < 1
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
      currentRatio: { good: 1.5, median: 1.0, poor: 0.5 }
    }
  },
  Materials: {
    label: 'Materials',
    benchmarks: {
      profitMargin: { good: 12, median: 6, poor: -8 },
      roe: { good: 18, median: 10, poor: -8 },
      debtEquity: { good: 0.3, median: 0.8, poor: 1.8 },
      beta: { good: 1.0, median: 1.3, poor: 2.2 },
      currentRatio: { good: 2.0, median: 1.4, poor: 0.8 }
    }
  },
  'Communication Services': {
    label: 'Communication Services',
    benchmarks: {
      profitMargin: { good: 18, median: 8, poor: -10 },
      roe: { good: 20, median: 10, poor: -8 },
      debtEquity: { good: 0.5, median: 1.2, poor: 2.5 }, // telecom infrastructure carries real debt load
      beta: { good: 0.7, median: 1.0, poor: 1.8 },
      currentRatio: { good: 1.5, median: 1.0, poor: 0.6 }
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
      currentRatio: { good: 2.5, median: 1.0, poor: 0.3 }
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

// Maps a raw metric value to a 0-100 score using a sector's { good, median, poor } reference
// points, via piecewise-linear interpolation: poor->0, median->50, good->100, clamped beyond
// either end. `higherIsBetter` picks which direction "good" points.
export function scoreAgainstBenchmark(rawValue, triplet, higherIsBetter) {
  if (rawValue == null || !Number.isFinite(rawValue) || !triplet) return null;
  const { good, median, poor } = triplet;

  // lo/mid/hi are the raw-value breakpoints in ascending order, regardless of the metric's
  // real-world direction (handled separately below).
  const [lo, mid, hi] = higherIsBetter ? [poor, median, good] : [good, median, poor];
  const value = rawValue;

  let score;
  if (higherIsBetter) {
    if (value <= lo) score = 0;
    else if (value >= hi) score = 100;
    else if (value <= mid) score = ((value - lo) / (mid - lo)) * 50;
    else score = 50 + ((value - mid) / (hi - mid)) * 50;
  } else {
    // lo=good (smallest raw value), hi=poor (largest raw value) — smaller is better
    if (value <= lo) score = 100;
    else if (value >= hi) score = 0;
    else if (value <= mid) score = 100 - ((value - lo) / (mid - lo)) * 50;
    else score = 50 - ((value - mid) / (hi - mid)) * 50;
  }
  return Math.max(0, Math.min(100, score));
}
