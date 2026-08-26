// Cloudflare Turnstile server-side verification -- founder-directed bounded
// signup-abuse remediation (2026-08-25). Mirrors api/lib/email.js's
// convention (a small, single-purpose outbound-call helper reading its
// secret from an env var) with one deliberate difference: this is a
// SECURITY GATE, not a best-effort side channel. Every failure path --
// missing secret, missing/malformed token, a network error, or Cloudflare
// itself saying the token is invalid -- returns success:false. There is no
// "skip and continue" branch here the way api/lib/email.js has for a
// missing RESEND_API_KEY; the caller (api/auth.js) is expected to fail
// closed (reject the signup) on any success:false result.
//
// fetchImpl is dependency-injectable (defaults to the real global fetch) so
// the deterministic test suite can exercise every branch -- success,
// rejected token, missing secret, network failure -- without a real network
// call to Cloudflare.
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstileToken({ token, secret, remoteIp, fetchImpl = fetch } = {}) {
  if (!secret) return { success: false, reason: 'missing_secret' };
  if (!token || typeof token !== 'string') return { success: false, reason: 'missing_token' };
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    const resp = await fetchImpl(VERIFY_URL, { method: 'POST', body });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.success) {
      return { success: false, reason: 'rejected', errorCodes: Array.isArray(data['error-codes']) ? data['error-codes'] : [] };
    }
    return { success: true };
  } catch (err) {
    return { success: false, reason: 'network_error', error: err?.message || String(err) };
  }
}
