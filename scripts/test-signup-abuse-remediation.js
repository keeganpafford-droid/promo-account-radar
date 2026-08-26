// Founder-directed bounded signup-abuse remediation (2026-08-25/26).
//
// Two spam House Accounts signups were observed in Production (a shortened
// URL injected into the Name field, e.g. "🔥70Bin TL — Iste Buna Baslangic
// Denir https://bit.ly/4fX1JID 🔥"). Read-only recon confirmed: (1) neither
// signup nor login can reach any metered provider (OpenAI/Firecrawl/Serper/
// monitoring) without a real ha_accounts row, which only a CSV upload
// creates, so there was zero variable-cost exposure; (2) api/auth.js's
// signup branch had no server-side length/format validation and no bot
// protection at all. This file proves the two-layer fix landed correctly:
//
//   A. api/lib/signup-validation.js -- pure server-side validation (length
//      caps, explicit URL/link rejection) run BEFORE any Supabase Admin API
//      call or database write.
//   B. api/lib/turnstile.js + api/auth.js's Turnstile gate -- fails closed
//      (rejects signup) on any non-success verification result.
//   C. Cost-gate proof -- a full, successful signup run still never touches
//      ha_accounts, ha_monitoring_targets, or any provider/queue endpoint.
//
// Usage: node scripts/test-signup-abuse-remediation.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import { validateSignupProfile, containsUrlPayload } from '../api/lib/signup-validation.js';
import { verifyTurnstileToken } from '../api/lib/turnstile.js';
import handler from '../api/auth.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Part A -- pure validator unit tests (no I/O).
// ===========================================================================

// The actual observed spam payload.
const SPAM_NAME = '🔥 70Bin TL — Iste Buna Baslangic Denir https://bit.ly/4fX1JID 🔥';

const LEGIT_PROFILE = {
  name: 'Jamie Rivera',
  organizationName: 'Rivera Promotional Products',
  role: 'Owner',
  crm_erp: 'Commonsku',
  house_accounts: '75'
};

assert(containsUrlPayload(SPAM_NAME) === true, 'A1) containsUrlPayload: detects the actual observed https://bit.ly/... spam payload');
assert(containsUrlPayload('www.spam-link.example/promo') === true, 'A1) containsUrlPayload: detects a bare www.-prefixed URL');
assert(containsUrlPayload('bit.ly/abc123') === true, 'A1) containsUrlPayload: detects a bare (schemeless) known shortener URL');
assert(containsUrlPayload('Cars.com') === false, 'A1) containsUrlPayload: does NOT flag a bare "word.tld"-shaped legitimate brand name');
assert(containsUrlPayload('Overstock.com Inc.') === false, 'A1) containsUrlPayload: does NOT flag a legitimate company name containing its own domain');
assert(containsUrlPayload('Jamie Rivera') === false, 'A1) containsUrlPayload: an ordinary name has no false positive');

{
  const result = validateSignupProfile({ ...LEGIT_PROFILE, name: SPAM_NAME, organizationName: 'Google' });
  assert(result.valid === false, 'A2) validateSignupProfile: rejects the real spam Name payload');
  assert(/link|url/i.test(result.error || ''), `A2) validateSignupProfile: rejection message mentions link/URL (got "${result.error}")`);
}
{
  const result = validateSignupProfile(LEGIT_PROFILE);
  assert(result.valid === true, `A3) validateSignupProfile: accepts an ordinary legitimate profile (got error: ${result.error})`);
}
{
  const result = validateSignupProfile({ ...LEGIT_PROFILE, organizationName: 'Cars.com' });
  assert(result.valid === true, `A4) validateSignupProfile: accepts a bare domain-looking company name ("Cars.com") -- must not be blindly rejected (got error: ${result.error})`);
}
{
  const result = validateSignupProfile({ ...LEGIT_PROFILE, organizationName: 'Check out https://bit.ly/4fX1JID' });
  assert(result.valid === false, 'A5) validateSignupProfile: rejects an explicit promotional URL payload in organizationName');
}
{
  const result = validateSignupProfile({ ...LEGIT_PROFILE, name: '' });
  assert(result.valid === false && /name/i.test(result.error), 'A6) validateSignupProfile: rejects an empty name');
}
{
  const result = validateSignupProfile({ ...LEGIT_PROFILE, name: 'A'.repeat(101) });
  assert(result.valid === false, 'A7) validateSignupProfile: rejects a name over the max length');
}
{
  const result = validateSignupProfile({ ...LEGIT_PROFILE, organizationName: 'B'.repeat(201) });
  assert(result.valid === false, 'A8) validateSignupProfile: rejects an organizationName over the max length');
}
{
  const result = validateSignupProfile({ ...LEGIT_PROFILE, house_accounts: '0' });
  assert(result.valid === false, 'A9) validateSignupProfile: rejects house_accounts of 0');
}
{
  const result = validateSignupProfile({ ...LEGIT_PROFILE, house_accounts: '-5' });
  assert(result.valid === false, 'A10) validateSignupProfile: rejects a negative house_accounts');
}
{
  const result = validateSignupProfile({ ...LEGIT_PROFILE, house_accounts: '3.5' });
  assert(result.valid === false, 'A11) validateSignupProfile: rejects a non-integer house_accounts');
}
{
  const result = validateSignupProfile({ ...LEGIT_PROFILE, house_accounts: '99999999999999999999' });
  assert(result.valid === false, 'A12) validateSignupProfile: rejects an absurdly large house_accounts');
}
{
  const result = validateSignupProfile({ ...LEGIT_PROFILE, house_accounts: '100000' });
  assert(result.valid === true, `A13) validateSignupProfile: accepts house_accounts exactly at the generous upper bound (got error: ${result.error})`);
}
{
  const result = validateSignupProfile({ ...LEGIT_PROFILE, crm_erp: '' });
  assert(result.valid === true, `A14) validateSignupProfile: crm_erp stays optional -- empty is still accepted (got error: ${result.error})`);
}

// ===========================================================================
// Part B -- Turnstile helper unit tests (dependency-injected fetch, no real
// network call).
// ===========================================================================

{
  const result = await verifyTurnstileToken({ token: 'tok', secret: '', fetchImpl: async () => { throw new Error('should not be called'); } });
  assert(result.success === false && result.reason === 'missing_secret', 'B1) verifyTurnstileToken: fails closed when the secret is not configured, without making a network call');
}
{
  const result = await verifyTurnstileToken({ token: '', secret: 'shh', fetchImpl: async () => { throw new Error('should not be called'); } });
  assert(result.success === false && result.reason === 'missing_token', 'B2) verifyTurnstileToken: fails closed when no token is supplied');
}
{
  const fetchImpl = async (url, init) => {
    assert(url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify', 'B3) verifyTurnstileToken: posts to the real Cloudflare siteverify endpoint');
    const body = init.body.toString();
    assert(body.includes('response=good-token') && body.includes('secret=shh'), 'B3) verifyTurnstileToken: sends the token and secret in the request body');
    return { ok: true, json: async () => ({ success: true }) };
  };
  const result = await verifyTurnstileToken({ token: 'good-token', secret: 'shh', fetchImpl });
  assert(result.success === true, 'B3) verifyTurnstileToken: returns success:true for a valid token');
}
{
  const fetchImpl = async () => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) });
  const result = await verifyTurnstileToken({ token: 'bad-token', secret: 'shh', fetchImpl });
  assert(result.success === false && result.reason === 'rejected', 'B4) verifyTurnstileToken: fails closed when Cloudflare rejects the token');
}
{
  const fetchImpl = async () => { throw new Error('network down'); };
  const result = await verifyTurnstileToken({ token: 'tok', secret: 'shh', fetchImpl });
  assert(result.success === false && result.reason === 'network_error', 'B5) verifyTurnstileToken: fails closed on a network error rather than throwing');
}

// ===========================================================================
// Part C -- full api/auth.js signup-handler integration tests: the real,
// unmodified handler, with a fetch mock simulating Supabase Auth/REST and
// the Cloudflare Turnstile endpoint. Proves rejection happens BEFORE any
// Supabase write, and that a full successful signup still never touches
// ha_accounts/ha_monitoring_targets/any provider or queue endpoint.
// ===========================================================================

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  const text = JSON.stringify(data);
  return { ok, status, text: async () => text, json: async () => data };
}

function fakeReq(body) {
  return { method: 'POST', headers: {}, query: {}, body };
}
function fakeRes() {
  const res = { _status: null, _body: null, status(c) { this._status = c; return this; }, json(b) { this._body = b; return this; } };
  return res;
}

// Endpoints outside the expected signup footprint -- if ANY of these are
// ever hit during a signup request (successful or not), that IS the cost-
// exposure regression this whole remediation exists to keep closed.
const FORBIDDEN_URL_FRAGMENTS = [
  '/rest/v1/ha_accounts',
  '/rest/v1/ha_monitoring_targets',
  '/api/research-batch',
  '/api/research-account',
  'api.openai.com',
  'api.firecrawl.dev',
  'serper.dev',
  'google.serper',
  '/queues/',
  'monitoring-consumer'
];

function createSignupFetchMock({ turnstileOutcome = 'success', existingUsers = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(String(url));
    for (const fragment of FORBIDDEN_URL_FRAGMENTS) {
      if (String(url).includes(fragment)) throw new Error(`COST-GATE REGRESSION: signup touched a forbidden endpoint: ${url}`);
    }
    if (String(url).includes('challenges.cloudflare.com/turnstile')) {
      if (turnstileOutcome === 'success') return jsonResponse({ success: true });
      if (turnstileOutcome === 'rejected') return jsonResponse({ success: false, 'error-codes': ['invalid-input-response'] });
      throw new Error('simulated Turnstile network failure');
    }
    if (String(url).includes('/auth/v1/admin/users')) {
      return jsonResponse({ id: 'auth-user-new', email: 'jamie@example.com' });
    }
    if (String(url).includes('/auth/v1/token')) {
      return jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'bearer', user: { id: 'auth-user-new', email: 'jamie@example.com' } });
    }
    if (String(url).includes('/rest/v1/ha_users') && String(url).includes('auth_user_id=eq.')) {
      return jsonResponse(existingUsers);
    }
    if (String(url).includes('/rest/v1/ha_users') && String(url).includes('email=eq.')) {
      return jsonResponse(existingUsers);
    }
    if (String(url).includes('/rest/v1/ha_organizations') && (init.method || 'GET') === 'POST') {
      return jsonResponse([{ id: 'org-new' }]);
    }
    if (String(url).includes('/rest/v1/ha_users') && (init.method || 'GET') === 'POST') {
      return jsonResponse([{ id: 'user-new', email: 'jamie@example.com', organization_id: 'org-new' }]);
    }
    if (String(url).includes('/rest/v1/ha_users') && (init.method || 'GET') === 'PATCH') {
      return jsonResponse([{ id: 'user-new', email: 'jamie@example.com', organization_id: 'org-new' }]);
    }
    if (String(url).includes('/rest/v1/ha_login_events')) {
      return jsonResponse([{}]);
    }
    throw new Error(`Unexpected fetch in signup test: ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const originalFetch = global.fetch;
async function run() {
  // C1) The real observed spam payload -- rejected with 400, and NOT ONE
  // Supabase write (admin/users, ha_organizations, ha_users) ever happens.
  {
    process.env.TURNSTILE_SECRET_KEY = 'shh';
    const fetchImpl = createSignupFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ action: 'signup', email: 'spammer@ya.ru', password: 'password123', name: SPAM_NAME, organizationName: 'Google', role: 'Owner', house_accounts: '5', turnstileToken: 'irrelevant' });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 400, `C1) real spam Name payload: returns 400 (got ${res._status})`);
    assert(!fetchImpl.calls.some(u => u.includes('/auth/v1/admin/users')), 'C1) real spam Name payload: Supabase admin/users was never called');
    assert(!fetchImpl.calls.some(u => u.includes('/rest/v1/ha_organizations')), 'C1) real spam Name payload: ha_organizations was never written');
    assert(!fetchImpl.calls.some(u => u.includes('/rest/v1/ha_users')), 'C1) real spam Name payload: ha_users was never written');
  }

  // C2) Missing/invalid Turnstile token -- rejected with 400 even with an
  // otherwise fully valid profile, and no Supabase write happens.
  {
    process.env.TURNSTILE_SECRET_KEY = 'shh';
    const fetchImpl = createSignupFetchMock({ turnstileOutcome: 'rejected' });
    global.fetch = fetchImpl;
    const req = fakeReq({ action: 'signup', email: 'legit@example.com', password: 'password123', ...LEGIT_PROFILE, turnstileToken: 'bad-token' });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 400, `C2) rejected Turnstile token: returns 400 (got ${res._status})`);
    assert(!/error-codes|invalid-input-response/i.test(JSON.stringify(res._body || {})), 'C2) rejected Turnstile token: no raw provider error code is exposed to the client');
    assert(!fetchImpl.calls.some(u => u.includes('/auth/v1/admin/users')), 'C2) rejected Turnstile token: Supabase admin/users was never called');
  }

  // C3) Turnstile secret not configured for this environment -- fails
  // closed (signup blocked), same as an explicitly rejected token.
  {
    delete process.env.TURNSTILE_SECRET_KEY;
    const fetchImpl = createSignupFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ action: 'signup', email: 'legit2@example.com', password: 'password123', ...LEGIT_PROFILE, turnstileToken: 'some-token' });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 400, `C3) TURNSTILE_SECRET_KEY unset: fails closed with 400 (got ${res._status})`);
    assert(!fetchImpl.calls.some(u => u.includes('/auth/v1/admin/users')), 'C3) TURNSTILE_SECRET_KEY unset: Supabase admin/users was never called');
    process.env.TURNSTILE_SECRET_KEY = 'shh';
  }

  // C4) organizationName is a bare domain-looking legitimate brand name --
  // must NOT be blindly rejected (founder's explicit requirement).
  {
    const fetchImpl = createSignupFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ action: 'signup', email: 'brand@example.com', password: 'password123', ...LEGIT_PROFILE, organizationName: 'Cars.com', turnstileToken: 'good-token' });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200, `C4) bare domain-looking organizationName ("Cars.com"): signup succeeds, not rejected (got ${res._status}, body ${JSON.stringify(res._body)})`);
  }

  // C5) A genuinely legitimate signup succeeds end to end, AND -- the cost-
  // gate proof -- not one forbidden endpoint (ha_accounts,
  // ha_monitoring_targets, research/provider/queue endpoints) was ever
  // touched during the full request.
  {
    const fetchImpl = createSignupFetchMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ action: 'signup', email: 'jamie@example.com', password: 'password123', ...LEGIT_PROFILE, turnstileToken: 'good-token' });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200, `C5) legitimate signup: succeeds (got ${res._status}, body ${JSON.stringify(res._body)})`);
    assert(Boolean(res._body?.session?.access_token), 'C5) legitimate signup: a real session is returned');
    assert(fetchImpl.calls.some(u => u.includes('/auth/v1/admin/users')), 'C5) legitimate signup: Supabase admin/users WAS called (sanity -- this signup should actually create the account)');
    assert(fetchImpl.calls.some(u => u.includes('challenges.cloudflare.com/turnstile')), 'C5) legitimate signup: Turnstile verification WAS called');
    // Cost-gate proof: the forbidden-fragment check inside the fetch mock
    // itself already throws (failing the test) if any of these were
    // touched -- reaching this point with a 200 already proves it, but
    // assert the call list explicitly too, so this test fails loudly (not
    // just via an uncaught throw) if that guard is ever weakened.
    for (const fragment of FORBIDDEN_URL_FRAGMENTS) {
      assert(!fetchImpl.calls.some(u => u.includes(fragment)), `C5) cost gate: signup alone never touches "${fragment}"`);
    }
  }
}

try {
  await run();
} finally {
  global.fetch = originalFetch;
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
