// Lightweight same-origin defense-in-depth for state-changing, session-authenticated endpoints
// (generate-api-key, record-referral, convert-referral). No endpoint in this app sends a
// permissive Access-Control-Allow-Origin, so a browser already can't read the response from a
// third-party page — this is an extra explicit check on the request itself, not a replacement
// for that. Requests with no Origin header at all (same-origin navigations, curl, server-to-
// server calls, the external API) are NOT rejected here — only a browser sending a mismatched
// Origin is a signal worth blocking.
const ALLOWED_ORIGIN_SUFFIXES = ['apexledge.com', '.vercel.app'];

export function isAllowedOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return ALLOWED_ORIGIN_SUFFIXES.some(suffix => host === suffix || host.endsWith(suffix));
  } catch {
    return false;
  }
}
