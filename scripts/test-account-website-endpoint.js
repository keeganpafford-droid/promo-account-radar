// Find More Like Them V1 correction (2026-08-26) -- api/account-website.js,
// the narrow endpoint that saves the missing website/domain identity anchor
// api/find-similar-companies.js now requires. Exercised against the REAL,
// unmodified default export (same convention as
// scripts/test-whitespace-map-endpoint.js), not a reconstructed helper.
//
// IDENTITY MODEL (Founder QA correction, same day): an earlier version of
// this endpoint matched by account_name across the whole organization.
// That was rejected on inspection -- api/find-similar-companies.js's own
// account fetch is org-wide (every active user in the org), and two
// different reps can legitimately have two DIFFERENT companies that happen
// to share a display name, so a name-based write could silently corrupt an
// unrelated rep's account. Every other account-metadata write in this
// codebase (dashboard/index.html's saveAccountMetadataEdit()) identifies
// the account by (uploadId, account_name) -- never by name alone,
// org-wide. This endpoint now matches that precedent: it writes to exactly
// the ONE ha_accounts row api/find-similar-companies.js already resolved
// as "the seed" (its real id), verified to belong to the caller's own
// organization -- never a broader name-based fan-out.
//
// Covers: auth boundary, input validation (reusing the existing
// normalizeDomain() normalizer, not a new one), the read-modify-write that
// must never clobber other raw_data keys, id-scoped identity (never
// touching another row that merely shares the same account name -- same
// rep's own duplicate upload, or a different rep's unrelated company), and
// organization isolation.
//
// Usage: node scripts/test-account-website-endpoint.js
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

import handler from '../api/account-website.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}
function jsonResponse(data, { ok = true, status = 200 } = {}) {
  const text = JSON.stringify(data);
  return { ok, status, text: async () => text, json: async () => data };
}
function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = () => {};
  return res;
}
function makeReq(body, { withAuth = true } = {}) {
  return { method: 'POST', headers: withAuth ? { authorization: 'Bearer valid-token' } : {}, body };
}

const ORG_A = 'org-a';
const USER_A = 'user-a';

// Two DISTINCT companies that both happen to be named "Ridgeline Apparel"
// -- acct-a1 is the caller's own seed row (what MUST be updated); acct-a2
// is a genuinely different company under a DIFFERENT rep in the SAME
// organization sharing the same name by coincidence (must NEVER be
// touched); acct-b1 belongs to a different organization entirely (the
// org-isolation fixture).
const ACCOUNTS_STORE = [
  { id: 'acct-a1', account_name: 'Ridgeline Apparel', user_id: USER_A, raw_data: { contacts: [{ name: 'Jordan Reyes' }], location: 'Denver, CO' } },
  { id: 'acct-a2', account_name: 'Ridgeline Apparel', user_id: 'user-a-colleague', raw_data: { location: 'Unrelated, TX' } },
  { id: 'acct-b1', account_name: 'Ridgeline Apparel', user_id: 'user-b', raw_data: {} }
];
let patchCalls = [];

function mockFetch() {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonResponse({ id: 'auth-user-a', email: 'rep@example.com' });
    if (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) return jsonResponse([{ id: USER_A, organization_id: ORG_A, status: 'active' }]);
    // The org includes USER_A and their colleague (acct-a2's owner) -- both
    // active members of the SAME organization as the caller.
    if (u.includes('/rest/v1/ha_users') && u.includes('organization_id=eq.')) return jsonResponse([{ id: USER_A, status: 'active' }, { id: 'user-a-colleague', status: 'active' }]);
    if (u.includes('/rest/v1/ha_accounts') && (init.method || 'GET') === 'GET') {
      const idMatch = decodeURIComponent(u).match(/id=eq\.([^&]+)/);
      const id = idMatch ? idMatch[1] : '';
      const inMatch = u.match(/user_id=in\.\(([^)]*)\)/);
      const allowedIds = inMatch ? inMatch[1].split(',').map(s => s.replace(/"/g, '')) : [];
      const rows = ACCOUNTS_STORE.filter(a => a.id === id && allowedIds.includes(a.user_id));
      return jsonResponse(rows.map(r => ({ id: r.id, raw_data: r.raw_data })));
    }
    if (u.includes('/rest/v1/ha_accounts') && init.method === 'PATCH') {
      const idMatch = u.match(/id=eq\.([^&]+)/);
      const id = idMatch ? decodeURIComponent(idMatch[1]) : '';
      const body = JSON.parse(init.body || '{}');
      patchCalls.push({ id, body });
      const row = ACCOUNTS_STORE.find(a => a.id === id);
      if (row) row.raw_data = body.raw_data;
      return jsonResponse({});
    }
    throw new Error(`unexpected fetch in account-website test: ${u}`);
  };
}

async function run() {
  const realFetch = global.fetch;
  try {
    // 1. Auth boundary.
    {
      global.fetch = mockFetch();
      const res = makeRes();
      await handler(makeReq({ accountId: 'acct-a1', website: 'ridgeline.com' }, { withAuth: false }), res);
      assert(res.statusCode === 401, `REQUIRED: no Authorization header -> 401 (got ${res.statusCode})`);
    }

    // 2. Missing accountId.
    {
      global.fetch = mockFetch();
      const res = makeRes();
      await handler(makeReq({ website: 'ridgeline.com' }), res);
      assert(res.statusCode === 400, `REQUIRED: missing accountId -> 400 (got ${res.statusCode})`);
    }

    // 3. Invalid/empty website is rejected with a plain, customer-facing
    // message -- no database terminology (no "column", "raw_data", "jsonb").
    {
      global.fetch = mockFetch();
      const res = makeRes();
      await handler(makeReq({ accountId: 'acct-a1', website: '   ' }), res);
      assert(res.statusCode === 400, `REQUIRED: an empty website is rejected with 400 (got ${res.statusCode})`);
      assert(!/column|raw_data|jsonb|schema/i.test(res.body?.error || ''), `REQUIRED: the rejection message never exposes database terminology (got "${res.body?.error}")`);
    }

    // 4. Unknown/nonexistent accountId.
    {
      global.fetch = mockFetch();
      const res = makeRes();
      await handler(makeReq({ accountId: 'acct-does-not-exist', website: 'nonexistent.com' }), res);
      assert(res.statusCode === 404, `REQUIRED: an unrecognized accountId -> 404 (got ${res.statusCode})`);
    }

    // 5. Happy path: canonical persistence + read-modify-write, scoped to
    // the exact id -- never a broader name-based write.
    {
      patchCalls = [];
      global.fetch = mockFetch();
      const res = makeRes();
      await handler(makeReq({ accountId: 'acct-a1', website: 'https://Ridgeline.com/about' }), res);
      assert(res.statusCode === 200 && res.body?.ok === true, `REQUIRED: a valid save succeeds (got ${res.statusCode}, ${JSON.stringify(res.body)})`);
      assert(res.body.website === 'ridgeline.com', `REQUIRED: the website is normalized via the existing normalizeDomain() utility, not stored as raw user input (got "${res.body.website}")`);
      assert(patchCalls.length === 1, `REQUIRED: exactly ONE row is patched -- the specific seed id, never a name-based fan-out (got ${patchCalls.length} PATCH calls)`);
      assert(patchCalls[0].id === 'acct-a1', `REQUIRED: the patched row is exactly the requested accountId (got "${patchCalls[0].id}")`);
      assert(patchCalls[0].body.raw_data.website === 'ridgeline.com', 'REQUIRED: the new website is written into raw_data.website -- the confirmed canonical location, not a new storage model');
      assert(JSON.stringify(patchCalls[0].body.raw_data.contacts) === JSON.stringify([{ name: 'Jordan Reyes' }]) && patchCalls[0].body.raw_data.location === 'Denver, CO', 'REQUIRED (read-modify-write): every other pre-existing raw_data key on this row survives the save untouched');
    }

    // 6. REQUIRED (the actual reported architecture risk): a DIFFERENT,
    // genuinely unrelated company under a colleague in the SAME
    // organization that merely happens to share the account name is never
    // touched -- the fix this whole correction exists for.
    {
      const otherAccount = ACCOUNTS_STORE.find(a => a.id === 'acct-a2');
      assert(otherAccount.raw_data.website === undefined, 'REQUIRED: a same-org, same-name, but genuinely DIFFERENT company (different rep, different account) is never modified by another rep\'s website save');
      assert(otherAccount.raw_data.location === 'Unrelated, TX', 'REQUIRED: that unrelated account\'s own real data is completely undisturbed');
    }

    // 7. Org isolation: a caller can never write to a row belonging to a
    // different organization, even by guessing/reusing its id.
    {
      patchCalls = [];
      global.fetch = mockFetch();
      const res = makeRes();
      await handler(makeReq({ accountId: 'acct-b1', website: 'someother.com' }), res);
      assert(res.statusCode === 404, `REQUIRED (org isolation): a request for another organization's account id is rejected as not found, not fulfilled (got ${res.statusCode})`);
      assert(patchCalls.length === 0, 'REQUIRED (org isolation): no PATCH is ever issued for a row outside the caller\'s organization');
      assert(ACCOUNTS_STORE.find(a => a.id === 'acct-b1').raw_data.website === undefined, 'REQUIRED (org isolation): ORG_B\'s row is left completely untouched');
    }
  } finally {
    global.fetch = realFetch;
  }
}

await run();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
