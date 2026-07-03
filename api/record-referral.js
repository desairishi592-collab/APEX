export const config = { runtime: 'edge' };

import { getUserFromSessionToken, getBearerToken } from '../lib/supabaseAuth.js';

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';

// Called once, right after a new user's signup completes, if a referral code was captured
// from a ?ref= link earlier in the flow. Resolves the code to its owner (service-role lookup,
// so no public RLS policy is needed on profiles for this), then records the referral. Uses the
// referrals table's unique constraint on referred_id (ignored on conflict) so calling this
// more than once for the same user is harmless.
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

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Malformed request body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  const referralCode = typeof body?.referralCode === 'string' ? body.referralCode.trim().toUpperCase() : '';
  if (!referralCode) {
    return new Response(JSON.stringify({ error: 'Missing referral code' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id&referral_code=eq.${encodeURIComponent(referralCode)}`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
    });
    if (!profRes.ok) throw new Error(`Supabase profile lookup failed: ${profRes.status}`);
    const rows = await profRes.json();
    const referrerId = rows[0]?.id;

    if (!referrerId) {
      return new Response(JSON.stringify({ error: 'Invalid referral code' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }
    if (referrerId === user.id) {
      return new Response(JSON.stringify({ error: 'Cannot refer yourself' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const insRes = await fetch(`${SUPABASE_URL}/rest/v1/referrals`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal,resolution=ignore-duplicates'
      },
      body: JSON.stringify({ referrer_id: referrerId, referred_id: user.id })
    });
    if (!insRes.ok) throw new Error(`Supabase referral insert failed: ${insRes.status}`);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Could not record referral', detail: e.message }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
