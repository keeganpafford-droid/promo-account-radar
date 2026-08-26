// Founder notification sprint: internal notifications to keegan@houseaccounts.ai
// on (1) a genuine new House Accounts signup and (2) a user's first
// successful login, sent from api/auth.js. Drives the REAL, production-bound
// handler export (mocked Supabase + Resend fetch), same convention as
// scripts/test-security-correction-anonymous-endpoints.js.
//
// Note on scope: api/auth.js's signup action still calls recordLogin() to
// establish the new user's session (pre-existing, unchanged behavior), so
// login_count is incremented at signup time exactly as before -- but the
// signup branch does NOT call notifyFounderOfActivation(). A genuine
// self-signup therefore sends exactly one founder email (the signup one),
// never a second "activated" email for the same request. The "activated"
// notification is reserved for the login action -- fired the first time
// login_count is observed falsy there, which covers both a returning user
// logging back in after a session expiry and an invited teammate (whose
// ha_users row is created by api/team.js's accept-invite action, which
// never touches login_count) logging in for the first time.
//
// Usage: node scripts/test-founder-notifications.js
import handler from '../api/auth.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function jsonResponse(data, ok = true, status = 200) {
  return { ok, status, headers: { get: () => null }, json: async () => data, text: async () => JSON.stringify(data) };
}
function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}
function makeReq(body) {
  return { method: 'POST', headers: {}, body };
}

function setBaseEnv() {
  process.env.SUPABASE_URL = 'https://fake-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.RESEND_API_KEY = 'fake-resend-key';
  // Bounded signup-abuse remediation (2026-08-25/26): signup now requires a
  // verified Turnstile token before any Supabase Admin API call. This file
  // is about founder-notification behavior, not that gate itself (see
  // scripts/test-signup-abuse-remediation.js for the gate's own coverage),
  // so every signup fixture below mocks a successful verification.
  process.env.TURNSTILE_SECRET_KEY = 'fake-turnstile-secret';
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.ALERTS_FROM_EMAIL;
}

function turnstileSuccessRoute() {
  return (u) => u.includes('challenges.cloudflare.com/turnstile') ? jsonResponse({ success: true }) : undefined;
}

async function withMockFetch(handlers, fn) {
  const real = global.fetch;
  const resendCalls = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u === 'https://api.resend.com/emails') {
      const body = JSON.parse(options.body);
      resendCalls.push(body);
      return handlers.resend ? handlers.resend(body) : jsonResponse({ id: 'email-1' });
    }
    for (const h of handlers.routes) {
      const result = h(u, options);
      if (result !== undefined) return result;
    }
    throw new Error(`unexpected fetch call in test: ${u}`);
  };
  try {
    return { ...(await fn()), resendCalls };
  } finally {
    global.fetch = real;
  }
}

// ---------------------------------------------------------------------------
// Test 1: a genuine new signup -- exactly one "new signup" email and ZERO
// "user activated" emails for the same request (see the header note above:
// activation notifications are reserved for the login action). The one
// email sent is addressed to the founder, from the House Accounts sender
// address, and grounded in the verified/created identity.
// ---------------------------------------------------------------------------
async function testGenuineNewSignup() {
  setBaseEnv();
  const routes = [
    (u, o) => (u.includes('/auth/v1/admin/users') && o.method === 'POST')
      ? jsonResponse({ id: 'auth-1', email: 'newuser@example.com', user_metadata: JSON.parse(o.body).user_metadata })
      : undefined,
    (u) => (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) ? jsonResponse([]) : undefined,
    (u) => (u.includes('/rest/v1/ha_users') && u.includes('email=eq.newuser%40example.com')) ? jsonResponse([]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_organizations') && o.method === 'POST')
      ? jsonResponse([{ id: 'org-1', name: 'Acme Inc' }])
      : undefined,
    (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'POST')
      ? jsonResponse([{ ...JSON.parse(o.body)[0], id: 'user-1' }])
      : undefined,
    (u, o) => (u.includes('/auth/v1/token?grant_type=password') && o.method === 'POST')
      ? jsonResponse({ access_token: 'tok', refresh_token: 'rtok', expires_in: 3600, token_type: 'bearer', user: { id: 'auth-1', email: 'newuser@example.com' } })
      : undefined,
    (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'PATCH') ? jsonResponse([{ id: 'user-1' }]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'POST') ? jsonResponse([]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'DELETE') ? jsonResponse([]) : undefined,
    turnstileSuccessRoute()
  ];
  const { res, resendCalls } = await withMockFetch({ routes }, async () => {
    const req = makeReq({ action: 'signup', email: 'newuser@example.com', password: 'Sup3rSecret!1', name: 'New User', organizationName: 'Acme Inc', role: 'Owner', house_accounts: '50', turnstileToken: 'valid-turnstile-token' });
    const res = makeRes();
    await handler(req, res);
    return { res };
  });

  assert(res.statusCode === 200, `REQUIRED: signup succeeds (got ${res.statusCode}, body: ${JSON.stringify(res.body)})`);
  const signupEmails = resendCalls.filter(c => String(c.subject || '').startsWith('New House Accounts signup'));
  const activationEmails = resendCalls.filter(c => String(c.subject || '').startsWith('House Accounts user activated'));
  assert(signupEmails.length === 1, `REQUIRED: exactly one "new signup" founder email is sent for a genuine new signup (got ${signupEmails.length})`);
  assert(activationEmails.length === 0, `REQUIRED: no "user activated" email is sent during the same signup request (got ${activationEmails.length})`);
  assert(resendCalls.length === 1, `REQUIRED: exactly one founder email total is sent for a genuine new signup (got ${resendCalls.length})`);

  const signupEmail = signupEmails[0];
  assert(signupEmail.subject === 'New House Accounts signup — newuser@example.com', `signup subject matches the required format (got ${JSON.stringify(signupEmail.subject)})`);
  assert(signupEmail.to === 'keegan@houseaccounts.ai', `REQUIRED: the signup notification is addressed to keegan@houseaccounts.ai (got ${JSON.stringify(signupEmail.to)})`);
  assert(signupEmail.from === 'House Accounts <hello@houseaccounts.ai>', `REQUIRED: the signup notification is sent from House Accounts <hello@houseaccounts.ai> (got ${JSON.stringify(signupEmail.from)})`);
  assert(signupEmail.html.includes('New User') && signupEmail.html.includes('newuser@example.com') && signupEmail.html.includes('Acme Inc'), 'signup notification includes name, email, and organization/company');
}
await testGenuineNewSignup();

// ---------------------------------------------------------------------------
// Test 2: a standalone first successful login (an existing ha_users row --
// e.g. created via a team invite -- that has never logged in, login_count
// falsy) sends exactly one "user activated" email and zero signup emails.
// ---------------------------------------------------------------------------
async function testFirstStandaloneLogin() {
  setBaseEnv();
  const existingRow = { id: 'user-2', email: 'member@example.com', name: 'Existing Member', company: 'Beta Co', organization_id: 'org-2', auth_user_id: 'auth-2', login_count: 0 };
  const routes = [
    (u, o) => (u.includes('/auth/v1/token?grant_type=password') && o.method === 'POST')
      ? jsonResponse({ access_token: 'tok', refresh_token: 'rtok', expires_in: 3600, token_type: 'bearer', user: { id: 'auth-2', email: 'member@example.com' } })
      : undefined,
    (u) => (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) ? jsonResponse([existingRow]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'PATCH') ? jsonResponse([{ ...existingRow, ...JSON.parse(o.body) }]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'POST') ? jsonResponse([]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'DELETE') ? jsonResponse([]) : undefined
  ];
  const { res, resendCalls } = await withMockFetch({ routes }, async () => {
    const req = makeReq({ action: 'login', email: 'member@example.com', password: 'whatever-the-real-password-is' });
    const res = makeRes();
    await handler(req, res);
    return { res };
  });

  assert(res.statusCode === 200, `REQUIRED: login succeeds (got ${res.statusCode}, body: ${JSON.stringify(res.body)})`);
  assert(resendCalls.length === 1, `REQUIRED: exactly one founder email is sent for a user's first successful login (got ${resendCalls.length})`);
  const email = resendCalls[0];
  assert(email.subject === 'House Accounts user activated — member@example.com', `activation subject matches the required format (got ${JSON.stringify(email.subject)})`);
  assert(email.html.includes('Existing Member') && email.html.includes('member@example.com') && email.html.includes('Beta Co'), 'activation notification includes name, email, and organization/company');
}
await testFirstStandaloneLogin();

// ---------------------------------------------------------------------------
// Test 2b: an invited teammate -- an ha_users row created by
// api/team.js's accept-invite action (which never touches login_count at
// all, so the field is genuinely absent, not just 0) -- logging in via
// api/auth.js's login action for the first time still sends exactly one
// "user activated" email.
// ---------------------------------------------------------------------------
async function testInvitedTeammateFirstLogin() {
  setBaseEnv();
  // Mirrors the exact row shape api/team.js's accept-invite action inserts:
  // no login_count key present at all.
  const invitedRow = { id: 'user-6', email: 'teammate@example.com', name: 'Invited Teammate', company: 'Acme Inc', organization_id: 'org-1', auth_user_id: 'auth-6', app_role: 'member', role: 'member', status: 'active' };
  const routes = [
    (u, o) => (u.includes('/auth/v1/token?grant_type=password') && o.method === 'POST')
      ? jsonResponse({ access_token: 'tok', refresh_token: 'rtok', expires_in: 3600, token_type: 'bearer', user: { id: 'auth-6', email: 'teammate@example.com' } })
      : undefined,
    (u) => (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) ? jsonResponse([invitedRow]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'PATCH') ? jsonResponse([{ ...invitedRow, ...JSON.parse(o.body) }]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'POST') ? jsonResponse([]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'DELETE') ? jsonResponse([]) : undefined
  ];
  const { res, resendCalls } = await withMockFetch({ routes }, async () => {
    const req = makeReq({ action: 'login', email: 'teammate@example.com', password: 'whatever-the-real-password-is' });
    const res = makeRes();
    await handler(req, res);
    return { res };
  });

  assert(res.statusCode === 200, `REQUIRED: the invited teammate's first login succeeds (got ${res.statusCode}, body: ${JSON.stringify(res.body)})`);
  assert(resendCalls.length === 1, `REQUIRED: an invited/newly provisioned user's first login sends exactly one founder email (got ${resendCalls.length})`);
  const email = resendCalls[0];
  assert(email.subject === 'House Accounts user activated — teammate@example.com', `activation subject matches the required format (got ${JSON.stringify(email.subject)})`);
  assert(!resendCalls.some(c => String(c.subject || '').startsWith('New House Accounts signup')), 'REQUIRED: an invited teammate logging in never triggers a "new signup" email (they were provisioned via the team-invite flow, not api/auth.js signup)');
}
await testInvitedTeammateFirstLogin();

// ---------------------------------------------------------------------------
// Test 3: a later login (login_count already >= 1) sends NO additional
// activation email -- the persisted login_count marker, not browser state,
// makes this deterministic.
// ---------------------------------------------------------------------------
async function testLaterLoginNoEmail() {
  setBaseEnv();
  const existingRow = { id: 'user-2', email: 'member@example.com', name: 'Existing Member', company: 'Beta Co', organization_id: 'org-2', auth_user_id: 'auth-2', login_count: 5 };
  const routes = [
    (u, o) => (u.includes('/auth/v1/token?grant_type=password') && o.method === 'POST')
      ? jsonResponse({ access_token: 'tok', refresh_token: 'rtok', expires_in: 3600, token_type: 'bearer', user: { id: 'auth-2', email: 'member@example.com' } })
      : undefined,
    (u) => (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) ? jsonResponse([existingRow]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'PATCH') ? jsonResponse([{ ...existingRow, ...JSON.parse(o.body) }]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'POST') ? jsonResponse([]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'DELETE') ? jsonResponse([]) : undefined
  ];
  const { res, resendCalls } = await withMockFetch({ routes }, async () => {
    const req = makeReq({ action: 'login', email: 'member@example.com', password: 'whatever-the-real-password-is' });
    const res = makeRes();
    await handler(req, res);
    return { res };
  });

  assert(res.statusCode === 200, `login succeeds (got ${res.statusCode})`);
  assert(resendCalls.length === 0, `REQUIRED: a later login (login_count already >= 1) sends zero founder emails (got ${resendCalls.length})`);
}
await testLaterLoginNoEmail();

// ---------------------------------------------------------------------------
// Test 4: notification delivery failure never blocks or fails the actual
// signup/login response -- proven for both a Resend API error response and
// a hard network failure (fetch throwing), on both the signup and login
// paths.
// ---------------------------------------------------------------------------
async function testNotificationFailureNeverBlocksSignupOrLogin() {
  // 4a: Resend returns a non-ok response during signup.
  {
    setBaseEnv();
    const routes = [
      (u, o) => (u.includes('/auth/v1/admin/users') && o.method === 'POST')
        ? jsonResponse({ id: 'auth-3', email: 'flaky@example.com', user_metadata: JSON.parse(o.body).user_metadata })
        : undefined,
      (u) => (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) ? jsonResponse([]) : undefined,
      (u) => (u.includes('/rest/v1/ha_users') && u.includes('email=eq.')) ? jsonResponse([]) : undefined,
      (u, o) => (u.includes('/rest/v1/ha_organizations') && o.method === 'POST') ? jsonResponse([{ id: 'org-3', name: 'Flaky Co' }]) : undefined,
      (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'POST') ? jsonResponse([{ ...JSON.parse(o.body)[0], id: 'user-3' }]) : undefined,
      (u, o) => (u.includes('/auth/v1/token?grant_type=password') && o.method === 'POST')
        ? jsonResponse({ access_token: 'tok', refresh_token: 'rtok', expires_in: 3600, token_type: 'bearer', user: { id: 'auth-3', email: 'flaky@example.com' } })
        : undefined,
      (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'PATCH') ? jsonResponse([{ id: 'user-3' }]) : undefined,
      (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'POST') ? jsonResponse([]) : undefined,
      (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'DELETE') ? jsonResponse([]) : undefined,
      turnstileSuccessRoute()
    ];
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    const { res } = await withMockFetch({ routes, resend: () => jsonResponse({ message: 'Resend is down' }, false, 500) }, async () => {
      const req = makeReq({ action: 'signup', email: 'flaky@example.com', password: 'Sup3rSecret!1', name: 'Flaky User', organizationName: 'Flaky Co', role: 'Owner', house_accounts: '50', turnstileToken: 'valid-turnstile-token' });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    console.warn = originalWarn;
    assert(res.statusCode === 200, `REQUIRED: a Resend API error during signup still results in a successful signup (got ${res.statusCode}, body: ${JSON.stringify(res.body)})`);
    assert(!!res.body?.session?.access_token, 'REQUIRED: the signup response still includes a real session even though the founder notification failed');
    assert(warnings.some(w => w.includes('[auth] founder notification failed')), 'the notification failure is logged server-side, not silently discarded without a trace');
  }

  // 4b: the notification fetch itself throws (hard network failure) during
  // a first login.
  {
    setBaseEnv();
    const existingRow = { id: 'user-4', email: 'member2@example.com', name: 'Member Two', company: 'Gamma Co', organization_id: 'org-4', auth_user_id: 'auth-4', login_count: 0 };
    const routes = [
      (u, o) => (u.includes('/auth/v1/token?grant_type=password') && o.method === 'POST')
        ? jsonResponse({ access_token: 'tok', refresh_token: 'rtok', expires_in: 3600, token_type: 'bearer', user: { id: 'auth-4', email: 'member2@example.com' } })
        : undefined,
      (u) => (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) ? jsonResponse([existingRow]) : undefined,
      (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'PATCH') ? jsonResponse([{ ...existingRow, ...JSON.parse(o.body) }]) : undefined,
      (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'POST') ? jsonResponse([]) : undefined,
      (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'DELETE') ? jsonResponse([]) : undefined
    ];
    const { res } = await withMockFetch({ routes, resend: () => { throw new Error('simulated network failure reaching Resend'); } }, async () => {
      const req = makeReq({ action: 'login', email: 'member2@example.com', password: 'whatever-the-real-password-is' });
      const res = makeRes();
      await handler(req, res);
      return { res };
    });
    assert(res.statusCode === 200, `REQUIRED: a hard network failure reaching Resend during a first login still results in a successful login (got ${res.statusCode}, body: ${JSON.stringify(res.body)})`);
    assert(!!res.body?.session?.access_token, 'REQUIRED: the login response still includes a real session even though the founder notification failed');
  }
}
await testNotificationFailureNeverBlocksSignupOrLogin();

// ---------------------------------------------------------------------------
// Test 5: identity for the notification comes from the VERIFIED Supabase
// auth response, never from the raw request body. A caller submits a login
// request with a spoofed body.email; the Supabase password-grant response
// (the actual verified identity) names a different address, and the
// resulting founder notification must reflect ONLY the verified address.
// ---------------------------------------------------------------------------
async function testIdentityFromVerifiedAuthNotRequestBody() {
  setBaseEnv();
  const existingRow = { id: 'user-5', email: 'real-owner@example.com', name: 'Real Owner', company: 'RealCo', organization_id: 'org-5', auth_user_id: 'auth-5', login_count: 0 };
  const routes = [
    (u, o) => (u.includes('/auth/v1/token?grant_type=password') && o.method === 'POST')
      // The verified Supabase response names the REAL account owner --
      // deliberately different from the spoofed body.email below.
      ? jsonResponse({ access_token: 'tok', refresh_token: 'rtok', expires_in: 3600, token_type: 'bearer', user: { id: 'auth-5', email: 'real-owner@example.com' } })
      : undefined,
    (u) => (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) ? jsonResponse([existingRow]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_users') && o.method === 'PATCH') ? jsonResponse([{ ...existingRow, ...JSON.parse(o.body) }]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'POST') ? jsonResponse([]) : undefined,
    (u, o) => (u.includes('/rest/v1/ha_login_events') && o.method === 'DELETE') ? jsonResponse([]) : undefined
  ];
  const { res, resendCalls } = await withMockFetch({ routes }, async () => {
    // NOTE: the real api/auth.js login action still uses body.email to
    // attempt the Supabase password grant itself (that attempt IS the
    // identity verification step) -- but the resulting notification must be
    // built from the grant's own returned user, not this value.
    const req = makeReq({ action: 'login', email: 'attacker-supplied@evil.com', password: 'irrelevant-in-this-mock' });
    const res = makeRes();
    await handler(req, res);
    return { res };
  });

  assert(res.statusCode === 200, `login succeeds (got ${res.statusCode})`);
  assert(resendCalls.length === 1, `exactly one activation email is sent (got ${resendCalls.length})`);
  const email = resendCalls[0];
  assert(email.subject.includes('real-owner@example.com'), `REQUIRED: the notification identifies the VERIFIED account owner (got subject ${JSON.stringify(email.subject)})`);
  assert(!email.subject.includes('attacker-supplied@evil.com'), 'REQUIRED: the notification subject never contains the spoofed request-body email');
  assert(email.html.includes('real-owner@example.com') && !email.html.includes('attacker-supplied@evil.com'), 'REQUIRED: the notification body reflects only the verified identity, never the unverified request-body email');
}
await testIdentityFromVerifiedAuthNotRequestBody();

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
