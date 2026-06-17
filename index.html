export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    return new Response(JSON.stringify({ error: 'API key not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await req.json();
    const { bizName, industry, revenue, age, source, fileContent } = body;

    const prompt = `You are APEX, an expert business health analyst AI. Analyze the business below and return ONLY a raw JSON object — no markdown, no backticks, no explanation. Just the JSON.

Business name: ${bizName || 'This Business'}
Industry: ${industry || 'General'}
Monthly revenue: $${revenue || 'not provided'}
Years in business: ${age || 'not provided'}
Data source: ${source || 'manual entry'}
${fileContent ? 'Financial data:\n' + fileContent.slice(0, 2000) : ''}

Return exactly this structure:
{
  "score": <integer 0-100>,
  "status": "<Critical|Poor|Fair|Good|Excellent>",
  "summary": "<2 sentences about overall business health>",
  "badge": "<short note like 'First scan — baseline set' or '+4 pts from industry avg'>",
  "metrics": [
    {"label": "Cash runway", "value": "<X mo>", "trend": "<short note>", "type": "<up|down|warn>"},
    {"label": "Monthly revenue", "value": "$<amount>", "trend": "<short note>", "type": "<up|down|warn>"},
    {"label": "Burn rate", "value": "$<amount>", "trend": "<short note>", "type": "<up|down|warn>"},
    {"label": "Gross margin", "value": "<X%>", "trend": "<short note>", "type": "<up|down|warn>"}
  ],
  "insights": [
    {"title": "<issue>", "desc": "<2 sentence explanation>", "level": "<danger|warn|good>"},
    {"title": "<issue>", "desc": "<2 sentence explanation>", "level": "<danger|warn|good>"},
    {"title": "<issue>", "desc": "<2 sentence explanation>", "level": "<danger|warn|good>"}
  ],
  "cash": [
    {"label": "<label>", "value": "<value>", "color": "<red|grn|amb|>"},
    {"label": "<label>", "value": "<value>", "color": "<red|grn|amb|>"},
    {"label": "<label>", "value": "<value>", "color": "<red|grn|amb|>"},
    {"label": "<label>", "value": "<value>", "color": "<red|grn|amb|>"},
    {"label": "<label>", "value": "<value>", "color": "<red|grn|amb|>"}
  ],
  "expenses": [
    {"label": "<category>", "value": "<amount>", "color": "<red|grn|amb|>"},
    {"label": "<category>", "value": "<amount>", "color": "<red|grn|amb|>"},
    {"label": "<category>", "value": "<amount>", "color": "<red|grn|amb|>"},
    {"label": "<category>", "value": "<amount>", "color": "<red|grn|amb|>"},
    {"label": "<category>", "value": "<amount>", "color": "<red|grn|amb|>"}
  ],
  "risk": [
    {"label": "<risk factor>", "value": "<status>", "color": "<red|grn|amb|>"},
    {"label": "<risk factor>", "value": "<status>", "color": "<red|grn|amb|>"},
    {"label": "<risk factor>", "value": "<status>", "color": "<red|grn|amb|>"},
    {"label": "<risk factor>", "value": "<status>", "color": "<red|grn|amb|>"},
    {"label": "<risk factor>", "value": "<status>", "color": "<red|grn|amb|>"}
  ]
}`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + groqKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1400,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!groqRes.ok) {
      const err = await groqRes.json();
      return new Response(JSON.stringify({ error: err.error?.message || 'Groq error' }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      });
    }

    const data = await groqRes.json();
    const raw = data.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
