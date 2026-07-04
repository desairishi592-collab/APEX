// Flat, plan-agnostic rate limiting backed by atomic Postgres RPCs (row-locked
// check-and-increment via `for update`) rather than a non-atomic read-then-write from this
// layer — two concurrent requests from the same key can no longer both slip through the
// same window (previously a real TOCTOU race: both could read the same count before either
// wrote back the increment).

const USER_RATE_LIMIT_MAX_REQUESTS = 20;          // /api/v1/scan, /api/record-referral — per user
const USER_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;   // 1 hour. Conservative on purpose: scan requests
                                                   // also spend from the shared Groq daily token quota.

const IP_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;     // 1 hour, for all IP-keyed (unauthenticated) endpoints

// Extracts the caller's IP from Vercel's forwarded-for header (set by Vercel's edge network
// itself, not attacker-suppliable the way an arbitrary custom header would be).
export function getClientIp(req) {
  const forwardedFor = req.headers.get('x-forwarded-for') || '';
  const ip = forwardedFor.split(',')[0].trim();
  return ip || 'unknown';
}

// Used by authenticated endpoints — keyed by Supabase user id.
export async function checkAndIncrementRateLimit(userId, supabaseUrl, serviceRoleKey, opts = {}) {
  const maxRequests = opts.maxRequests ?? USER_RATE_LIMIT_MAX_REQUESTS;
  const windowSeconds = opts.windowSeconds ?? USER_RATE_LIMIT_WINDOW_SECONDS;
  return callRateLimitRpc(supabaseUrl, serviceRoleKey, 'rate_limit_check_and_increment', {
    p_user_id: userId, p_max_requests: maxRequests, p_window_seconds: windowSeconds
  });
}

// Used by unauthenticated endpoints (/api/analyze, /api/chat, /api/search) — keyed by IP,
// since there's no logged-in user to rate-limit by.
export async function checkAndIncrementIpRateLimit(ip, maxRequests, supabaseUrl, serviceRoleKey) {
  return callRateLimitRpc(supabaseUrl, serviceRoleKey, 'ip_rate_limit_check_and_increment', {
    p_ip: ip, p_max_requests: maxRequests, p_window_seconds: IP_RATE_LIMIT_WINDOW_SECONDS
  });
}

// Returns { allowed: true } or { allowed: false, retryAfterSeconds }. Fails OPEN (allows the
// request) if the RPC itself is unreachable — a rate limiter shouldn't be a single point of
// failure for the whole API.
async function callRateLimitRpc(supabaseUrl, serviceRoleKey, fnName, args) {
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fnName}`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(args)
    });
    if (!res.ok) throw new Error(`${fnName} failed: ${res.status}`);
    const rows = await res.json();
    const row = rows[0];
    return { allowed: !!row?.allowed, retryAfterSeconds: row?.retry_after_seconds || 0 };
  } catch {
    return { allowed: true };
  }
}
