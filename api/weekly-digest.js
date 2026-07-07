export const config = { runtime: 'edge' };

import { fetchFreshAnalysis } from '../lib/rescan.js';

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// No DOM available in the Edge runtime, so this is a manual escaper (unlike index.html's
// DOM-based one) — used because businessName/companyName/ticker below are all ultimately
// user-supplied (scan/watchlist input) and get embedded directly into an HTML email body.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

// Thin wrapper over the shared re-scan helper (lib/rescan.js, also used by the APEX Agent
// monitoring in api/check-market-alerts.js) — plucks just the fields this digest needs.
async function fetchFreshSignal(origin, ticker, companyName) {
  const data = await fetchFreshAnalysis(origin, ticker, companyName);
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
      <strong>${escapeHtml(trend.businessName)}</strong>: ${trend.previousScore} → ${trend.latestScore}
      <span style="color:${color};font-weight:bold;">${arrow} ${Math.abs(trend.delta)}</span>
    </p>`;
}

function signalChangesSection(changes) {
  if (!changes.length) return '';
  const rows = changes.map(c =>
    `<li><strong>${escapeHtml(c.companyName || c.ticker)} (${escapeHtml(c.ticker)})</strong>: ${escapeHtml(c.oldSignal)} → <strong>${escapeHtml(c.newSignal)}</strong></li>`
  ).join('');
  return `
    <h3 style="margin:24px 0 8px;font-size:16px;">Watchlist signal changes</h3>
    <ul style="margin:0;padding-left:20px;">${rows}</ul>`;
}

function triggeredAlertsSection(alerts) {
  if (!alerts.length) return '';
  const rows = alerts.map(a =>
    `<li><strong>${escapeHtml(a.company_name || a.ticker)} (${escapeHtml(a.ticker)})</strong> hit your target of $${a.target_price}</li>`
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
  // Fail CLOSED (require CRON_SECRET to be configured) rather than silently allowing public
  // access if the env var is ever missing/misconfigured.
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
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
    console.error('Could not list users:', e.message);
    return new Response(JSON.stringify({ error: 'Could not list users' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  let usersChecked = 0, emailsSent = 0;

  for (const user of users) {
    if (!user.email) continue;
    usersChecked++;

    // ── 1. Business health score trend (owner-mode scans only) ──
    let scoreTrend = null;
    try {
      const scans = await supabaseSelect(
        serviceRoleKey,
        `scans?select=business_name,score,created_at&user_id=eq.${user.id}&mode=eq.owner&order=created_at.desc&limit=2`
      );
      if (scans.length >= 2 && typeof scans[0].score === 'number' && typeof scans[1].score === 'number') {
        scoreTrend = {
          businessName: scans[0].business_name || 'Your business',
          latestScore: scans[0].score,
          previousScore: scans[1].score,
          delta: scans[0].score - scans[1].score
        };
      }
    } catch {
      // Non-fatal: skip the trend section for this user this week
    }

    // ── 2. Watchlist signal changes (re-scans each ticker fresh, then updates the baseline) ──
    const signalChanges = [];
    try {
      const watchlist = await supabaseSelect(
        serviceRoleKey,
        `watchlist?select=ticker,company_name,signal,safety_score,score&user_id=eq.${user.id}`
      );
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
    } catch {
      // Non-fatal: skip the signal-change section for this user this week
    }

    // ── 3. Price alerts triggered in the past week ──
    let triggeredAlerts = [];
    try {
      triggeredAlerts = await supabaseSelect(
        serviceRoleKey,
        `price_alerts?select=ticker,company_name,target_price,triggered_at&user_id=eq.${user.id}&status=eq.triggered&triggered_at=gte.${sevenDaysAgo}`
      );
    } catch {
      // Non-fatal: skip the triggered-alerts section for this user this week
    }

    if (!scoreTrend && !signalChanges.length && !triggeredAlerts.length) continue;
    if (!resendKey) continue;

    const sections = [
      scoreTrendSection(scoreTrend),
      signalChangesSection(signalChanges),
      triggeredAlertsSection(triggeredAlerts)
    ];

    try {
      const sent = await sendDigestEmail(resendKey, user.email, sections);
      if (sent) emailsSent++;
    } catch {
      // Non-fatal: this user just misses this week's digest
    }
  }

  return new Response(JSON.stringify({ usersChecked, emailsSent }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
