export const config = { runtime: 'edge' };

import { getUserFromSessionToken, getBearerToken } from '../lib/supabaseAuth.js';
import { isAllowedOrigin } from '../lib/originCheck.js';

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
const REFERRAL_BONUS_SCANS = 3; // credited to the referrer once the referred user runs their first scan

// Called after a scan completes. If the calling user was referred and hasn't already converted,
// marks the referral converted and credits the referrer +3 bonus scans. Both steps happen in a
// single atomic Postgres transaction (convert_referral_and_credit) — previously these were two
// separate requests (a PATCH then an RPC), and if the second failed after the first succeeded,
// the referral was permanently marked converted with the referrer never actually credited. A
// no-op (200, converted: false) if there's nothing pending — expected on every scan after the
// first, not an error.
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!isAllowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403, headers: { 'Content-Type': 'application/json' }
    });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration: missing SUPABASE_SERVICE_ROLE_KEY' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  const token = getBearerToken(req);
  const user = await getUserFromSessionToken(token);
  if (!user?.id) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/convert_referral_and_credit`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_referred_id: user.id, p_bonus_amount: REFERRAL_BONUS_SCANS })
    });
    if (!rpcRes.ok) throw new Error(`convert_referral_and_credit failed: ${rpcRes.status}`);
    const rows = await rpcRes.json();
    const converted = !!rows[0]?.converted;

    return new Response(JSON.stringify({ converted }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('Could not convert referral:', e.message);
    return new Response(JSON.stringify({ error: 'Could not convert referral' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }
}
