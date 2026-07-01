export const config = { runtime: 'edge' };

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Lists every registered user via the Auth admin API (paginated, service-role only —
// this is how the digest discovers "logged-in users" since email lives on auth.users,
// not on the profiles table).
async function listAllUsers(serviceRoleKey) {
  const users = [];
  let page = 1;
  const perPage = 1000;
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
    });
    if (!res.ok) throw new Error(`Auth admin users query failed: ${res.status}`);
    const data = await res.json();
    const batch = Array.isArray(data) ? data : (data.users || []);
    users.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }
  return users;
}

async function supabaseSelect(serviceRoleKey, path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
  });
  if (!res.ok) throw new Error(`Supabase query failed (${path}): ${res.status}`);
  return res.json();
}

async function upsertWatchlistSignal(serviceRoleKey, userId, ticker, updates) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/watchlist?user_id=eq.${userId}&ticker=eq.${encodeURIComponent(ticker)}`, {
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
    // Non-fatal: the ticker's signal just gets re-diffed against a stale baseline next week
  }
}

// Re-runs the same public-stock analysis the app itself uses, so "signal changed"
// means exactly what the user would see if they re-scanned the ticker themselves.
async function fetchFreshSignal(origin, ticker, companyName) {
  const res = await fetch(`${origin}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subMode: 'public', stockTicker: ticker, stockCompanyName: companyName })
  });
  if (!res.ok) return null;
  const data = await res.json();
  const sa = data?.stockAnalysis;
  if (!sa || !sa.signal) return null;
  return { signal: sa.signal, safetyScore: sa.safetyScore ?? null, score: data.score ?? null };
}

function scoreTrendSection(trend) {
  if (!trend) return '';
  const arrow = trend.delta > 0 ? '▲' : trend.delta < 0 ? '▼' : '—';
  const color = trend.delta > 0 ? '#1a9e5c' : trend.delta < 0 ? '#c0392b' : '#666';
  return `
    <h3 style="margin:24px 0 8px;font-size:16px;">Business health score trend</h3>
    <p style="margin:0 0 4px;">
      <strong>${trend.businessName}</strong>: ${trend.previousScore} → ${trend.latestScore}
      <span style="color:${color};font-weight:bold;">${arrow} ${Math.abs(trend.delta)}</span>
    </p>`;
}

function signalChangesSection(changes) {
  if (!changes.length) return '';
  const rows = changes.map(c =>
    `<li><strong>${c.companyName || c.ticker} (${c.ticker})</strong>: ${c.oldSignal} → <strong>${c.newSignal}</strong></li>`
  ).join('');
  return `
    <h3 style="margin:24px 0 8px;font-size:16px;">Watchlist signal changes</h3>
    <ul style="margin:0;padding-left:20px;">${rows}</ul>`;
}

function triggeredAlertsSection(alerts) {
  if (!alerts.length) return '';
  const rows = alerts.map(a =>
    `<li><strong>${a.company_name || a.ticker} (${a.ticker})</strong> hit your target of $${a.target_price}</li>`
  ).join('');
  return `
    <h3 style="margin:24px 0 8px;font-size:16px;">Triggered price alerts this week</h3>
    <ul style="margin:0;padding-left:20px;">${rows}</ul>`;
}

async function sendDigestEmail(resendKey, email, sections) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'APEX Weekly Digest <onboarding@resend.dev>',
      to: email,
      subject: 'Your weekly APEX digest',
      html: `<div style="font-family:sans-serif;color:#111;max-width:560px;">
        <h2 style="margin:0 0 12px;">Your week on APEX</h2>
        ${sections.join('') || '<p>Nothing new to report this week.</p>'}
      </div>`
    })
  });
  return res.ok;
}

// Runs every Monday at 9am (see vercel.json crons). For every registered user, builds
// a personalized digest from three independent sources — owner-mode scan trend,
// watchlist signal drift, and price alerts triggered in the past week — and emails it
// only if there's actually something to report.
export default async function handler(req) {
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
  const resendKey = process.env.RESEND_API_KEY;

  if (!serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const origin = new URL(req.url).origin;
  const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();

  let users;
  try {
    users = await listAllUsers(serviceRoleKey);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not list users', detail: e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  let usersChecked = 0, emailsSent = 0;
  const debugUsers = []; // TEMP: remove once the live digest path is confirmed working

  for (const user of users) {
    if (!user.email) continue;
    usersChecked++;
    const userDebug = { email: user.email };

    // ── 1. Business health score trend (owner-mode scans only) ──
    let scoreTrend = null;
    try {
      const scans = await supabaseSelect(
        serviceRoleKey,
        `scans?select=business_name,score,created_at&user_id=eq.${user.id}&mode=eq.owner&order=created_at.desc&limit=2`
      );
      userDebug.scanCount = scans.length;
      if (scans.length >= 2 && typeof scans[0].score === 'number' && typeof scans[1].score === 'number') {
        scoreTrend = {
          businessName: scans[0].business_name || 'Your business',
          latestScore: scans[0].score,
          previousScore: scans[1].score,
          delta: scans[0].score - scans[1].score
        };
      }
    } catch (e) {
      userDebug.scanError = e.message;
    }

    // ── 2. Watchlist signal changes (re-scans each ticker fresh, then updates the baseline) ──
    const signalChanges = [];
    try {
      const watchlist = await supabaseSelect(
        serviceRoleKey,
        `watchlist?select=ticker,company_name,signal,safety_score,score&user_id=eq.${user.id}`
      );
      userDebug.watchlistCount = watchlist.length;
      for (const row of watchlist) {
        const fresh = await fetchFreshSignal(origin, row.ticker, row.company_name);
        if (!fresh) continue;
        if (row.signal && fresh.signal !== row.signal) {
          signalChanges.push({ ticker: row.ticker, companyName: row.company_name, oldSignal: row.signal, newSignal: fresh.signal });
        }
        await upsertWatchlistSignal(serviceRoleKey, user.id, row.ticker, {
          signal: fresh.signal, safety_score: fresh.safetyScore, score: fresh.score
        });
      }
    } catch (e) {
      userDebug.watchlistError = e.message;
    }

    // ── 3. Price alerts triggered in the past week ──
    let triggeredAlerts = [];
    try {
      triggeredAlerts = await supabaseSelect(
        serviceRoleKey,
        `price_alerts?select=ticker,company_name,target_price,triggered_at&user_id=eq.${user.id}&status=eq.triggered&triggered_at=gte.${sevenDaysAgo}`
      );
    } catch (e) {
      userDebug.alertsError = e.message;
    }

    userDebug.scoreTrend = scoreTrend;
    userDebug.signalChanges = signalChanges;
    userDebug.triggeredAlerts = triggeredAlerts;

    if (!scoreTrend && !signalChanges.length && !triggeredAlerts.length) {
      userDebug.skipped = 'nothing to report';
      debugUsers.push(userDebug);
      continue;
    }
    if (!resendKey) {
      userDebug.skipped = 'no resend key';
      debugUsers.push(userDebug);
      continue;
    }

    const sections = [
      scoreTrendSection(scoreTrend),
      signalChangesSection(signalChanges),
      triggeredAlertsSection(triggeredAlerts)
    ];

    try {
      const sent = await sendDigestEmail(resendKey, user.email, sections);
      userDebug.sent = sent;
      if (sent) emailsSent++;
    } catch (e) {
      userDebug.sendError = e.message;
    }
    debugUsers.push(userDebug);
  }

  return new Response(JSON.stringify({ usersChecked, emailsSent, debugUsers }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
