export const config = { runtime: 'edge' };

import { fetchFreshAnalysis } from '../lib/rescan.js';
import { createNotification } from '../lib/notifications.js';
import { generateDigestNarrative, hasDigestContent, buildStockCalls } from '../lib/portfolioDigest.js';

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SCORE_HISTORY_LOOKBACK_MS = 8 * 24 * 60 * 60 * 1000; // slightly over a week, so last week's
                                                            // earliest snapshot is reliably included
                                                            // even if a cron run landed a few hours late
const MOVER_THRESHOLD = 5;            // out of 100 — smaller than check-market-alerts.js's 8pt alert
                                       // threshold on purpose: a WEEKLY digest should surface more
                                       // gradual drift than a single day-over-day alert would catch
const TOP_MOVERS_PER_USER = 3;
const MAX_DIGEST_TICKERS_PER_USER = 25; // defensive cap, same spirit as check-market-alerts.js's
                                         // MAX_TICKERS_PER_RESCAN_RUN — this is an early-stage app
                                         // with modest per-user watchlist/portfolio volume today

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

// Dedupes a ticker that appears in both watchlist and portfolio_holdings (first occurrence wins
// — the two rows' scores should already match, since both are kept in sync by the same daily
// check-market-alerts.js cron).
function dedupeTickerRows(rows) {
  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.ticker)) seen.set(r.ticker, r);
  }
  return [...seen.values()];
}

// "Biggest movers this week" — reads lib/scoreHistory.js's snapshots directly rather than
// re-scanning any ticker, per the task's own instruction to reuse the historical data now being
// collected. score_history is global per-ticker (not user-scoped — see that file's own comment),
// so this one query serves every user tracking any of these tickers.
async function fetchScoreHistoryDeltas(serviceRoleKey, tickers) {
  if (!tickers.length) return {};
  const since = new Date(Date.now() - SCORE_HISTORY_LOOKBACK_MS).toISOString();
  const tickerList = tickers.map(t => encodeURIComponent(t)).join(',');
  let rows;
  try {
    rows = await supabaseSelect(
      serviceRoleKey,
      `score_history?select=ticker,score,snapshot_at&ticker=in.(${tickerList})&snapshot_at=gte.${since}&order=snapshot_at.asc`
    );
  } catch (e) {
    console.error('Score history query failed:', e.message);
    return {};
  }
  const byTicker = {};
  for (const row of rows) {
    if (typeof row.score !== 'number') continue;
    // Rows arrive oldest-first (order=snapshot_at.asc) — the first one seen per ticker is the
    // earliest snapshot in the window, the last one seen is the latest.
    if (!byTicker[row.ticker]) byTicker[row.ticker] = { earliest: row, latest: row };
    else byTicker[row.ticker].latest = row;
  }
  const deltas = {};
  for (const [ticker, { earliest, latest }] of Object.entries(byTicker)) {
    if (earliest === latest) continue; // need at least 2 distinct snapshots to compute a delta
    deltas[ticker] = { scoreFrom: earliest.score, scoreTo: latest.score, delta: latest.score - earliest.score };
  }
  return deltas;
}

// The digest's email content: a 2-sentence AI summary (lib/portfolioDigest.js) of what happened
// this week, plus a deterministic per-stock Buy/Hold/Avoid call for every tracked ticker.
// Sector-average and upcoming-earnings sections were deliberately dropped — filler relative to
// these two.
function digestNarrativeSection(narrative) {
  if (!narrative) return '';
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${escapeHtml(narrative)}</p>`;
}

function stockCallColor(call) {
  return call === 'Buy' ? '#1a7f37' : call === 'Avoid' ? '#c92b25' : '#8a6d00';
}

function stockCallsSection(stockCalls) {
  if (!stockCalls.length) return '';
  const rows = stockCalls.map(c => `<li style="margin:0 0 6px;font-size:14px;">
    <strong>${escapeHtml(c.ticker)}</strong> (${escapeHtml(c.companyName)}) —
    <span style="color:${stockCallColor(c.call)};font-weight:600;">${escapeHtml(c.call)}</span>
  </li>`).join('');
  return `<div style="margin:0 0 12px;">
    <div style="font-size:13px;font-weight:600;color:#555;margin-bottom:8px;">This week's calls</div>
    <ul style="margin:0;padding-left:18px;">${rows}</ul>
  </div>
  <p style="margin:0;font-size:11px;color:#888;line-height:1.5;">Signals reflect APEX's own scoring model at the time of this email — not personalized investment advice.</p>`;
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

// Runs every Monday at 9am (see vercel.json crons) — the same slot this cron already had; no new
// cron slot added (Vercel Hobby caps this project at 2, both already spoken for by this file and
// api/check-market-alerts.js). For every registered user, aggregates owner-mode scan trend,
// watchlist signal drift, price alerts triggered in the past week, score movers, and red-flag/
// insider activity into a 2-sentence AI summary (lib/portfolioDigest.js), plus a deterministic
// per-stock Buy/Hold/Avoid call for every tracked ticker — no sector-average or upcoming-earnings
// filler. Delivered in-app unconditionally when there's anything to report; email is the
// nice-to-have layered on top if Resend is configured.
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

  let usersChecked = 0, emailsSent = 0, digestsCreated = 0;

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
    // Also records every ticker's freshly re-scanned signal (not just the ones that changed)
    // into freshSignalByTicker, so section 4's per-stock Buy/Hold/Avoid calls use this week's
    // live signal for watchlist tickers instead of the (up to a week stale) DB column.
    const signalChanges = [];
    const freshSignalByTicker = {};
    try {
      const watchlist = await supabaseSelect(
        serviceRoleKey,
        `watchlist?select=ticker,company_name,signal,safety_score,score&user_id=eq.${user.id}`
      );
      for (const row of watchlist) {
        const fresh = await fetchFreshSignal(origin, row.ticker, row.company_name);
        if (!fresh) continue;
        freshSignalByTicker[row.ticker] = fresh.signal;
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

    // ── 4. Score movers (from score_history), new red flags/insider activity, and a per-stock
    // Buy/Hold/Avoid call for every tracked ticker. This doesn't re-scan anything beyond what
    // section 2 already did for watchlist tickers — reads score_history snapshots, existing
    // red_flag notifications, and each ticker's `signal` column (portfolio_holdings' own, or
    // section 2's freshly re-scanned value for watchlist tickers).
    let movers = [], redFlagEvents = [], stockCalls = [];
    try {
      const [watchlistForDigest, portfolioForDigest] = await Promise.all([
        supabaseSelect(serviceRoleKey, `watchlist?select=ticker,company_name,score,signal&user_id=eq.${user.id}`),
        supabaseSelect(serviceRoleKey, `portfolio_holdings?select=ticker,company_name,score,signal&user_id=eq.${user.id}`)
      ]);
      const tickerRows = dedupeTickerRows([...watchlistForDigest, ...portfolioForDigest]).slice(0, MAX_DIGEST_TICKERS_PER_USER);

      if (tickerRows.length) {
        const tickers = tickerRows.map(r => r.ticker);
        const [deltas, redFlagNotifs] = await Promise.all([
          fetchScoreHistoryDeltas(serviceRoleKey, tickers),
          supabaseSelect(serviceRoleKey, `notifications?select=ticker,company_name,title,body&user_id=eq.${user.id}&type=eq.red_flag&created_at=gte.${sevenDaysAgo}`).catch(() => [])
        ]);

        movers = tickerRows
          .map(r => deltas[r.ticker] ? { ticker: r.ticker, companyName: r.company_name, ...deltas[r.ticker] } : null)
          .filter(m => m && Math.abs(m.delta) >= MOVER_THRESHOLD)
          .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
          .slice(0, TOP_MOVERS_PER_USER);

        redFlagEvents = redFlagNotifs;
        stockCalls = buildStockCalls(tickerRows, freshSignalByTicker);
      }
    } catch (e) {
      console.error('Portfolio digest data aggregation failed for user', user.id, e.message);
    }

    // ── 5. Summary synthesis: ONE Groq call (lib/portfolioDigest.js, same Groq→OpenRouter
    // fallback as the rest of APEX Agent) weaves score trend, signal changes, triggered alerts,
    // movers, and red flags into a 2-sentence "week in review." The per-stock Buy/Hold/Avoid
    // calls from section 4 are deterministic (no AI) and appended separately, both in-app and
    // in the email. Delivered in-app unconditionally (below) — email inclusion (further below)
    // is the nice-to-have layered on top.
    let digestNarrative = null;
    try {
      const digestCtx = { scoreTrend, signalChanges, triggeredAlerts, movers, redFlagEvents, stockCalls };
      if (hasDigestContent(digestCtx)) {
        digestNarrative = await generateDigestNarrative(digestCtx);
        const callsText = stockCalls.length
          ? `\n\nThis week's calls:\n${stockCalls.map(c => `${c.ticker} (${c.companyName}): ${c.call}`).join('\n')}`
          : '';
        const created = await createNotification(serviceRoleKey, {
          userId: user.id,
          type: 'weekly_digest',
          ticker: 'PORTFOLIO', // sentinel: this alert spans multiple holdings, not one ticker —
                                // every other notification type always has a real ticker, and
                                // the column's nullability isn't known from this environment,
                                // so a non-null placeholder is the safer default
          companyName: null,
          title: 'Your weekly portfolio digest',
          body: digestNarrative + callsText
        });
        if (created) digestsCreated++;
      }
    } catch (e) {
      console.error('Digest narrative generation failed for user', user.id, e.message);
    }

    if (!digestNarrative) continue;
    if (!resendKey) continue;

    try {
      const sent = await sendDigestEmail(resendKey, user.email, [digestNarrativeSection(digestNarrative), stockCallsSection(stockCalls)]);
      if (sent) emailsSent++;
    } catch {
      // Non-fatal: this user just misses this week's digest
    }
  }

  return new Response(JSON.stringify({ usersChecked, emailsSent, digestsCreated }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
