export const config = { runtime: 'edge' };

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';

async function patchAlert(serviceRoleKey, id, updates) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/price_alerts?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(updates)
    });
  } catch {
    // Non-fatal: a failed status update just means this alert gets re-checked next run
  }
}

async function sendAlertEmail(resendKey, alert, currentPrice) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'APEX Alerts <onboarding@resend.dev>',
      to: alert.email,
      subject: `${alert.ticker} hit your target price of $${alert.target_price}`,
      html: `<p>Good news — <strong>${alert.company_name || alert.ticker} (${alert.ticker})</strong> just hit your target price of <strong>$${alert.target_price}</strong>. It's currently trading at $${currentPrice.toFixed(2)}.</p><p>This might be the entry point you were waiting for.</p>`
    })
  });
  const rawText = await res.text(); // TEMP: surfaced via resendDebug below, remove once email delivery is confirmed
  return { ok: res.ok, status: res.status, raw: rawText.slice(0, 300) };
}

// Runs on a schedule (see vercel.json crons) to check every active price alert against
// the live market price, and emails the user once their target is hit.
export default async function handler(req) {
  // Vercel automatically sends this header on scheduled cron invocations when
  // CRON_SECRET is set — verifying it stops the endpoint being triggered publicly.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${cronSecret}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const finnhubKey = process.env.FINNHUB_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!serviceRoleKey || !finnhubKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY or FINNHUB_API_KEY' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  // TEMP: safe partial reveal to diagnose a key-value mismatch, remove once resolved
  const keyDebug = {
    finnhubKeyLength: finnhubKey.length,
    finnhubKeyPreview: finnhubKey.slice(0, 4) + '...' + finnhubKey.slice(-4),
    finnhubKeyHasWhitespace: /\s/.test(finnhubKey),
    serviceRoleKeyLength: serviceRoleKey.length,
    resendKeySet: !!resendKey
  };

  let alerts;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/price_alerts?select=*&status=eq.active`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
    });
    if (!res.ok) throw new Error(`Supabase query failed: ${res.status}`);
    alerts = await res.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not load alerts', detail: e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!alerts.length) {
    return new Response(JSON.stringify({ checked: 0, tickers: 0, triggered: 0, emailed: 0 }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // One Finnhub call per unique ticker, not per alert, in case multiple users (or
  // multiple alerts) are watching the same stock.
  const tickers = [...new Set(alerts.map(a => a.ticker))];
  const priceByTicker = {};
  const debugTickerInfo = []; // TEMP: remove once the live trigger path is confirmed working
  await Promise.all(tickers.map(async (ticker) => {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${finnhubKey}`);
      const rawText = await res.text();
      let data = null;
      try { data = JSON.parse(rawText); } catch {}
      if (data && typeof data.c === 'number' && data.c > 0) priceByTicker[ticker] = data.c;
      debugTickerInfo.push({ ticker, httpStatus: res.status, ok: res.ok, raw: rawText.slice(0, 300) });
    } catch (e) {
      debugTickerInfo.push({ ticker, fetchError: e.message });
    }
  }));

  let triggeredCount = 0, emailedCount = 0;
  const resendDebug = []; // TEMP: remove once email delivery is confirmed

  for (const alert of alerts) {
    const currentPrice = priceByTicker[alert.ticker];
    if (currentPrice == null) continue; // couldn't get a live price this run
    if (currentPrice > alert.target_price) continue; // hasn't dropped to the target yet

    triggeredCount++;
    const triggeredAt = new Date().toISOString();
    await patchAlert(serviceRoleKey, alert.id, { status: 'triggered', triggered_at: triggeredAt });

    if (resendKey) {
      try {
        const sent = await sendAlertEmail(resendKey, alert, currentPrice);
        resendDebug.push({ alertId: alert.id, ...sent });
        if (sent.ok) {
          emailedCount++;
          await patchAlert(serviceRoleKey, alert.id, { notified_at: new Date().toISOString() });
        }
      } catch (e) {
        resendDebug.push({ alertId: alert.id, sendError: e.message });
        // Non-fatal: alert is still marked triggered so it won't re-fire; email can be retried manually
      }
    }
  }

  return new Response(JSON.stringify({
    checked: alerts.length,
    tickers: tickers.length,
    triggered: triggeredCount,
    emailed: emailedCount,
    debugTickerInfo, // TEMP: remove once the live trigger path is confirmed working
    keyDebug, // TEMP: remove once the live trigger path is confirmed working
    resendDebug // TEMP: remove once email delivery is confirmed
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
