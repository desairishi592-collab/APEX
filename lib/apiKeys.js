// API key generation/hashing/lookup for the external scan API (api/v1/scan.js) and the
// key-management endpoint (api/generate-api-key.js). Keys are stored hashed — same general
// pattern as password storage — the raw value is only ever returned once, at creation time.

const KEY_PREFIX = 'apex_';
const KEY_RANDOM_BYTES = 32; // 256 bits of entropy

function toHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(new Uint8Array(digest));
}

// Generates a new raw API key plus its hash — the raw value must be shown to the caller
// exactly once (at generation time) and never persisted or logged in plaintext.
export async function generateApiKey() {
  const randomBytes = new Uint8Array(KEY_RANDOM_BYTES);
  crypto.getRandomValues(randomBytes);
  const rawKey = KEY_PREFIX + toHex(randomBytes);
  const keyHash = await sha256Hex(rawKey);
  const keyPrefix = rawKey.slice(0, 12); // safe to store/display — not enough to reconstruct the key
  return { rawKey, keyHash, keyPrefix };
}

// Looks up which user (if any) owns the given raw API key, by hashing it and matching
// against the stored hash. Requires the service-role key since this is a cross-user
// lookup unscoped by RLS.
export async function lookupUserByApiKey(rawKey, supabaseUrl, serviceRoleKey) {
  if (!rawKey || !rawKey.startsWith(KEY_PREFIX)) return null;
  const keyHash = await sha256Hex(rawKey);

  const res = await fetch(`${supabaseUrl}/rest/v1/api_keys?select=user_id&key_hash=eq.${keyHash}`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` }
  });
  if (!res.ok) throw new Error(`Supabase api_keys lookup failed: ${res.status}`);
  const rows = await res.json();
  return rows[0]?.user_id || null;
}
