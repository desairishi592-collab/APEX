export const config = { runtime: 'edge' };

import { getUserFromSessionToken, getBearerToken } from '../lib/supabaseAuth.js';
import { checkAndIncrementRateLimit } from '../lib/rateLimit.js';
import { isAllowedOrigin } from '../lib/originCheck.js';

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
const RATE_LIMIT_MAX_REQUESTS = 10;    // per hour, per user — this endpoint's only signal is
const RATE_LIMIT_WINDOW_SECONDS = 3600; // valid/invalid, so it's a target for referral-code brute-forcing

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

  const rateLimit = await checkAndIncrementRateLimit(user.id, SUPABASE_URL, serviceRoleKey, {
    maxRequests: RATE_LIMIT_MAX_REQUESTS, windowSeconds: RATE_LIMIT_WINDOW_SECONDS
  });
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({ error: 'Too many attempts — please try again later.', retryAfterSeconds: rateLimit.retryAfterSeconds }), {
      status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(rateLimit.retryAfterSeconds) }
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
    console.error('Could not record referral:', e.message);
    return new Response(JSON.stringify({ error: 'Could not record referral' }), {
      status: 502, headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
