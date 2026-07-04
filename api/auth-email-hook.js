// Supabase "Send Email" Auth Hook — called by Supabase in place of its built-in mailer
// (SMTP or otherwise) for every auth email: signup confirmation, password recovery, magic
// link, email change, and invite. Sends via Resend's API directly instead, since the
// custom SMTP → Resend path was silently failing (likely a sender-domain verification issue).
export const config = { runtime: 'edge' };

const SUPABASE_URL = 'https://agvwyqslzreqtnmmwxwk.supabase.co';
const TIMESTAMP_TOLERANCE_SECONDS = 300; // reject events whose timestamp is more than 5 min old/skewed

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// Supabase signs Auth Hook payloads per the Standard Webhooks spec (same scheme Svix uses):
// the dashboard-issued secret looks like "v1,whsec_<base64>", and the signature is
// HMAC-SHA256 over "{msgId}.{timestamp}.{rawBody}", base64-encoded. The webhook-signature
// header can carry multiple space-separated "v1,<sig>" values — any match is accepted.
async function verifyAuthHookSignature(rawBody, headers, secret) {
  const msgId = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const sigHeader = headers.get('webhook-signature');
  if (!msgId || !timestamp || !sigHeader) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > TIMESTAMP_TOLERANCE_SECONDS) return false;

  const secretB64 = secret.replace(/^v1,/, '').replace(/^whsec_/, '');
  const key = await crypto.subtle.importKey(
    'raw', base64ToBytes(secretB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${msgId}.${timestamp}.${rawBody}`));
  const expected = bytesToBase64(new Uint8Array(sigBuffer));

  return sigHeader.split(' ').some(part => {
    const sig = part.split(',')[1];
    return sig && sig.length === expected.length && timingSafeEqual(sig, expected);
  });
}

// Email body is built from Supabase-controlled fields (token/email), not free-text user
// input, but escaped anyway since it's cheap and this still ends up in an HTML email.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Hits Supabase's own verify endpoint directly (not the app) — it checks the token,
// completes the auth action, then redirects the browser to redirect_to.
function buildActionLink({ token_hash, email_action_type, redirect_to }) {
  const params = new URLSearchParams({ token: token_hash, type: email_action_type, redirect_to: redirect_to || '' });
  return `${SUPABASE_URL}/auth/v1/verify?${params.toString()}`;
}

const EMAIL_COPY = {
  signup: { subject: 'Confirm your APEX signup', heading: 'Confirm your signup', cta: 'Confirm your email', body: 'Follow the link below to confirm your account and finish signing up.' },
  recovery: { subject: 'Reset your APEX password', heading: 'Reset your password', cta: 'Reset password', body: 'Follow the link below to choose a new password.' },
  magiclink: { subject: 'Your APEX sign-in link', heading: 'Sign in to APEX', cta: 'Sign in', body: 'Follow the link below to sign in.' },
  email_change: { subject: 'Confirm your new email', heading: 'Confirm email change', cta: 'Confirm change', body: 'Follow the link below to confirm your new email address.' },
  invite: { subject: "You've been invited to APEX", heading: "You're invited", cta: 'Accept invite', body: 'Follow the link below to set up your account.' }
};

function buildEmailHtml(copy, actionLink) {
  return `<div style="font-family:sans-serif;color:#111;max-width:480px;">
  <h2 style="margin:0 0 12px;">${escapeHtml(copy.heading)}</h2>
  <p style="margin:0 0 20px;">${escapeHtml(copy.body)}</p>
  <p style="margin:0 0 20px;">
    <a href="${actionLink}" style="background:#6d5bfa;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;">${escapeHtml(copy.cta)}</a>
  </p>
  <p style="margin:0;font-size:13px;color:#666;">If the button doesn't work, copy and paste this link:<br>${escapeHtml(actionLink)}</p>
</div>`;
}

// Supabase surfaces this shape as the error on the client's signUp()/resend() call —
// a plain 4xx/5xx with a different body would just show as a generic failure.
function hookError(status, message) {
  return new Response(JSON.stringify({ error: { http_code: status, message } }), {
    status, headers: { 'Content-Type': 'application/json' }
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') return hookError(405, 'Method not allowed');

  const hookSecret = process.env.SUPABASE_AUTH_HOOK_SECRET;
  const resendKey = process.env.RESEND_API_KEY;
  if (!hookSecret || !resendKey) return hookError(500, 'Server misconfiguration');

  // Read the raw body ONCE, as text — signature verification needs the exact original
  // bytes, and req.json() would let us parse but not recover the byte-identical original.
  const rawBody = await req.text();

  let verified;
  try {
    verified = await verifyAuthHookSignature(rawBody, req.headers, hookSecret);
  } catch (e) {
    console.error('Auth hook signature verification error:', e.message);
    verified = false;
  }
  if (!verified) return hookError(401, 'Invalid signature');

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return hookError(400, 'Malformed payload');
  }

  const email = payload?.user?.email;
  const emailData = payload?.email_data || {};
  const actionType = emailData.email_action_type;
  if (!email || !actionType || !emailData.token_hash) {
    return hookError(400, 'Missing required fields in hook payload');
  }

  const copy = EMAIL_COPY[actionType] || EMAIL_COPY.signup;
  const actionLink = buildActionLink({
    token_hash: emailData.token_hash,
    email_action_type: actionType,
    redirect_to: emailData.redirect_to
  });

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'APEX <onboarding@resend.dev>',
        to: email,
        subject: copy.subject,
        html: buildEmailHtml(copy, actionLink)
      })
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('Resend send failed:', res.status, detail);
      return hookError(500, 'Failed to send email');
    }
  } catch (e) {
    console.error('Resend request error:', e.message);
    return hookError(500, 'Failed to send email');
  }

  return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
