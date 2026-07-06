// Shared helper for in-app notifications, used by api/check-market-alerts.js's two
// check routines (price alerts + watchlist moves). Rows are only ever created here,
// via the service-role key — there's no client-side insert policy on the table.

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';

export async function createNotification(serviceRoleKey, { userId, type, ticker, companyName, title, body }) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        user_id: userId,
        type,
        ticker,
        company_name: companyName || null,
        title,
        body
      })
    });
    return res.ok;
  } catch {
    // Non-fatal: a missed in-app notification shouldn't block the rest of the cron run
    return false;
  }
}

// Used to avoid re-notifying the same user about the same ticker's daily move on
// consecutive cron runs. Fails OPEN (returns false, i.e. "no recent notification") on
// a query error — worst case is one extra notification, not a silently missed one.
export async function hasRecentNotification(serviceRoleKey, userId, ticker, type, windowHours = 20) {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/notifications?select=id&user_id=eq.${userId}&ticker=eq.${encodeURIComponent(ticker)}&type=eq.${type}&created_at=gte.${since}&limit=1`,
      { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return rows.length > 0;
  } catch {
    return false;
  }
}
