export const config = { runtime: 'edge' };

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
  ${costCutsFraming}
}

Rules:
${orderingRule}
- "payBenchmark" should reflect realistic, industry-typical roles for a ${industry} business with ${employees} employees — infer likely roles (e.g. retail: cashier, store manager; restaurant: server, chef; SaaS: engineer, support).
- "industryComparison" should compare this business's actual numbers (derived from the revenue/expenses given) against realistic typical benchmarks for a ${industry} business of similar size — be specific with numbers on both sides of the comparison.
- Base numbers on the revenue, expenses, and employee count given. Be realistic, not generic.
- Return ONLY the JSON object. No explanation, no markdown code fences.`;

    return await callGroqForJson(prompt);

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'Unexpected server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Shared helper: sends a prompt to Groq, expects back a JSON object, and wraps it in a Response.
async function callGroqForJson(prompt) {
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

  return new Response(JSON.stringify(parsed), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

// ── PUBLIC STOCK ANALYSIS ──
// Different from the private-business path: no revenue/expenses/employees are typed in by the
// user, since a public company's financials are (in theory) already public. The AI works from
// its own training knowledge of the company rather than user-provided numbers.
async function handleStockAnalysis(ticker, companyName) {
  const displayName = companyName ? `${companyName} (${ticker.toUpperCase()})` : ticker.toUpperCase();

  const prompt = `You are a financial due-diligence analyst helping a prospective investor decide whether to buy stock in a public company. The person reading this report is deciding whether to buy shares — they are an outside investor, not company management. Be direct about red flags; don't soften risk for the sake of politeness.

You do NOT have access to live market data. Base your analysis on your general knowledge of this company from training data, and be clear that figures may be approximate or outdated. Do not invent precise real-time figures (like today's stock price) — if you don't know a number with confidence, describe it qualitatively instead (e.g. "historically strong margins" rather than a fabricated precise percentage).

Company to analyze: ${displayName}

Return ONLY valid JSON, no preamble, no markdown fences, nothing else, in EXACTLY this shape:

{
  "score": <integer 0-100, overall investment safety score based on what you know of this company's fundamentals, stability, and risk — higher means safer to invest>,
  "status": <"Safe" | "Moderate Risk" | "High Risk" | "Do Not Invest">,
  "summary": <1-2 sentence plain-English summary of whether this looks like a safe investment and why, based on known fundamentals>,
  "badge": <short 2-4 word badge, e.g. "Cash flow risk" or "Solid fundamentals">,
  "metrics": [
    { "label": "Business Stability", "value": "<qualitative assessment, e.g. 'Established, low volatility'>", "type": "up"|"down"|"warn", "trend": "<short trend note>" },
    { "label": "Growth Trend", "value": "<qualitative assessment>", "type": "up"|"down"|"warn", "trend": "<short trend note>" },
    { "label": "Competitive Position", "value": "<qualitative assessment>", "type": "up"|"down"|"warn", "trend": "<short trend note>" },
    { "label": "Known Risk Factors", "value": "<qualitative assessment>", "type": "up"|"down"|"warn", "trend": "<short trend note>" }
  ],
  "industryComparison": [
    { "label": "<a comparison point vs. industry peers>", "value": "<qualitative comparison>", "color": "grn"|"amb"|"red" },
    { "label": "<another comparison point>", "value": "<qualitative comparison>", "color": "grn"|"amb"|"red" },
    { "label": "<another comparison point>", "value": "<qualitative comparison>", "color": "grn"|"amb"|"red" }
  ],
  "costCuts": [
    { "title": "<short headline of the #1 biggest red flag or risk an investor should know about this company>", "desc": "<1 sentence explaining the risk and what to research further before investing>", "color": "red"|"amb"|"grn" },
    { "title": "<2nd biggest risk>", "desc": "<explanation + what to verify>", "color": "red"|"amb"|"grn" },
    { "title": "<3rd biggest risk>", "desc": "<explanation + what to verify>", "color": "red"|"amb"|"grn" }
  ],
  "isPublicStock": true
}

Rules:
- "costCuts" MUST be ordered with the single biggest/most concerning risk first — that first item is shown to free users as the headline.
- If this is not a real, recognizable public company, set "score" to 0, "status" to "Do Not Invest", and explain in "summary" that the company/ticker could not be identified.
- Return ONLY the JSON object. No explanation, no markdown code fences.`;

  return await callGroqForJson(prompt);
}
