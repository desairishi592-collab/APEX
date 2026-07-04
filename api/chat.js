export const config = { runtime: 'edge' };

import { checkAndIncrementIpRateLimit, getClientIp } from '../lib/rateLimit.js';

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
const IP_RATE_LIMIT_MAX_REQUESTS = 20; // per hour, per IP — this is an LLM-backed endpoint with no
                                        // auth requirement, so IP-based limiting guards the shared
                                        // Groq quota the same way /api/analyze does.

// Builds the system prompt SERVER-SIDE from structured scan data — the client used to send a
// fully-formed systemPrompt string directly, which meant anyone could POST an arbitrary system
// prompt and use this as a free, unrestricted LLM proxy unrelated to APEX at all. Now the client
// can only supply the scan data; the actual instructions given to the model are fixed here.
function buildChatContext(data, bizName, mode) {
  const score = data?.score ?? '?';
  const status = data?.status ?? '?';
  const summary = typeof data?.summary === 'string' ? data.summary.slice(0, 1000) : '';
  const metrics = Array.isArray(data?.metrics)
    ? data.metrics.slice(0, 10).map(m => `${m.label}: ${m.value} — ${m.trend}`).join('\n')
    : '';
  const risks = Array.isArray(data?.costCuts)
    ? data.costCuts.slice(0, 10).map(r => `• ${r.title}: ${r.desc}`).join('\n')
    : '';
  const industry = Array.isArray(data?.industryComparison)
    ? data.industryComparison.slice(0, 10).map(i => `• ${i.label}: ${i.value}`).join('\n')
    : '';
  const isStock = !!data?.isPublicStock;
  const safeBizName = typeof bizName === 'string' ? bizName.slice(0, 200) : 'this business';
  const safeMode = mode === 'investor' ? 'investor' : 'owner';

  return `You are APEX AI, a financial analysis assistant embedded in the APEX business health scanner. A user just completed an APEX ${isStock ? 'stock investment' : safeMode === 'investor' ? 'business investment' : 'business health'} scan. Here are the real results:

Company/Business: ${safeBizName}
Score: ${score}/100
Status: ${status}
Summary: ${summary}

Key Metrics:
${metrics}

Risk Breakdown:
${risks}

Industry Comparison:
${industry}

Your job: answer the user's questions about this specific scan in plain, honest English. You can discuss whether it looks like a good investment, what the risks mean, how to think about position sizing given a budget, when to consider selling, what specific metrics mean in context, etc.

Be balanced and data-driven — not overly bullish or bearish. If someone asks how many shares to buy with a specific dollar amount, calculate it from the current price shown in the metrics above.

Keep answers concise — 2-4 sentences. End every response with a brief reminder like: "Keep in mind this is data-driven analysis — make the final call yourself or with a financial advisor you trust." Make it feel natural, not like a legal warning.`;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceRoleKey) {
    const ip = getClientIp(req);
    const rateLimit = await checkAndIncrementIpRateLimit(ip, IP_RATE_LIMIT_MAX_REQUESTS, SUPABASE_URL, serviceRoleKey);
    if (!rateLimit.allowed) {
      return new Response(JSON.stringify({ error: 'Too many requests — please slow down and try again shortly.', retryAfterSeconds: rateLimit.retryAfterSeconds }), {
        status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(rateLimit.retryAfterSeconds) }
      });
    }
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Malformed request body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const { messages, scanData, bizName, mode } = body;
  if (!Array.isArray(messages) || !scanData || typeof scanData !== 'object') {
    return new Response(JSON.stringify({ error: 'Missing messages or scanData' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const systemPrompt = buildChatContext(scanData, bizName, mode);

  // Cap conversation length to avoid abuse, and only pass through well-formed {role, content}
  // pairs with a bounded content length — never trust the shape/size of client-sent messages.
  const recentMessages = messages
    .slice(-10)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));

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
          { role: 'system', content: systemPrompt },
          ...recentMessages
        ],
        temperature: 0.5,
        max_tokens: 300
      })
    });
  } catch (e) {
    console.error('Groq fetch failed:', e.message);
    return new Response(JSON.stringify({ error: 'Could not reach AI provider' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!groqRes.ok) {
    const errText = await groqRes.text().catch(() => '');
    console.error('Groq API error:', groqRes.status, errText);
    return new Response(JSON.stringify({ error: 'AI chat failed' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  const data = await groqRes.json();
  const reply = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';

  return new Response(JSON.stringify({ reply }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
