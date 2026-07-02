export const config = { runtime: 'edge' };

import { generateApiKey } from '../lib/apiKeys.js';

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
// Public/publishable key — same one already embedded client-side in index.html, not a secret.
const SUPABASE_ANON_KEY = 'sb_publishable_8mmrVblH7FPjx_n0z515JA_QIGON0BO';

// Verifies the caller's Supabase session token (their normal login JWT — not an APEX API
// key) and returns the authenticated user, or null if the token is missing/invalid.
async function getUserFromSessionToken(token, anonKey) {
  if (!token) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Generates (or regenerates — same action, since there's only ever one active key per user)
// an API key for the logged-in user. The raw key is returned exactly once in this response;
// only its hash is ever stored, so it cannot be recovered or displayed again after this.
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const authHeader = req.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const user = await getUserFromSessionToken(token, SUPABASE_ANON_KEY);
  if (!user?.id) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  const { rawKey, keyHash, keyPrefix } = await generateApiKey();

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/api_keys`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({ user_id: user.id, key_hash: keyHash, key_prefix: keyPrefix, created_at: new Date().toISOString() })
    });
    if (!res.ok) throw new Error(`Supabase upsert failed: ${res.status}`);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not save API key', detail: e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({ apiKey: rawKey, keyPrefix }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
