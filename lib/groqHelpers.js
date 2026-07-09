// Shared Groq/JSON helpers used by both the private-business scan path (api/analyze.js) and
// the public-stock scan path (lib/stockAnalysis.js), plus the Agent checklist/digest features
// and the compare/portfolio verdict endpoints — kept here so none of those files have to
// duplicate this logic or import from each other (which would create circular imports).
//
// FALLBACK PROVIDER: Groq is the default/primary provider — this behaves exactly as it always
// has when Groq is healthy. Cerebras (an OpenAI-compatible alternative, https://api.cerebras.ai/v1)
// is used ONLY when Groq specifically returns a 429 (rate limited) — never for other failure
// types, since a malformed request or a genuine outage would fail identically on Cerebras and
// falling back there would just mask the real problem instead of surfacing it. Added because
// Groq's paid Developer tier upgrade has been temporarily unavailable while testing regularly
// hits the free tier's rate limit. Set CEREBRAS_API_KEY to enable the fallback; if it's unset (or
// the fallback attempt itself fails), a Groq 429 behaves exactly as it did before this existed —
// the fallback is additive, never a required dependency.
//
// Cerebras model: verified live against https://api.cerebras.ai/public/v1/models on 2026-07-09 —
// Cerebras's current free-tier catalog no longer includes ANY Llama model (rotated out at some
// point after older docs/blog posts described "llama-3.3-70b" being available there). gpt-oss-120b
// is the closest available match: production-stable (not "preview" like zai-glm-4.7), explicitly
// supports response_format: json_object (required below, unlike gemma-4-31b which is more of a
// vision/multimodal model), and a comparable parameter count to Groq's current 70B model.
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const CEREBRAS_MODEL = 'gpt-oss-120b';
const JSON_SYSTEM_PROMPT = 'You return only valid JSON. Never include markdown formatting, code fences, or explanation text outside the JSON object.';

async function requestJsonCompletion(url, apiKey, model, prompt) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: JSON_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      temperature: 0.4,
      response_format: { type: 'json_object' }
    })
  });
}

// Best-effort: returns the parsed JSON object on success, or null on ANY failure (missing key,
// network error, non-ok response, empty/malformed content) — a failed fallback attempt falls
// through to the normal Groq-429 error response below, it never throws.
async function tryCerebrasFallback(prompt) {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await requestJsonCompletion('https://api.cerebras.ai/v1/chat/completions', apiKey, CEREBRAS_MODEL, prompt);
    if (!res.ok) {
      const errText = await res.text().catch(() => `HTTP ${res.status}`);
      console.error('Cerebras fallback request failed:', res.status, errText);
      return null;
    }
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) {
      console.error('Cerebras fallback returned an empty response');
      return null;
    }
    return JSON.parse(raw);
  } catch (e) {
    console.error('Cerebras fallback request threw:', e.message);
    return null;
  }
}

// Shared helper: sends a prompt to Groq, expects back a JSON object, and wraps it in a Response.
// Falls back to Cerebras ONLY on a Groq 429 (see module comment above) — every other code path
// (success, non-429 errors, malformed responses) is byte-for-byte unchanged from before this
// fallback existed.
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
    groqRes = await requestJsonCompletion('https://api.groq.com/openai/v1/chat/completions', apiKey, GROQ_MODEL, prompt);
  } catch (fetchErr) {
    console.error('Groq fetch failed:', fetchErr.message);
    return new Response(JSON.stringify({ error: 'Could not reach Groq API' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (groqRes.status === 429) {
    console.error('Groq rate-limited (429) — attempting Cerebras fallback');
    const fallbackParsed = await tryCerebrasFallback(prompt);
    if (fallbackParsed) {
      console.error('Cerebras fallback succeeded — serving this response instead of Groq');
      if (typeof postProcess === 'function') postProcess(fallbackParsed);
      return new Response(JSON.stringify(fallbackParsed), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    console.error('Cerebras fallback unavailable or failed — falling through to the standard Groq rate-limit error');
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
