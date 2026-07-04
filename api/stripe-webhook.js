// This endpoint receives events from Stripe when a payment succeeds and marks the
// corresponding user as Pro in Supabase.
export const config = { runtime: 'edge' };

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
const SIGNATURE_TOLERANCE_SECONDS = 300; // reject events whose timestamp is more than 5 min old/skewed

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Verifies Stripe's Stripe-Signature header against the RAW request body (must be the exact
// bytes Stripe sent — re-serializing parsed JSON would not reproduce a byte-identical payload
// and the signature would never match). Without this, anyone could POST a fake
// checkout.session.completed event and grant themselves Pro for free.
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => p.split('=')).filter(pair => pair.length === 2)
  );
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_TOLERANCE_SECONDS) return false;

  const computedHex = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return timingSafeEqual(computedHex, v1);
}

// profiles has no email column (email lives on auth.users) — resolves it via the Auth admin
// API instead of querying profiles?email=eq..., which would never match anything.
async function findUserIdByEmail(serviceRoleKey, email) {
  let page = 1;
  const perPage = 1000;
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
    });
    if (!res.ok) throw new Error(`Auth admin users query failed: ${res.status}`);
    const data = await res.json();
    const batch = Array.isArray(data) ? data : (data.users || []);
    const match = batch.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (match) return match.id;
    if (batch.length < perPage) return null;
    page++;
  }
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!webhookSecret || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Read the raw body ONCE, as text — signature verification needs the exact original bytes,
  // and req.json() would let us parse but not recover the byte-identical original.
  const rawBody = await req.text();
  const sigHeader = req.headers.get('stripe-signature');

  let verified;
  try {
    verified = await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
  } catch (e) {
    console.error('Signature verification error:', e.message);
    verified = false;
  }
  if (!verified) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: 'Malformed payload' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const customerEmail = session.customer_details?.email;
      if (customerEmail) {
        const userId = await findUserIdByEmail(serviceRoleKey, customerEmail);
        if (userId) {
          await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
            method: 'PATCH',
            headers: {
              apikey: serviceRoleKey,
              Authorization: `Bearer ${serviceRoleKey}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal'
            },
            body: JSON.stringify({ plan: 'pro' })
          });
        }
      }
    }
    return new Response(JSON.stringify({ received: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('Stripe webhook processing error:', e.message);
    return new Response(JSON.stringify({ error: 'Webhook processing failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
