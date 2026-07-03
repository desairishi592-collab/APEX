export const config = { runtime: 'edge' };

import { getUserFromSessionToken, getBearerToken } from '../lib/supabaseAuth.js';

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
const REFERRAL_BONUS_SCANS = 3; // credited to the referrer once the referred user runs their first scan

// Called after a scan completes. If the calling user was referred and hasn't already converted,
// marks the referral converted and credits the referrer +3 bonus scans (via an atomic SQL
// increment, not a read-then-write, so two friends converting at once can't race each other).
// A no-op (200, converted: false) if there's nothing pending — this is expected on every scan
// after the first, not an error.
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

  const token = getBearerToken(req);
  const user = await getUserFromSessionToken(token);
  if (!user?.id) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const refRes = await fetch(`${SUPABASE_URL}/rest/v1/referrals?select=id,referrer_id&referred_id=eq.${user.id}&converted=eq.false`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
    });
    if (!refRes.ok) throw new Error(`Supabase referral lookup failed: ${refRes.status}`);
    const rows = await refRes.json();
    const referral = rows[0];

    if (!referral) {
      return new Response(JSON.stringify({ converted: false }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/referrals?id=eq.${referral.id}`, {
      method: 'PATCH',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ converted: true })
    });
    if (!updateRes.ok) throw new Error(`Supabase referral update failed: ${updateRes.status}`);

    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_bonus_scans`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ p_user_id: referral.referrer_id, p_amount: REFERRAL_BONUS_SCANS })
    });
    if (!rpcRes.ok) throw new Error(`Supabase bonus_scans increment failed: ${rpcRes.status}`);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not convert referral', detail: e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({ converted: true }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
