// Shared Groq/JSON helpers used by both the private-business scan path (api/analyze.js) and
// the public-stock scan path (lib/stockAnalysis.js) — kept here so neither file has to
// duplicate them or import from the other (which would create a circular import).

// Shared helper: sends a prompt to Groq, expects back a JSON object, and wraps it in a Response.
export async function callGroqForJson(prompt, postProcess) {
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
    console.error('Groq fetch failed:', fetchErr.message);
    return new Response(JSON.stringify({ error: 'Could not reach Groq API' }), {
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
    console.error('Groq API error:', groqRes.status, errText);
    // A 429 here means our Groq account is temporarily out of capacity (e.g. the daily
    // token quota), not that the scan itself is broken — surface that distinction instead
    // of a generic failure so it isn't mistaken for a code bug on retry. Neither branch
    // leaks Groq's raw error text to the caller — that's logged server-side above instead.
    const message = groqRes.status === 429
      ? 'Our AI analysis provider is temporarily at capacity — please try again in a few minutes.'
      : 'AI analysis failed';
    return new Response(JSON.stringify({ error: message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let groqData;
  try {
    groqData = await groqRes.json();
  } catch (parseErr) {
    console.error('Groq returned non-JSON response:', parseErr.message);
    return new Response(JSON.stringify({ error: 'Groq returned a non-JSON response' }), {
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
    console.error('AI returned invalid JSON:', raw.slice(0, 300));
    return new Response(JSON.stringify({ error: 'AI returned invalid JSON' }), {
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

// Guards against the AI returning a non-numeric or out-of-range percentile.
export function clampIndustryPercentiles(parsed) {
  if (!parsed || !Array.isArray(parsed.industryComparison)) return;
  parsed.industryComparison.forEach(row => {
    if (!row || typeof row !== 'object') return;
    let p = Number(row.percentile);
    if (!Number.isFinite(p)) p = 50;
    row.percentile = Math.max(0, Math.min(100, Math.round(p)));
  });
}

// Normalizes the AI-generated risk timeline into a small, well-formed list — drops
// malformed entries and caps severity to the same red/amb/grn vocabulary used elsewhere,
// so a bad AI response degrades to "no timeline shown" rather than a broken render.
export function sanitizeRiskTimeline(parsed) {
  if (!parsed || !Array.isArray(parsed.riskTimeline)) {
    if (parsed) parsed.riskTimeline = [];
    return;
  }
  parsed.riskTimeline = parsed.riskTimeline
    .filter(item => item && typeof item === 'object' && item.risk && item.timeframe)
    .slice(0, 4)
    .map(item => ({
      risk: String(item.risk).slice(0, 80),
      timeframe: String(item.timeframe).slice(0, 40),
      detail: typeof item.detail === 'string' ? item.detail.slice(0, 300) : '',
      severity: ['red', 'amb', 'grn'].includes(item.severity) ? item.severity : 'amb'
    }));
}
