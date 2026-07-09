// Public-stock scan logic — extracted out of api/analyze.js so it can be called from both
// the web app's /api/analyze endpoint and the external /api/v1/scan endpoint without
// duplicating this (fairly large) function.

import { callGroqForJson, clampIndustryPercentiles, sanitizeRiskTimeline } from './groqHelpers.js';
import { computeRedFlags, getFcfMarginSeries } from './redFlags.js';
import { resolveSector } from './sectorBenchmarks.js';
import { computeSubScores, computeOverallScore } from './subScores.js';
import { fetchNextEarningsDate } from './earnings.js';
import { setCachedPeerScan } from './peerCache.js';

// Resolves Finnhub's peers list into a short list of named competitors for the
// "Compare with another stock" cards. Fetches a couple extra peer profiles beyond
// the 4 needed in case some tickers don't resolve to a company name.
async function fetchCompetitors(symbol, finnhubKey) {
  try {
    const peersRes = await fetch(`https://finnhub.io/api/v1/stock/peers?symbol=${symbol}&token=${finnhubKey}`);
    if (!peersRes.ok) return [];
    const peers = await peersRes.json();
    const peerTickers = [...new Set(
      (Array.isArray(peers) ? peers : [])
        .map(p => String(p).toUpperCase())
        .filter(p => p && p !== symbol)
    )].slice(0, 6);

    const profiles = await Promise.all(peerTickers.map(async (peerSymbol) => {
      try {
        const profRes = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${peerSymbol}&token=${finnhubKey}`);
        if (!profRes.ok) return null;
        const prof = await profRes.json();
        if (!prof || !prof.name) return null;
        return { ticker: peerSymbol, companyName: prof.name };
      } catch {
        return null;
      }
    }));

    return profiles.filter(Boolean).slice(0, 4);
  } catch {
    return [];
  }
}

// ── PUBLIC STOCK ANALYSIS ──
// Pulls real financials from Finnhub first, then feeds them into the AI prompt.
// This means the analysis is grounded in actual current data, not AI memory.
export async function handleStockAnalysis(ticker, companyName) {
  const finnhubKey = process.env.FINNHUB_API_KEY;
  const symbol = ticker.toUpperCase();

  // US exchanges only (NYSE/NASDAQ) — Finnhub represents non-US listings with a dot-suffixed
  // symbol (e.g. "005930.KS", "7203.T", "MC.PA", "0700.HK"), so a plain symbol with no dot is
  // the signal a listing is US-based. Checked here (not just in the search dropdown) so a
  // hand-typed ticker or a direct /api/v1/scan call can't bypass the restriction.
  if (symbol.includes('.')) {
    return new Response(JSON.stringify({ error: 'Only US-listed stocks (NYSE, NASDAQ) are currently supported. International tickers like this one aren\'t supported yet.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!finnhubKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration: FINNHUB_API_KEY is not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Fetch real data from Finnhub in parallel — quote, company profile, metrics, and insider activity
  // (financials/reported was fetched here previously but never used — dropped to cut Finnhub call volume)
  let quote = null, profile = null, metrics = null, insiderTx = null;

  // Kicked off now (not awaited) so the peer/competitor lookups overlap with the rest of
  // this function's work instead of adding their own serial round-trip at the end.
  const competitorsPromise = fetchCompetitors(symbol, finnhubKey);
  const earningsPromise = fetchNextEarningsDate(finnhubKey, symbol);

  try {
    const [quoteRes, profileRes, metricsRes, insiderRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${symbol}&token=${finnhubKey}`)
    ]);

    [quote, profile, metrics, insiderTx] = await Promise.all([
      quoteRes.ok ? quoteRes.json() : null,
      profileRes.ok ? profileRes.json() : null,
      metricsRes.ok ? metricsRes.json() : null,
      insiderRes.ok ? insiderRes.json() : null
    ]);
  } catch (fetchErr) {
    console.error('Finnhub fetch failed:', fetchErr.message);
    return new Response(JSON.stringify({ error: 'Could not reach market data provider' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // If Finnhub doesn't recognize the ticker, company won't have a name
  if (!profile || !profile.name) {
    return new Response(JSON.stringify({
      score: 0,
      status: 'Do Not Invest',
      summary: `"${symbol}" could not be found as a recognized public company ticker. Please check the symbol and try again.`,
      badge: 'Unknown ticker',
      metrics: [],
      industryComparison: [],
      costCuts: [{ title: 'Ticker not recognized', desc: 'Verify the ticker symbol is correct and listed on a major exchange.', color: 'red' }],
      isPublicStock: true,
      stockAnalysis: {
        valuation: { verdict: 'Unknown', detail: 'No market data available for this ticker.', color: 'red' },
        momentum: { trend: 'Unknown', detail: 'No market data available for this ticker.', color: 'red' },
        dividend: { paysDividend: false, yield: 'Unknown', detail: 'No market data available for this ticker.' },
        signal: 'Sell',
        safetyScore: 0,
        verdict: 'Ticker not recognized — cannot assess as an investment.'
      },
      insiderSentiment: {
        sentiment: 'No Data',
        summary: 'No market data available for this ticker.',
        netShares: 0,
        buyCount: 0,
        sellCount: 0,
        recentTransactions: []
      },
      fixImpact: 'N/A',
      riskTimeline: [],
      redFlags: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Format real data into readable context for the AI
  const companyDisplay = profile.name || companyName || symbol;
  const industry = profile.finnhubIndustry || profile.gsector || 'Unknown';
  const sector = resolveSector(industry);
  const country = profile.country || 'US';
  const marketCap = profile.marketCapitalization ? `$${(profile.marketCapitalization / 1000).toFixed(1)}B` : 'Unknown';
  const employees = profile.employeeTotal ? profile.employeeTotal.toLocaleString() : 'Unknown';
  const exchange = profile.exchange || 'Unknown';
  const ipo = profile.ipo || 'Unknown';

  // Price: try live price, then previous close, then estimate from market cap/shares
  const livePrice = quote?.c && quote.c > 0 ? quote.c : null;
  const prevClose = quote?.pc && quote.pc > 0 ? quote.pc : null;
  const priceFromCap = (profile.marketCapitalization && profile.shareOutstanding && profile.shareOutstanding > 0)
    ? (profile.marketCapitalization / profile.shareOutstanding)
    : null;
  const rawPrice = livePrice || prevClose || priceFromCap;
  const currentPrice = rawPrice ? `$${rawPrice.toFixed(2)}` : 'Unknown';
  const priceNote = livePrice ? 'live' : prevClose ? 'previous close' : priceFromCap ? 'estimated from market cap' : 'unavailable';
  const priceChange = quote?.dp ? `${quote.dp.toFixed(2)}%` : 'Unknown';

  // Key financial metrics from Finnhub — with fallback field names, since Finnhub doesn't
  // consistently populate the same variant (TTM vs Annual vs Quarterly) for every ticker.
  // Using nullish coalescing (not ||) so a legitimate value of 0 isn't mistaken for "missing".
  const m = metrics?.metric || {};
  const nz = (...keys) => {
    for (const k of keys) {
      const v = m[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  };

  const peRaw = nz('peNormalizedAnnual', 'peTTM', 'peBasicExclExtraTTM', 'peExclExtraAnnual', 'peInclExtraTTM');
  const peRatio = peRaw != null ? peRaw.toFixed(1) : 'Unknown';
  const epsRaw = nz('epsNormalizedAnnual', 'epsTTM', 'epsInclExtraItemsTTM', 'epsExclExtraItemsAnnual');
  const eps = epsRaw != null ? `$${epsRaw.toFixed(2)}` : 'Unknown';
  // Revenue growth from Finnhub free tier is unreliable — use EPS and price return instead
  const revenueGrowth = 'N/A (see EPS trend below)';
  const yearReturnRaw = nz('52WeekPriceReturnDaily');
  const yearReturn = yearReturnRaw != null ? `${yearReturnRaw.toFixed(1)}%` : 'Unknown';
  const profitMarginRaw = nz('netProfitMarginAnnual', 'netProfitMarginTTM', 'pretaxMarginAnnual', 'pretaxMarginTTM');
  const profitMargin = profitMarginRaw != null ? `${profitMarginRaw.toFixed(1)}%` : 'Unknown';
  const debtEquityRaw = nz('totalDebt/totalEquityAnnual', 'totalDebt/totalEquityQuarterly', 'longtermDebt/equityAnnual', 'longtermDebt/equityQuarterly');
  const debtEquity = debtEquityRaw != null ? debtEquityRaw.toFixed(2) : 'Unknown';
  // ROE: Finnhub's field name for this varies by plan/ticker
  const roeRaw = nz('roeTTM', 'roeRfy', 'roeAnnual', 'roe5Y');
  const roe = roeRaw != null ? `${roeRaw.toFixed(1)}%` : 'Unknown';
  const currentRatioRaw = nz('currentRatioAnnual', 'currentRatioQuarterly');
  const currentRatio = currentRatioRaw != null ? currentRatioRaw.toFixed(2) : 'Unknown';
  // Latest-quarter FCF margin — same already-percentage-scaled series lib/redFlags.js reads for
  // its FCF-decline check (getFcfMarginSeries() converts Finnhub's raw decimal-fraction series
  // values, e.g. 0.24, to percentage points, e.g. 24 — see that function's comment), reused here
  // (not a second Finnhub call) so Financial Health can weigh real cash-generation capacity
  // alongside the balance-sheet snapshot ratios above. Feeds the sub-score only; redFlags.js
  // keeps computing its own trend check independently from the same series.
  const fcfMarginRaw = getFcfMarginSeries(metrics)?.[0]?.v ?? null;
  const fcfMargin = fcfMarginRaw != null ? `${fcfMarginRaw.toFixed(1)}%` : 'Unknown';
  const betaRaw = nz('beta');
  const beta = betaRaw != null ? betaRaw.toFixed(2) : 'Unknown';
  const high52Raw = nz('52WeekHigh');
  const low52Raw = nz('52WeekLow');
  const high52 = high52Raw != null ? `$${high52Raw.toFixed(2)}` : 'Unknown';
  const low52 = low52Raw != null ? `$${low52Raw.toFixed(2)}` : 'Unknown';

  // Valuation multiples — pulled from the same metrics endpoint, no extra API call needed
  const pbRaw = nz('pbAnnual', 'pbQuarterly');
  const pbRatio = pbRaw != null ? pbRaw.toFixed(2) : 'Unknown';
  const psRaw = nz('psAnnual', 'psTTM', 'psQuarterly');
  const psRatio = psRaw != null ? psRaw.toFixed(2) : 'Unknown';

  // Dividend data — pulled from the same metrics endpoint, no extra API call needed
  const dividendYieldRaw = nz('dividendYieldIndicatedAnnual', 'currentDividendYieldTTM');
  const dividendPerShareRaw = nz('dividendPerShareAnnual');
  const paysDividend = !!(dividendYieldRaw || dividendPerShareRaw);
  const dividendYield = dividendYieldRaw ? `${dividendYieldRaw.toFixed(2)}%` : 'None';
  const dividendPerShare = dividendPerShareRaw ? `$${dividendPerShareRaw.toFixed(2)}` : 'None';

  // Where the current price sits within its 52-week range, computed directly (not left to the AI)
  const rangePosition = (rawPrice && high52Raw && low52Raw && high52Raw > low52Raw)
    ? Math.round(((rawPrice - low52Raw) / (high52Raw - low52Raw)) * 100)
    : null;
  const rangePositionNote = rangePosition !== null
    ? `${rangePosition}% of the way from its 52-week low to its 52-week high`
    : 'Unknown';

  // Insider sentiment — computed directly from raw transaction records (not left to the AI),
  // limited to open-market buys ('P') and sells ('S') so option grants/gifts don't skew the signal.
  const insiderRecords = (insiderTx?.data || [])
    .filter(t => t.transactionCode === 'P' || t.transactionCode === 'S')
    .sort((a, b) => new Date(b.transactionDate) - new Date(a.transactionDate));

  let insiderNetShares = 0, insiderBuyValue = 0, insiderSellValue = 0, insiderBuyCount = 0, insiderSellCount = 0;
  insiderRecords.forEach(t => {
    const shares = Math.abs(t.change || t.share || 0);
    const value = shares * (t.transactionPrice || 0);
    if (t.transactionCode === 'P') {
      insiderNetShares += shares;
      insiderBuyValue += value;
      insiderBuyCount += 1;
    } else {
      insiderNetShares -= shares;
      insiderSellValue += value;
      insiderSellCount += 1;
    }
  });

  const insiderSentiment = insiderRecords.length === 0
    ? 'No Data'
    : insiderBuyValue > insiderSellValue * 1.2 ? 'Bullish'
    : insiderSellValue > insiderBuyValue * 1.2 ? 'Bearish'
    : 'Neutral';

  const insiderRecentTransactions = insiderRecords.slice(0, 5).map(t => ({
    name: t.name || 'Unknown insider',
    type: t.transactionCode === 'P' ? 'Buy' : 'Sell',
    shares: Math.abs(t.change || t.share || 0).toLocaleString(),
    value: t.transactionPrice ? `$${Math.round(Math.abs(t.change || t.share || 0) * t.transactionPrice).toLocaleString()}` : 'Unknown',
    date: t.transactionDate || 'Unknown'
  }));

  const insiderNote = insiderRecords.length === 0
    ? 'No recent open-market insider buy/sell transactions on record.'
    : `${insiderBuyCount} open-market buy(s) totaling ~$${Math.round(insiderBuyValue).toLocaleString()} vs. ${insiderSellCount} open-market sell(s) totaling ~$${Math.round(insiderSellValue).toLocaleString()} in the most recent filings.`;

  const dataBlock = `
LIVE MARKET DATA (pulled from Finnhub):
Company: ${companyDisplay}
Ticker: ${symbol}
Exchange: ${exchange}
Industry/Sector: ${industry}
Country: ${country}
Market Cap: ${marketCap}
Employees: ${employees}
IPO Date: ${ipo}

Stock Price: ${currentPrice} (${priceNote})
Price Change: ${priceChange}
52-Week High: ${high52}
52-Week Low: ${low52}
52-Week Price Return: ${yearReturn}
Position in 52-Week Range: ${rangePositionNote}

Key Financial Metrics (annual):
- P/E Ratio: ${peRatio} (note: compare against ${industry} sector norms, not the broad market average)
- Price/Book Ratio: ${pbRatio}
- Price/Sales Ratio: ${psRatio}
- EPS (Earnings Per Share): ${eps}
- Net Profit Margin: ${profitMargin} (typical ${sector.label} range: ~${sector.benchmarks.profitMargin.poor}% to ${sector.benchmarks.profitMargin.good}%, median ~${sector.benchmarks.profitMargin.median}%)
- Debt/Equity Ratio: ${debtEquity} (typical ${sector.label} range: ~${sector.benchmarks.debtEquity.good} to ${sector.benchmarks.debtEquity.poor}, median ~${sector.benchmarks.debtEquity.median})
- Return on Equity (ROE): ${roe} (typical ${sector.label} range: ~${sector.benchmarks.roe.poor}% to ${sector.benchmarks.roe.good}%, median ~${sector.benchmarks.roe.median}%)
- Current Ratio: ${currentRatio} (typical ${sector.label} range: ~${sector.benchmarks.currentRatio.poor} to ${sector.benchmarks.currentRatio.good}, median ~${sector.benchmarks.currentRatio.median})
- Beta (volatility vs market): ${beta} (typical ${sector.label} range: ~${sector.benchmarks.beta.good} to ${sector.benchmarks.beta.poor}, median ~${sector.benchmarks.beta.median})

Dividend Data:
- Pays a Dividend: ${paysDividend ? 'Yes' : 'No'}
- Dividend Yield: ${dividendYield}
- Dividend Per Share (annual): ${dividendPerShare}

Insider Trading Activity (recent open-market buys/sells by executives and directors):
- ${insiderNote}
- Computed sentiment: ${insiderSentiment}
`.trim();

  const prompt = `You are a financial due-diligence analyst helping a retail investor decide whether to buy stock in a public company. The person reading this report is deciding whether to buy shares. Be balanced and accurate — neither overly optimistic nor pessimistic.

CRITICAL INSTRUCTION: Always evaluate metrics relative to the company's specific INDUSTRY and SECTOR, not against generic market averages. For example:
- A P/E of 30-40 is normal for large-cap technology companies — do NOT flag this as a red flag for a tech company
- High debt/equity can be normal in capital-intensive industries
- Compare profitability, growth, and valuation against SECTOR PEERS, not the S&P 500 average
- Consider market cap and company maturity — a $1T+ company growing at 5-10% is healthy, not alarming

You have REAL, LIVE market data pulled directly from Finnhub. Base your entire analysis on these real numbers.

${dataBlock}

Return ONLY valid JSON, no preamble, no markdown fences, nothing else, in EXACTLY this shape:

{
  "score": <integer 0-100, overall investment safety score — calibrated to the company's sector and size, higher means safer>,
  "status": <"Safe" | "Moderate Risk" | "High Risk" | "Do Not Invest">,
  "summary": <1-2 sentence balanced plain-English summary grounded in the actual numbers, mentioning specific figures and comparing to sector norms>,
  "badge": <short 2-4 word badge reflecting the most important characteristic, e.g. "Strong margins" or "Sector leader">,
  "metrics": [
    { "label": "Current Price", "value": "${currentPrice}", "type": "up"|"down"|"warn", "trend": "<note on price vs 52-week range of ${low52}–${high52}>" },
    { "label": "P/E Ratio", "value": "${peRatio}", "type": "up"|"down"|"warn", "trend": "<is this reasonable for the ${industry} sector specifically?>" },
    { "label": "Profit Margin", "value": "${profitMargin}", "type": "up"|"down"|"warn", "trend": "<is this strong or weak for ${industry}?>" },
    { "label": "52-Week Return", "value": "${yearReturn}", "type": "up"|"down"|"warn", "trend": "<how has the stock performed vs the broader market over the past year?>" }
  ],
  "industryComparison": [
    { "metric": "Debt/Equity", "percentile": <integer 0-100 — where this company's debt/equity of ${debtEquity} ranks among typical ${industry} peers; 100 means best-in-class (lowest risk), 0 means worst>, "summary": "<one natural sentence, e.g. 'Debt levels here are lower than 70% of ${industry} companies.' or 'This company carries more debt than 80% of ${industry} peers.'>", "color": "grn"|"amb"|"red" },
    { "metric": "Return on Equity", "percentile": <integer 0-100 — where ROE of ${roe} ranks among typical ${industry} peers>, "summary": "<one natural sentence, e.g. 'ROE is in the top 25% of ${industry} companies.'>", "color": "grn"|"amb"|"red" },
    { "metric": "Volatility (Beta)", "percentile": <integer 0-100 — where beta of ${beta} ranks among typical ${industry} peers; 100 means most stable/least volatile>, "summary": "<one natural sentence, e.g. 'This stock is more volatile than 60% of ${industry} peers.'>", "color": "grn"|"amb"|"red" }
  ],
  "costCuts": [
    { "title": "<#1 most meaningful risk for an investor in this specific company — be accurate, not alarmist>", "desc": "<1 sentence explaining what this means and what to monitor>", "color": "red"|"amb"|"grn" },
    { "title": "<2nd risk or consideration>", "desc": "<explanation>", "color": "red"|"amb"|"grn" },
    { "title": "<3rd risk or positive factor worth noting>", "desc": "<explanation>", "color": "red"|"amb"|"grn" }
  ],
  "isPublicStock": true,
  "dataSource": "Live data via Finnhub",
  "stockAnalysis": {
    "valuation": {
      "verdict": <"Cheap" | "Fair" | "Expensive">,
      "detail": "<1-2 sentences on whether the P/E of ${peRatio} (and Price/Book of ${pbRatio}, Price/Sales of ${psRatio} if useful) looks cheap or expensive specifically vs typical ${industry} peers>",
      "color": "grn"|"amb"|"red"
    },
    "momentum": {
      "trend": "<short phrase, e.g. 'Near 52-week high' | 'Mid-range' | 'Near 52-week low'>",
      "detail": "<1-2 sentences on the 52-week return of ${yearReturn} and where the price sits in its 52-week range (${rangePositionNote}, between low ${low52} and high ${high52})>",
      "color": "grn"|"amb"|"red"
    },
    "dividend": {
      "paysDividend": ${paysDividend},
      "yield": "${dividendYield}",
      "detail": "<if paysDividend is true, 1 sentence on whether the ${dividendYield} yield is attractive/sustainable for this sector; if false, 1 short sentence noting the company does not pay a dividend and whether that's a concern or normal (e.g. growth-stage reinvestment)>"
    },
    "signal": <"Buy" | "Hold" | "Sell", your recommendation combining valuation and momentum>,
    "safetyScore": <integer 0-100 — a score SEPARATE from the business health score above. This measures how attractive the STOCK is as an investment AT ITS CURRENT PRICE right now (valuation + momentum + dividend), not the underlying business quality. 0-40 means Sell, 41-65 means Hold, 66-100 means Buy>,
    "verdict": "<one punchy sentence combining business quality with current stock attractiveness, e.g. 'Strong business but the stock looks overvalued right now' or 'Solid business trading at a fair price with room to grow'>"
  },
  "insiderSentiment": {
    "summary": "<1-2 sentences interpreting what the insider buying/selling activity (${insiderNote}) suggests about executive confidence — do not restate the raw numbers, interpret them>"
  },
  "fixImpact": "<short phrase estimating how much the overall business-health score could move if the #1 risk above (costCuts[0]) were resolved, e.g. '+10-15 points' or 'Could move from Moderate Risk to Safe'>",
  "riskTimeline": [
    { "risk": "<short name of the most time-sensitive risk, e.g. 'Valuation correction' or 'Margin compression'>", "timeframe": "<specific and concrete, e.g. '3-6 months' or 'within 12 months'>", "detail": "<1 sentence grounded in the actual P/E ${peRatio}, debt/equity ${debtEquity}, momentum, or earnings trend above explaining why it becomes a concern in that timeframe>", "severity": "red"|"amb"|"grn" },
    { "risk": "<2nd most time-sensitive risk>", "timeframe": "<specific>", "detail": "<1 sentence>", "severity": "red"|"amb"|"grn" },
    { "risk": "<3rd most time-sensitive risk, or a positive/stable outlook if nothing else is urgent>", "timeframe": "<specific>", "detail": "<1 sentence>", "severity": "red"|"amb"|"grn" }
  ]
}

Rules:
- Be sector-calibrated. A well-known S&P 500 company with strong margins and positive EPS should NOT score below 60 without genuinely serious risk factors.
- Use the actual numbers provided — do not invent figures.
- CRITICAL: Do NOT default to a "safe middle" score (e.g. always landing near 65-75) regardless of the company. Actually weigh the specific numbers given: a company with negative profit margin, a deeply negative 52-week return, or a negative P/E is in real distress and should score well below 50 — potentially below 30 if multiple signals are bad. A company with strong margins, positive ROE, reasonable debt, and a healthy price trend should score 75+. Two different companies with different numbers should virtually never land on the same score — if your instinct is to give a similar score to what you'd give a very different company, re-examine the specific numbers above and adjust.
- "stockAnalysis.safetyScore" is independent from the top-level "score" — a company can have a healthy business (high "score") but an unattractive stock price (low "safetyScore") if it looks overvalued, and vice versa.
- If there is no recent insider activity, say so plainly rather than speculating.
- "riskTimeline" items MUST be ordered soonest-first and grounded in the real P/E, debt, momentum, and margin figures given — use specific, concrete timeframes, not vague ones like "eventually" or "long term".
- Return ONLY the JSON object.`;

  const [competitors, nextEarnings] = await Promise.all([competitorsPromise, earningsPromise]);

  // Captured inside the postProcess callback below (once the finalized score/subScores are
  // known) and used just after callGroqForJson returns, to warm the peer comparison cache
  // (lib/peerCache.js) — so this ticker serves other users' peer-comparison tables for free if
  // it later shows up as one of THEIR peers, not just when it's fetched as a peer directly
  // (api/peer-comparison.js).
  let peerCachePayload = null;

  const response = await callGroqForJson(prompt, (parsed) => {
    if (!parsed || typeof parsed !== 'object') return;
    clampIndustryPercentiles(parsed);
    sanitizeRiskTimeline(parsed);

    // Red flag alerts — deterministic threshold checks against data already fetched above,
    // not left to the AI. Always an array (possibly empty) so the frontend can distinguish
    // "checked, all clear" from "this scan predates the feature". Computed before the score
    // below since the sub-score breakdown (and therefore the score itself) rolls this up.
    parsed.redFlags = computeRedFlags({ metricsResponse: metrics, debtToEquity: debtEquityRaw, currentRatio: currentRatioRaw, insiderRecords, sector });

    // The top-level score IS the weighted average of the sub-scores below — see
    // lib/subScores.js's computeOverallScore(). There is no separate, parallel "quality
    // score" formula with its own weights; this is the only place the top-level number
    // comes from, so it's guaranteed to reconcile with what the sub-score breakdown shows.
    // The AI's own free-form "score" field is only used as a last-resort fallback, for the
    // rare ticker with so little Finnhub data that none of the five sub-scores can compute.
    const subScores = computeSubScores({ profitMarginRaw, roeRaw, debtEquityRaw, betaRaw, currentRatioRaw, fcfMarginRaw, peRaw, yearReturnRaw }, sector, parsed.redFlags);
    let score = computeOverallScore(subScores);
    if (score == null) {
      score = Number(parsed.score);
      if (!Number.isFinite(score)) score = 50;
    }

    // Deterministic ceiling on the top-level score: real distress signals cap it regardless
    // of the weighted sub-score average, so an objectively struggling company can't cluster
    // with a healthy one just because its other categories happen to be strong.
    let scoreCeiling = 100;
    if (yearReturnRaw != null && yearReturnRaw <= -50) scoreCeiling = Math.min(scoreCeiling, 30);
    else if (yearReturnRaw != null && yearReturnRaw <= -25) scoreCeiling = Math.min(scoreCeiling, 50);
    if (profitMarginRaw != null && profitMarginRaw < 0) scoreCeiling = Math.min(scoreCeiling, 40);
    if (peRaw != null && peRaw < 0) scoreCeiling = Math.min(scoreCeiling, 45); // negative P/E = losing money
    parsed.score = Math.max(0, Math.min(100, Math.round(Math.min(score, scoreCeiling))));
    parsed.subScores = subScores;

    // Fallback if the AI omits fixImpact, based on the #1 item's own severity color
    if (typeof parsed.fixImpact !== 'string' || !parsed.fixImpact.trim()) {
      const topColor = parsed.costCuts?.[0]?.color;
      parsed.fixImpact = topColor === 'red' ? 'High impact on your score' : topColor === 'amb' ? 'Moderate impact on your score' : 'Worth watching';
    }
    if (!parsed.stockAnalysis || typeof parsed.stockAnalysis !== 'object') parsed.stockAnalysis = {};
    const sa = parsed.stockAnalysis;
    let safetyScore = Number(sa.safetyScore);
    if (!Number.isFinite(safetyScore)) safetyScore = 50;
    safetyScore = Math.max(0, Math.min(100, Math.round(safetyScore)));
    sa.safetyScore = safetyScore;
    // Signal is derived from the score deterministically so it always matches the 0-40/41-65/66-100 bands.
    sa.signal = safetyScore >= 66 ? 'Buy' : safetyScore >= 41 ? 'Hold' : 'Sell';

    // Insider sentiment figures are computed directly from Finnhub data, not left to the AI —
    // only the narrative "summary" field comes from Groq.
    if (!parsed.insiderSentiment || typeof parsed.insiderSentiment !== 'object') parsed.insiderSentiment = {};
    parsed.insiderSentiment.sentiment = insiderSentiment;
    parsed.insiderSentiment.netShares = insiderNetShares;
    parsed.insiderSentiment.buyCount = insiderBuyCount;
    parsed.insiderSentiment.sellCount = insiderSellCount;
    parsed.insiderSentiment.recentTransactions = insiderRecentTransactions;
    if (typeof parsed.insiderSentiment.summary !== 'string') {
      parsed.insiderSentiment.summary = insiderRecords.length === 0
        ? 'No recent open-market insider transactions to analyze.'
        : `Insiders have been net ${insiderSentiment === 'Bullish' ? 'buying' : insiderSentiment === 'Bearish' ? 'selling' : 'mixed'} recently.`;
    }

    // Competitor cards — fetched directly from Finnhub, not left to the AI.
    parsed.competitors = competitors;

    // Next scheduled earnings date, if any — fetched directly from Finnhub (lib/earnings.js),
    // not left to the AI. null when there's no upcoming report within the lookahead window or
    // the Finnhub call failed; the frontend treats that as "don't show this section."
    parsed.nextEarnings = nextEarnings;

    // Raw (unformatted) metric values, additive to the existing curated "metrics" display
    // strings above — needed by callers that compare two scans against each other (e.g. the
    // side-by-side comparison view) and want the actual numbers rather than pre-formatted text.
    parsed.rawMetrics = { peRaw, debtEquityRaw, currentRatioRaw, roeRaw, profitMarginRaw, yearReturnRaw, fcfMarginRaw };

    // Additive field surfacing which sector peer group this score was benchmarked against —
    // see lib/sectorBenchmarks.js. `matched: false` means the Finnhub industry string didn't
    // map to a specific sector and the general-market fallback was used instead.
    parsed.sectorBenchmark = {
      sector: sector.label,
      matched: sector.matched,
      note: `Scored against ${sector.label} sector peers`
    };

    peerCachePayload = { ticker: symbol, companyName: companyDisplay, score: parsed.score, subScores: parsed.subScores, peRatio: peRaw, debtEquity: debtEquityRaw };
  });

  // Best-effort, awaited (not fire-and-forget) since the edge runtime doesn't guarantee
  // background work continues after the response is returned.
  if (peerCachePayload) {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (serviceRoleKey) {
      await setCachedPeerScan(serviceRoleKey, peerCachePayload);
    }
  }

  return response;
}
