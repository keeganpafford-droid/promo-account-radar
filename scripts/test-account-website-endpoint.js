// Find More Like Them V1 correction (2026-08-26) -- api/account-website.js,
// the narrow endpoint that saves the missing website/domain identity anchor
// api/find-similar-companies.js now requires. Exercised against the REAL,
// unmodified default export (same convention as
// scripts/test-whitespace-map-endpoint.js), not a reconstructed helper.
//
// Covers: auth boundary, input validation (reusing the existing
// normalizeDomain() normalizer, not a new one), the read-modify-write that
// must never clobber other raw_data keys, updating EVERY ha_accounts row
// sharing an account name within the org (the same (organization,
// account_name) identity convention api/get-dashboard.js already uses),
// and organization isolation.
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
const ORG_B = 'org-b';
const USER_A = 'user-a';

// ORG_A's own ha_accounts rows -- two rows sharing one account_name
// (simulating two uploads), and one belonging to ORG_B under the SAME
// account_name -- the org-isolation fixture.
const ACCOUNTS_STORE = [
  { id: 'acct-a1', account_name: 'Ridgeline Apparel', user_id: USER_A, raw_data: { contacts: [{ name: 'Jordan Reyes' }], location: 'Denver, CO' } },
  { id: 'acct-a2', account_name: 'Ridgeline Apparel', user_id: USER_A, raw_data: { intelligenceMode: 'historical' } },
  { id: 'acct-b1', account_name: 'Ridgeline Apparel', user_id: 'user-b', raw_data: {} }
];
let patchCalls = [];

function mockFetch() {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return jsonResponse({ id: 'auth-user-a', email: 'rep@example.com' });
    if (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) return jsonResponse([{ id: USER_A, organization_id: ORG_A, status: 'active' }]);
    if (u.includes('/rest/v1/ha_users') && u.includes('organization_id=eq.')) return jsonResponse([{ id: USER_A, status: 'active' }]);
    if (u.includes('/rest/v1/ha_accounts') && (init.method || 'GET') === 'GET') {
      // The real endpoint scopes by user_id=in.(...ctx.userIds) -- assert
      // ORG_B's row id never even appears in the candidate set the handler
      // could patch, by filtering the fixture store exactly like PostgREST
      // would against the actual filter string sent.
      const nameMatch = decodeURIComponent(u).match(/account_name=eq\.([^&]+)/);
      const name = nameMatch ? nameMatch[1] : '';
      const inMatch = u.match(/user_id=in\.\(([^)]*)\)/);
      const allowedIds = inMatch ? inMatch[1].split(',').map(s => s.replace(/"/g, '')) : [];
      const rows = ACCOUNTS_STORE.filter(a => a.account_name === name && allowedIds.includes(a.user_id));
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
      await handler(makeReq({ accountName: 'Ridgeline Apparel', website: 'ridgeline.com' }, { withAuth: false }), res);
      assert(res.statusCode === 401, `REQUIRED: no Authorization header -> 401 (got ${res.statusCode})`);
    }

    // 2. Missing accountName.
    {
      global.fetch = mockFetch();
      const res = makeRes();
      await handler(makeReq({ website: 'ridgeline.com' }), res);
      assert(res.statusCode === 400, `REQUIRED: missing accountName -> 400 (got ${res.statusCode})`);
    }

    // 3. Invalid/empty website is rejected with a plain, customer-facing
    // message -- no database terminology (no "column", "raw_data", "jsonb").
    {
      global.fetch = mockFetch();
      const res = makeRes();
      await handler(makeReq({ accountName: 'Ridgeline Apparel', website: '   ' }), res);
      assert(res.statusCode === 400, `REQUIRED: an empty website is rejected with 400 (got ${res.statusCode})`);
      assert(!/column|raw_data|jsonb|schema/i.test(res.body?.error || ''), `REQUIRED: the rejection message never exposes database terminology (got "${res.body?.error}")`);
    }

    // 4. Account not found for this org.
    {
      global.fetch = mockFetch();
      const res = makeRes();
      await handler(makeReq({ accountName: 'Nonexistent Co', website: 'nonexistent.com' }), res);
      assert(res.statusCode === 404, `REQUIRED: an account name with no matching org row -> 404 (got ${res.statusCode})`);
    }

    // 5. Happy path: canonical persistence + read-modify-write + updates
    // every row sharing this account name within the org (never a second,
    // parallel storage model).
    {
      patchCalls = [];
      global.fetch = mockFetch();
      const res = makeRes();
      await handler(makeReq({ accountName: 'Ridgeline Apparel', website: 'https://Ridgeline.com/about' }), res);
      assert(res.statusCode === 200 && res.body?.ok === true, `REQUIRED: a valid save succeeds (got ${res.statusCode}, ${JSON.stringify(res.body)})`);
      assert(res.body.website === 'ridgeline.com', `REQUIRED: the website is normalized via the existing normalizeDomain() utility, not stored as raw user input (got "${res.body.website}")`);
      assert(patchCalls.length === 2, `REQUIRED: BOTH ha_accounts rows sharing this org's "Ridgeline Apparel" name are updated, not just one (got ${patchCalls.length} PATCH calls)`);
      assert(!patchCalls.some(c => c.id === 'acct-b1'), 'REQUIRED (org isolation): ORG_B\'s row sharing the same account name is never patched');
      const patchForA1 = patchCalls.find(c => c.id === 'acct-a1');
      assert(patchForA1.body.raw_data.website === 'ridgeline.com', 'REQUIRED: the new website is written into raw_data.website -- the confirmed canonical location, not a new storage model');
      assert(JSON.stringify(patchForA1.body.raw_data.contacts) === JSON.stringify([{ name: 'Jordan Reyes' }]) && patchForA1.body.raw_data.location === 'Denver, CO', 'REQUIRED (read-modify-write): every other pre-existing raw_data key on this row survives the save untouched');
      const patchForA2 = patchCalls.find(c => c.id === 'acct-a2');
      assert(patchForA2.body.raw_data.intelligenceMode === 'historical' && patchForA2.body.raw_data.website === 'ridgeline.com', 'REQUIRED: the second row\'s own distinct raw_data is preserved independently while also gaining the new website');
    }

    // 6. Org isolation, directly: ORG_A's caller can never write to a row
    // that belongs only to ORG_B, even under an identical account name --
    // proven by construction above (5), reasserted here as its own named
    // check for the required-coverage list.
    {
      const orgBOnlyRow = ACCOUNTS_STORE.find(a => a.id === 'acct-b1');
      assert(orgBOnlyRow.raw_data.website === undefined, 'REQUIRED (org isolation): ORG_B\'s row was never modified by ORG_A\'s save');
    }
  } finally {
    global.fetch = realFetch;
  }
}

await run();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
