// Shared helper for verifying a caller's Supabase session token (their normal login JWT,
// not an APEX API key) — used by any serverless function that needs to know which logged-in
// user is making the request (api/generate-api-key.js, api/record-referral.js, api/convert-referral.js).

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
// Public/publishable key — same one already embedded client-side in index.html, not a secret.
// Exported so other server-side modules (e.g. api/chat.js) can query Supabase's REST API on
// behalf of a logged-in user with their own session token, respecting RLS, without needing the
// service-role key.
export const SUPABASE_ANON_KEY = 'sb_publishable_8mmrVblH7FPjx_n0z515JA_QIGON0BO';

export async function getUserFromSessionToken(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function getBearerToken(req) {
  const authHeader = req.headers.get('authorization') || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
}
