export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const { bizName, industry, revenue, expenses, employees, age, source, mode } = await req.json();

    if (!bizName || !industry || !revenue || !expenses || !employees || !age) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
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
  ${costCutsFraming}
}

Rules:
${orderingRule}
- "payBenchmark" should reflect realistic, industry-typical roles for a ${industry} business with ${employees} employees — infer likely roles (e.g. retail: cashier, store manager; restaurant: server, chef; SaaS: engineer, support).
- Base numbers on the revenue, expenses, and employee count given. Be realistic, not generic.
- Return ONLY the JSON object. No explanation, no markdown code fences.`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
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

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return new Response(JSON.stringify({ error: 'AI analysis failed', detail: errText }), { status: 502 });
    }

    const groqData = await groqRes.json();
    const raw = groqData.choices?.[0]?.message?.content;

    if (!raw) {
      return new Response(JSON.stringify({ error: 'Empty response from AI' }), { status: 502 });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'AI returned invalid JSON' }), { status: 502 });
    }

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'Unexpected server error' }), { status: 500 });
  }
}
