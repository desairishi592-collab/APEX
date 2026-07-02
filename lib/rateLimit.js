// Flat, plan-agnostic rate limiting for the external scan API (api/v1/scan.js). Backed by a
// small Supabase table rather than in-memory counters — an Edge Function has no reliable
// shared memory across invocations/regions, so a DB-backed counter is the simplest correct
// option given the current stack (no Redis/KV in use elsewhere in this app).

const RATE_LIMIT_MAX_REQUESTS = 20;              // requests allowed per window, per user (flat — no plan tiers in v1)
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;     // 1 hour fixed window. Conservative on purpose: every request
                                                  // here also spends from the shared Groq daily token quota.

// Returns { allowed: true } or { allowed: false, retryAfterSeconds }. Fails OPEN (allows the
// request) if the rate-limit table itself is unreachable — a rate limiter shouldn't be a
// single point of failure for the whole API.
export async function checkAndIncrementRateLimit(userId, supabaseUrl, serviceRoleKey) {
  let existing;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/api_rate_limits?select=window_start,request_count&user_id=eq.${userId}`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
    });
    if (!res.ok) throw new Error(`rate limit lookup failed: ${res.status}`);
    const rows = await res.json();
    existing = rows[0] || null;
  } catch {
    return { allowed: true };
  }

  const now = Date.now();
  const windowExpired = !existing || (now - new Date(existing.window_start).getTime()) > RATE_LIMIT_WINDOW_MS;

  if (windowExpired) {
    await upsertRateLimitRow(userId, supabaseUrl, serviceRoleKey, { window_start: new Date(now).toISOString(), request_count: 1 });
    return { allowed: true };
  }

  if (existing.request_count >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSeconds = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - new Date(existing.window_start).getTime())) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  await upsertRateLimitRow(userId, supabaseUrl, serviceRoleKey, { request_count: existing.request_count + 1 });
  return { allowed: true };
}

async function upsertRateLimitRow(userId, supabaseUrl, serviceRoleKey, updates) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/api_rate_limits`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ user_id: userId, ...updates })
    });
  } catch {
    // Non-fatal: worst case this request's count doesn't stick and the window resets a bit later than ideal
  }
}
