export const config = { runtime: 'edge' };

import { createNotification, hasRecentNotification } from '../lib/notifications.js';
import { fetchFreshAnalysis } from '../lib/rescan.js';
import { runScoreMonitor } from '../lib/scoreMonitor.js';
import { recordScoreSnapshots } from '../lib/scoreHistory.js';

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
const WATCHLIST_MOVE_THRESHOLD_PCT = 5;
// A full re-score is an LLM + several Finnhub calls per ticker — much heavier than the price-only
// checks below. This is an early-stage app with modest watchlist/portfolio volume today, but this
// cap is a defensive circuit breaker against a runaway cron if that ever changes.
const MAX_TICKERS_PER_RESCAN_RUN = 40;

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
  return res.ok;
}

// Batches one Finnhub quote call per unique ticker across BOTH price_alerts and
// watchlist rows, so a ticker present in both tables only costs one Finnhub call.
async function fetchQuotes(finnhubKey, tickers) {
  const priceByTicker = {};
  await Promise.all(tickers.map(async (ticker) => {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${finnhubKey}`);
      const data = await res.json();
      if (data && typeof data.c === 'number' && data.c > 0) {
        priceByTicker[ticker] = { price: data.c, percentChange: typeof data.dp === 'number' ? data.dp : null };
      }
    } catch {
      // Non-fatal: this ticker just gets re-checked next run
    }
  }));
  return priceByTicker;
}

// Checks every active price alert against its ticker's live price. Unchanged from the
// original check-price-alerts.js logic, except it now also creates an in-app
// notification alongside the existing email when an alert triggers. Rows are fetched once by
// the handler (alongside watchlist/portfolio rows) rather than queried again here.
async function checkPriceAlerts(serviceRoleKey, resendKey, priceByTicker, alerts) {
  let triggeredCount = 0, emailedCount = 0, notifiedCount = 0;

  for (const alert of alerts) {
    const quote = priceByTicker[alert.ticker];
    if (!quote) continue; // couldn't get a live price this run
    if (quote.price > alert.target_price) continue; // hasn't dropped to the target yet

    triggeredCount++;
    const triggeredAt = new Date().toISOString();
    await patchAlert(serviceRoleKey, alert.id, { status: 'triggered', triggered_at: triggeredAt });

    const created = await createNotification(serviceRoleKey, {
      userId: alert.user_id,
      type: 'price_alert',
      ticker: alert.ticker,
      companyName: alert.company_name,
      title: `${alert.ticker} hit your target price of $${alert.target_price}`,
      body: `${alert.company_name || alert.ticker} is now trading at $${quote.price.toFixed(2)}.`
    });
    if (created) notifiedCount++;

    if (resendKey) {
      try {
        const sent = await sendAlertEmail(resendKey, alert, quote.price);
        if (sent) {
          emailedCount++;
          await patchAlert(serviceRoleKey, alert.id, { notified_at: new Date().toISOString() });
        }
      } catch {
        // Non-fatal: alert is still marked triggered so it won't re-fire; email can be retried manually
      }
    }
  }

  return { checked: alerts.length, triggered: triggeredCount, emailed: emailedCount, notified: notifiedCount };
}

// Checks every watchlist row for a >5% single-day move (Finnhub's quote `dp` field is
// already the percent change vs previous close, so no historical price storage is
// needed). In-app notification only — no email for this trigger. Rows are fetched once by the
// handler (alongside price-alert/portfolio rows) rather than queried again here.
async function checkWatchlistMoves(serviceRoleKey, priceByTicker, rows) {
  let movedCount = 0, notifiedCount = 0;

  for (const row of rows) {
    const quote = priceByTicker[row.ticker];
    if (!quote || quote.percentChange == null) continue;
    if (Math.abs(quote.percentChange) < WATCHLIST_MOVE_THRESHOLD_PCT) continue;

    movedCount++;
    const alreadyNotified = await hasRecentNotification(serviceRoleKey, row.user_id, row.ticker, 'watchlist_move');
    if (alreadyNotified) continue;

    const sign = quote.percentChange > 0 ? '+' : '';
    const created = await createNotification(serviceRoleKey, {
      userId: row.user_id,
      type: 'watchlist_move',
      ticker: row.ticker,
      companyName: row.company_name,
      title: `${row.ticker} moved ${sign}${quote.percentChange.toFixed(1)}% today`,
      body: `${row.company_name || row.ticker} is now trading at $${quote.price.toFixed(2)}.`
    });
    if (created) notifiedCount++;
  }

  return { checked: rows.length, moved: movedCount, notified: notifiedCount };
}

// Runs on a schedule (see vercel.json crons). Folded into one daily invocation rather
// than a separate cron entry — Vercel's Hobby plan caps a project at 2 cron jobs, and
// this repo already has 2 (this one + weekly-digest), so a 3rd risked a silent deploy
// failure. Price alerts + watchlist moves share one batched Finnhub quote fetch across
// their tickers; the APEX Agent score/red-flag monitoring below shares one re-scan per
// unique ticker across watchlist + portfolio holdings, same dedup principle.
export default async function handler(req) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get('authorization');
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const finnhubKey = process.env.FINNHUB_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!serviceRoleKey || !finnhubKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY or FINNHUB_API_KEY' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Full rows fetched once here (rather than inside each check function) so the new score/red-flag
  // monitoring below can reuse the same watchlist/portfolio rows without a second query.
  let alertRows, watchlistRows, portfolioRows;
  try {
    [alertRows, watchlistRows, portfolioRows] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/price_alerts?select=*&status=eq.active`, {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
      }).then(r => r.ok ? r.json() : []),
      fetch(`${SUPABASE_URL}/rest/v1/watchlist?select=*`, {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
      }).then(r => r.ok ? r.json() : []),
      fetch(`${SUPABASE_URL}/rest/v1/portfolio_holdings?select=user_id,ticker,company_name,score,safety_score,signal`, {
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
      }).then(r => r.ok ? r.json() : [])
    ]);
  } catch (e) {
    console.error('Could not load ticker lists:', e.message);
    return new Response(JSON.stringify({ error: 'Could not load ticker lists' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  const allTickers = [...new Set([...alertRows.map(r => r.ticker), ...watchlistRows.map(r => r.ticker), ...portfolioRows.map(r => r.ticker)])];
  const priceByTicker = allTickers.length ? await fetchQuotes(finnhubKey, allTickers) : {};

  const [priceAlerts, watchlistMoves] = await Promise.all([
    checkPriceAlerts(serviceRoleKey, resendKey, priceByTicker, alertRows),
    checkWatchlistMoves(serviceRoleKey, priceByTicker, watchlistRows)
  ]);

  // APEX Agent: periodic re-score + red-flag check for watchlist/portfolio holdings, on top of
  // the price-only checks above. Isolated in its own try/catch so a failure here (e.g. Groq
  // temporarily down) can't take down the already-working price alerts/watchlist moves.
  let scoreChanges = { checked: 0, notified: 0 };
  let scoreHistory = { inserted: 0 };
  try {
    const origin = new URL(req.url).origin;
    const uniqueTickers = [...new Set([...watchlistRows.map(r => r.ticker), ...portfolioRows.map(r => r.ticker)])]
      .slice(0, MAX_TICKERS_PER_RESCAN_RUN);

    const freshByTicker = {};
    const companyNameByTicker = {};
    await Promise.all(uniqueTickers.map(async (ticker) => {
      const sourceRow = watchlistRows.find(r => r.ticker === ticker) || portfolioRows.find(r => r.ticker === ticker);
      companyNameByTicker[ticker] = sourceRow?.company_name ?? null;
      const fresh = await fetchFreshAnalysis(origin, ticker, sourceRow?.company_name);
      if (fresh) freshByTicker[ticker] = fresh;
    }));

    const [watchlistScoreChanges, portfolioScoreChanges] = await Promise.all([
      runScoreMonitor(serviceRoleKey, SUPABASE_URL, 'watchlist', watchlistRows, freshByTicker),
      runScoreMonitor(serviceRoleKey, SUPABASE_URL, 'portfolio_holdings', portfolioRows, freshByTicker)
    ]);
    scoreChanges = {
      checked: watchlistScoreChanges.checked + portfolioScoreChanges.checked,
      notified: watchlistScoreChanges.notified + portfolioScoreChanges.notified
    };

    // Foundational history capture for future features (weekly digest trend lines, score-vs-price
    // divergence detection, a backtest view) — reuses the same freshByTicker data computed above,
    // so this is a DB write only, no new Finnhub/Groq calls. Its own try/catch so a failure here
    // can't take down the score-change alerts that already succeeded this run.
    try {
      scoreHistory = await recordScoreSnapshots(serviceRoleKey, SUPABASE_URL, freshByTicker, companyNameByTicker);
    } catch (e) {
      console.error('Score history snapshot failed:', e.message);
      scoreHistory = { inserted: 0, error: 'Score history snapshot failed' };
    }
  } catch (e) {
    console.error('Score monitoring failed:', e.message);
    scoreChanges = { checked: 0, notified: 0, error: 'Score monitoring failed' };
  }

  return new Response(JSON.stringify({ priceAlerts, watchlistMoves, scoreChanges, scoreHistory }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
