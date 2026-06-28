export const config = { runtime: 'edge' };

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

  const { messages, systemPrompt } = await req.json();

  if (!messages || !systemPrompt) {
    return new Response(JSON.stringify({ error: 'Missing messages or systemPrompt' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Cap conversation length to avoid abuse
  const recentMessages = messages.slice(-10);

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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

  const data = await groqRes.json();
  const reply = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';

  return new Response(JSON.stringify({ reply }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
