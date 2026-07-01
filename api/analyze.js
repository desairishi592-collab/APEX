export const config = { runtime: 'edge' };

function parseMoney(value) {
  const n = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Deterministic payroll ceiling — not left to the AI so the dollar figure is
// reproducible and grounded in the actual numbers, not a language-model guess.
// Combines two independent estimates and takes the more conservative (lower) one:
//   1. A revenue-based rule-of-thumb ratio, scaled by business health.
//   2. A cash-flow-based ceiling: what's left after current expenses and a safety buffer.
function computePayrollSafety(revenue, expenses, score) {
  if (revenue == null || expenses == null || !(revenue > 0)) return null;

  const payrollRatio = score >= 80 ? 0.45 : score >= 60 ? 0.38 : score >= 40 ? 0.28 : 0.18;
  const bufferPct = score >= 80 ? 0.08 : score >= 60 ? 0.12 : score >= 40 ? 0.18 : 0.28;

  const revenueBasedCeiling = revenue * payrollRatio;
  const cashFlowCeiling = Math.max(0, revenue - expenses - (revenue * bufferPct));
  const maxMonthlyPayroll = Math.max(0, Math.round(Math.min(revenueBasedCeiling, cashFlowCeiling) / 50) * 50);

  const explanation = maxMonthlyPayroll > 0
    ? `Based on your $${revenue.toLocaleString('en-US')} monthly revenue, $${expenses.toLocaleString('en-US')} in expenses, and a health score of ${score}/100, this keeps a ${Math.round(bufferPct * 100)}% safety buffer for slow months and unexpected costs.`
    : `Your current expenses leave no safe margin for additional payroll right now — consider reducing costs or growing revenue before committing to new salaries.`;

  return {
    maxMonthlyPayroll,
    maxMonthlyPayrollFormatted: `$${maxMonthlyPayroll.toLocaleString('en-US')}`,
    payrollRatio,
    bufferPct,
    hasSafeMargin: maxMonthlyPayroll > 0,
    explanation
  };
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await req.json();
    const { bizName, industry, revenue, expenses, employees, age, source, mode, subMode, stockTicker, stockCompanyName, fileContent } = body;

    // ── PUBLIC STOCK PATH ──
    if (subMode === 'public') {
      if (!stockTicker) {
        return new Response(JSON.stringify({ error: 'Missing ticker symbol' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return await handleStockAnalysis(stockTicker, stockCompanyName);
    }

    // ── PRIVATE BUSINESS PATH (owner or investor evaluating a private business) ──
    if (!bizName || !industry || !revenue || !expenses || !employees || !age) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const scanMode = mode === 'investor' ? 'investor' : 'owner';

    const personaBlock = scanMode === 'investor'
      ? `You are a financial due-diligence analyst helping a prospective investor decide whether a business is safe to invest in. The person reading this report does NOT run the business — they are deciding whether to put money into it. Write every field from that outside, risk-assessing point of view. Be direct about red flags; don't soften risk for the sake of politeness.`
      : `You are a business financial health analyst helping a business owner understand their own company's financial health and where to cut costs. Write every field directly to the owner, in a practical, actionable tone.`;

    const scoreFraming = scanMode === 'investor'
      ? `"score": <integer 0-100, overall investment safety score — higher means safer to invest>`
      : `"score": <integer 0-100, overall business health>`;

    const statusFraming = scanMode === 'investor'
      ? `"status": <"Safe" | "Moderate Risk" | "High Risk" | "Do Not Invest">`
      : `"status": <"Excellent" | "Healthy" | "At Risk" | "Critical">`;

    const summaryFraming = scanMode === 'investor'
      ? `"summary": <1-2 sentence plain-English summary of whether this looks like a safe investment and why>`
      : `"summary": <1-2 sentence plain-English summary of the business's financial health>`;

    const costCutsFraming = scanMode === 'investor'
      ? `"costCuts": [
    { "title": "<short headline of the #1 biggest red flag an investor should know, e.g. 'Thin cash runway relative to burn rate'>", "desc": "<1 sentence explaining the risk and what to ask the owner before investing>", "color": "red"|"amb"|"grn" },
    { "title": "<2nd biggest risk>", "desc": "<explanation + what to verify>", "color": "red"|"amb"|"grn" },
    { "title": "<3rd biggest risk>", "desc": "<explanation + what to verify>", "color": "red"|"amb"|"grn" }
  ]`
      : `"costCuts": [
    { "title": "<short headline of the #1 biggest cost-cutting opportunity, e.g. 'Reduce subscription software spend'>", "desc": "<1 sentence explaining the cut and estimated monthly savings>", "color": "red"|"amb"|"grn" },
    { "title": "<2nd opportunity>", "desc": "<explanation + estimated savings>", "color": "red"|"amb"|"grn" },
    { "title": "<3rd opportunity>", "desc": "<explanation + estimated savings>", "color": "red"|"amb"|"grn" }
  ]`;

    const payBenchmarkFraming = scanMode === 'investor'
      ? `"payBenchmark": [
    { "role": "<a role likely present given the industry and employee count>", "value": "<is this role paid in a way that signals risk, e.g. 'Underpaying — may signal high turnover risk' or 'In line with industry'>", "color": "grn"|"amb"|"red" },
    { "role": "<another likely role>", "value": "<pay risk assessment>", "color": "grn"|"amb"|"red" },
    { "role": "<another likely role>", "value": "<pay risk assessment>", "color": "grn"|"amb"|"red" }
  ]`
      : `"payBenchmark": [
    { "role": "<a role likely present given the industry and employee count, e.g. 'Store Manager'>", "value": "<industry-typical pay range, e.g. '$48k–$58k/yr — you're paying within range'>", "color": "grn"|"amb"|"red" },
    { "role": "<another likely role>", "value": "<pay assessment>", "color": "grn"|"amb"|"red" },
    { "role": "<another likely role>", "value": "<pay assessment>", "color": "grn"|"amb"|"red" }
  ]`;

    const badgeFraming = scanMode === 'investor'
      ? `"badge": <short 2-4 word badge, e.g. "Cash flow risk" or "Solid fundamentals">`
      : `"badge": <short 2-4 word badge, e.g. "Strong margins" or "Cash flow risk">`;

    const industryComparisonFraming = scanMode === 'investor'
      ? `"industryComparison": [
    { "label": "<a comparison point, e.g. 'Profit margin vs. industry'>", "value": "<how this business compares, e.g. '12% vs. 18% typical — below average'>", "color": "grn"|"amb"|"red" },
    { "label": "<another comparison point, e.g. 'Revenue per employee vs. industry'>", "value": "<comparison>", "color": "grn"|"amb"|"red" },
    { "label": "<another comparison point, e.g. 'Cash runway vs. industry'>", "value": "<comparison>", "color": "grn"|"amb"|"red" }
  ]`
      : `"industryComparison": [
    { "label": "<a comparison point, e.g. 'Profit margin vs. industry'>", "value": "<how this business compares to typical ${industry} businesses, e.g. '12% vs. 18% typical — room to improve'>", "color": "grn"|"amb"|"red" },
    { "label": "<another comparison point, e.g. 'Revenue per employee vs. industry'>", "value": "<comparison>", "color": "grn"|"amb"|"red" },
    { "label": "<another comparison point, e.g. 'Cash runway vs. industry'>", "value": "<comparison>", "color": "grn"|"amb"|"red" }
  ]`;

    const orderingRule = scanMode === 'investor'
      ? `- "costCuts" MUST be ordered with the single biggest/most concerning red flag first — that first item is shown to free users as the headline, so make it the most important thing an investor needs to know.`
      : `- "costCuts" MUST be ordered with the single biggest/most important opportunity first — that first item is shown to free users as the headline, so make it the most actionable one.`;

    const fixImpactFraming = scanMode === 'investor'
      ? `"fixImpact": "<short phrase estimating how much the overall safety score could move if the #1 risk above (costCuts[0]) were resolved, e.g. '+10-15 points' or 'Could move from Moderate Risk to Safe'>"`
      : `"fixImpact": "<short phrase estimating how much the health score could move if the #1 opportunity above (costCuts[0]) were addressed, e.g. '+8-12 points' or 'Could move from At Risk to Healthy'>"`;

    const prompt = `${personaBlock}

Analyze this business and return ONLY valid JSON, no preamble, no markdown fences, nothing else.

Business name: ${bizName}
Industry: ${industry}
Monthly revenue: $${revenue}
Monthly expenses: $${expenses}
Number of employees: ${employees}
Years in business: ${age}
Data source: ${source || 'manual entry'}
${fileContent ? `\nUploaded financial document excerpt (use this to refine and ground your analysis where relevant):\n${fileContent}\n` : ''}
Return JSON in EXACTLY this shape:

{
  ${scoreFraming},
  ${statusFraming},
  ${summaryFraming},
  ${badgeFraming},
  "metrics": [
    { "label": "Cash Runway", "value": "<e.g. '4.2 months'>", "type": "up"|"down"|"warn", "trend": "<short trend note>" },
    { "label": "Burn Rate", "value": "<e.g. '$12,400/mo'>", "type": "up"|"down"|"warn", "trend": "<short trend note>" },
    { "label": "Profit Margin", "value": "<e.g. '18%'>", "type": "up"|"down"|"warn", "trend": "<short trend note>" },
    { "label": "Revenue per Employee", "value": "<e.g. '$8,200/mo'>", "type": "up"|"down"|"warn", "trend": "<short trend note>" }
  ],
  ${payBenchmarkFraming},
  ${industryComparisonFraming},
  ${costCutsFraming},
  ${fixImpactFraming}
}

Rules:
${orderingRule}
- "payBenchmark" should reflect realistic, industry-typical roles for a ${industry} business with ${employees} employees — infer likely roles (e.g. retail: cashier, store manager; restaurant: server, chef; SaaS: engineer, support).
- "industryComparison" should compare this business's actual numbers (derived from the revenue/expenses given) against realistic typical benchmarks for a ${industry} business of similar size — be specific with numbers on both sides of the comparison.
- Base numbers on the revenue, expenses, and employee count given. Be realistic, not generic.
- Return ONLY the JSON object. No explanation, no markdown code fences.`;

    return await callGroqForJson(prompt, (parsed) => {
      if (!parsed || typeof parsed !== 'object') return;
      // Fallback if the AI omits fixImpact, based on the #1 item's own severity color
      if (typeof parsed.fixImpact !== 'string' || !parsed.fixImpact.trim()) {
        const topColor = parsed.costCuts?.[0]?.color;
        parsed.fixImpact = topColor === 'red' ? 'High impact on your score' : topColor === 'amb' ? 'Moderate impact on your score' : 'Worth addressing';
      }
      if (scanMode !== 'owner') return; // payroll safety calculator is an owner-mode feature only
      const revenueNum = parseMoney(revenue);
      const expensesNum = parseMoney(expenses);
      let score = Number(parsed.score);
      if (!Number.isFinite(score)) score = 50;
      parsed.payrollSafety = computePayrollSafety(revenueNum, expensesNum, score);
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'Unexpected server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Shared helper: sends a prompt to Groq, expects back a JSON object, and wraps it in a Response.
async function callGroqForJson(prompt, postProcess) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration: GROQ_API_KEY is not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let groqRes;
  try {
    groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'You return only valid JSON. Never include markdown formatting, code fences, or explanation text outside the JSON object.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.4,
        response_format: { type: 'json_object' }
      })
    });
  } catch (fetchErr) {
    return new Response(JSON.stringify({ error: 'Could not reach Groq API', detail: fetchErr.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!groqRes.ok) {
    let errText;
    try {
      errText = await groqRes.text();
    } catch {
      errText = `HTTP ${groqRes.status}`;
    }
    return new Response(JSON.stringify({ error: 'AI analysis failed', detail: errText }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let groqData;
  try {
    groqData = await groqRes.json();
  } catch (parseErr) {
    return new Response(JSON.stringify({ error: 'Groq returned a non-JSON response', detail: parseErr.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const raw = groqData.choices?.[0]?.message?.content;

  if (!raw) {
    return new Response(JSON.stringify({ error: 'Empty response from AI' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'AI returned invalid JSON', detail: raw.slice(0, 300) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (typeof postProcess === 'function') {
    postProcess(parsed);
  }

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── PUBLIC STOCK ANALYSIS ──
// Pulls real financials from Finnhub first, then feeds them into the AI prompt.
// This means the analysis is grounded in actual current data, not AI memory.
async function handleStockAnalysis(ticker, companyName) {
  const finnhubKey = process.env.FINNHUB_API_KEY;
  const symbol = ticker.toUpperCase();

  if (!finnhubKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration: FINNHUB_API_KEY is not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Fetch real data from Finnhub in parallel — quote, company profile, financials, and insider activity
  let quote = null, profile = null, financials = null, metrics = null, insiderTx = null;

  try {
    const [quoteRes, profileRes, financialsRes, metricsRes, insiderRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/financials/reported?symbol=${symbol}&freq=annual&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${finnhubKey}`),
      fetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${symbol}&token=${finnhubKey}`)
    ]);

    [quote, profile, financials, metrics, insiderTx] = await Promise.all([
      quoteRes.ok ? quoteRes.json() : null,
      profileRes.ok ? profileRes.json() : null,
      financialsRes.ok ? financialsRes.json() : null,
      metricsRes.ok ? metricsRes.json() : null,
      insiderRes.ok ? insiderRes.json() : null
    ]);
  } catch (fetchErr) {
    return new Response(JSON.stringify({ error: 'Could not reach market data provider', detail: fetchErr.message }), {
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
      fixImpact: 'N/A'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Format real data into readable context for the AI
  const companyDisplay = profile.name || companyName || symbol;
  const industry = profile.finnhubIndustry || profile.gsector || 'Unknown';
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

  // Key financial metrics from Finnhub — using correct field names
  const m = metrics?.metric || {};
  const peRatio = m['peNormalizedAnnual'] ? m['peNormalizedAnnual'].toFixed(1) : 'Unknown';
  const eps = m['epsNormalizedAnnual'] ? `$${m['epsNormalizedAnnual'].toFixed(2)}` : 'Unknown';
  // Revenue growth from Finnhub free tier is unreliable — use EPS and price return instead
  const revenueGrowth = 'N/A (see EPS trend below)';
  const yearReturn = m['52WeekPriceReturnDaily'] ? `${m['52WeekPriceReturnDaily'].toFixed(1)}%` : 'Unknown';
  const profitMargin = m['netProfitMarginAnnual'] ? `${m['netProfitMarginAnnual'].toFixed(1)}%` : 'Unknown';
  const debtEquity = m['totalDebt/totalEquityAnnual'] ? m['totalDebt/totalEquityAnnual'].toFixed(2) : 'Unknown';
  // ROE: Finnhub uses 'roeTTM' as the primary field name
  const roeRaw = m['roeTTM'] || m['roeAnnual'] || m['roeRateAnnual'] || null;
  const roe = roeRaw ? `${roeRaw.toFixed(1)}%` : 'Unknown';
  const currentRatio = m['currentRatioAnnual'] ? m['currentRatioAnnual'].toFixed(2) : 'Unknown';
  const beta = m['beta'] ? m['beta'].toFixed(2) : 'Unknown';
  const high52Raw = m['52WeekHigh'] || null;
  const low52Raw = m['52WeekLow'] || null;
  const high52 = high52Raw ? `$${high52Raw.toFixed(2)}` : 'Unknown';
  const low52 = low52Raw ? `$${low52Raw.toFixed(2)}` : 'Unknown';

  // Valuation multiples — pulled from the same metrics endpoint, no extra API call needed
  const pbRatio = m['pbAnnual'] ? m['pbAnnual'].toFixed(2) : 'Unknown';
  const psRatio = m['psAnnual'] ? m['psAnnual'].toFixed(2) : 'Unknown';

  // Dividend data — pulled from the same metrics endpoint, no extra API call needed
  const dividendYieldRaw = m['dividendYieldIndicatedAnnual'] || m['currentDividendYieldTTM'] || null;
  const dividendPerShareRaw = m['dividendPerShareAnnual'] || null;
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
- Net Profit Margin: ${profitMargin}
- Debt/Equity Ratio: ${debtEquity}
- Return on Equity (ROE): ${roe}
- Current Ratio: ${currentRatio}
- Beta (volatility vs market): ${beta}

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
    { "label": "Debt/Equity vs. ${industry} peers", "value": "<${debtEquity} — contextualise this vs typical ${industry} companies>", "color": "grn"|"amb"|"red" },
    { "label": "ROE vs. ${industry} peers", "value": "<${roe} — strong or weak return on equity for this sector?>", "color": "grn"|"amb"|"red" },
    { "label": "Beta vs. market", "value": "<${beta} — how volatile is this vs. the broader market?>", "color": "grn"|"amb"|"red" }
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
  "fixImpact": "<short phrase estimating how much the overall business-health score could move if the #1 risk above (costCuts[0]) were resolved, e.g. '+10-15 points' or 'Could move from Moderate Risk to Safe'>"
}

Rules:
- Be sector-calibrated. A well-known S&P 500 company with strong margins and positive EPS should NOT score below 60 without genuinely serious risk factors.
- Use the actual numbers provided — do not invent figures.
- "stockAnalysis.safetyScore" is independent from the top-level "score" — a company can have a healthy business (high "score") but an unattractive stock price (low "safetyScore") if it looks overvalued, and vice versa.
- If there is no recent insider activity, say so plainly rather than speculating.
- Return ONLY the JSON object.`;

  return await callGroqForJson(prompt, (parsed) => {
    if (!parsed || typeof parsed !== 'object') return;
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
  });
}
