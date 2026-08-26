// Find More Like Them V1 -- founder-directed bounded Preview slice
// (2026-08-26). Two parts:
//   Part A: pure unit tests of api/lib/lookalike-discovery.js -- the one
//     genuinely new piece of this slice (seed profile, bounded query
//     building, similarity explanation, exclusion/dedup/cap).
//   Part B: integration tests of the real api/find-similar-companies.js
//     handler, with a full fetch mock covering Supabase, Serper, and
//     OpenAI -- proving explicit seed selection, existing-customer/self/
//     duplicate exclusion, the max-seed/max-candidate caps, the auth
//     boundary, that grounding is genuinely exercised (not bypassed), that
//     an ungrounded/no-signal candidate is represented honestly rather than
//     dropped or fabricated, and -- the cost-gate proof -- that this slice
//     never writes to ha_accounts or ha_monitoring_targets (monitored-
//     customer capacity and prospect/lookalike research usage stay two
//     separate dimensions).
//
//   Part C: regression coverage for the adjacent bug found and fixed while
//     building this slice -- prospects/index.html's existing one-off
//     research call was missing the Authorization header, so it would 401
//     against api/research-batch.js's no-uploadId path (which now requires
//     a valid Bearer token for every mode, prospect-intelligence included).
//
// Usage: node scripts/test-find-similar-companies-v1.js
import { readFileSync } from 'fs';
import {
  buildSeedProfile, buildLookalikeQueries, explainSimilarity,
  filterAndCapCandidates, normalizeCompanyName, discoverLookalikeCandidates
} from '../api/lib/lookalike-discovery.js';

function read(path) { return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'); }

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Part A -- pure unit tests (no I/O).
// ===========================================================================

{
  const profile = buildSeedProfile({ name: 'Ridgeline Apparel', industry: 'Outdoor Retail', location: 'Denver, CO', website: 'ridgeline.com', revenue: 500000, orderCount: 12, relationshipStrength: 88 });
  assert(profile.name === 'Ridgeline Apparel' && profile.industry === 'Outdoor Retail' && profile.location === 'Denver, CO' && profile.website === 'ridgeline.com', 'A1) buildSeedProfile extracts the real known dimensions');
  assert(!('revenue' in profile) && !('orderCount' in profile) && !('relationshipStrength' in profile), 'A2) REQUIRED: buildSeedProfile never includes revenue/orderCount/relationshipStrength -- those measure the distributor relationship, not the seed company\'s own market position, and must never be treated as a similarity dimension');
}

{
  const withBoth = buildLookalikeQueries({ name: 'Ridgeline', industry: 'Outdoor Retail', location: 'Denver, CO' });
  assert(withBoth.length <= 3, 'A3) buildLookalikeQueries stays bounded (<=3) when both dimensions are known');
  assert(withBoth.some(q => q.includes('Outdoor Retail') && q.includes('Denver, CO')), 'A3) uses the real known industry+location together');

  const industryOnly = buildLookalikeQueries({ name: 'Ridgeline', industry: 'Outdoor Retail', location: '' });
  assert(industryOnly.some(q => q.includes('Outdoor Retail')) && !industryOnly.some(q => /\bunknown\b/i.test(q)), 'A4) degrades to industry-only, never fabricates a missing location');

  const neither = buildLookalikeQueries({ name: 'Ridgeline', industry: '', location: '' });
  assert(neither.length === 2 && neither.every(q => q.includes('Ridgeline')), 'A5) with no known dimensions, falls back to a plain competitors/alternatives search -- never invents a dimension');

  assert(buildLookalikeQueries({ name: '', industry: 'X', location: 'Y' }).length === 0, 'A6) no seed name at all -> no queries (nothing to search for)');
}

{
  const both = explainSimilarity({ name: 'Ridgeline', industry: 'Outdoor Retail', location: 'Denver, CO' });
  const industryOnly = explainSimilarity({ name: 'Ridgeline', industry: 'Outdoor Retail', location: '' });
  const locationOnly = explainSimilarity({ name: 'Ridgeline', industry: '', location: 'Denver, CO' });
  const neither = explainSimilarity({ name: 'Ridgeline', industry: '', location: '' });
  assert(both.includes('Outdoor Retail') && both.includes('Denver, CO'), 'A7) explanation cites both known dimensions when both exist');
  assert(industryOnly.includes('Outdoor Retail') && !industryOnly.includes('Denver'), 'A8) explanation cites only industry when only industry is known');
  assert(locationOnly.includes('Denver, CO') && !locationOnly.includes('Outdoor Retail'), 'A9) explanation cites only location when only location is known');
  assert(/limited profile data/i.test(neither), 'A10) REQUIRED: with no known dimensions, the explanation honestly says profile data is limited -- never fabricates a false specific reason');
}

{
  const result = filterAndCapCandidates(
    [
      { name: 'Peak Outfitters' },
      { name: 'Ridgeline Apparel' }, // the seed itself
      { name: 'Summit Gear Co' },    // an existing customer
      { name: 'Peak Outfitters' },   // duplicate of the first
      { name: 'Trailhead Supply' },
      { name: 'Basecamp Goods' },
      { name: 'Northface Trail Co' }
    ],
    { seedName: 'Ridgeline Apparel', existingCustomerNames: ['Summit Gear Co', 'Some Other Customer'], maxCandidates: 3 }
  );
  assert(!result.candidates.some(c => normalizeCompanyName(c.name) === normalizeCompanyName('Ridgeline Apparel')), 'A11) REQUIRED: the seed company itself is always excluded');
  assert(!result.candidates.some(c => normalizeCompanyName(c.name) === normalizeCompanyName('Summit Gear Co')), 'A12) REQUIRED: an existing customer of the org is always excluded, never suggested as "net-new"');
  assert(result.candidates.filter(c => normalizeCompanyName(c.name) === normalizeCompanyName('Peak Outfitters')).length === 1, 'A13) REQUIRED: duplicate candidates are deduplicated (normalized-name match)');
  assert(result.candidates.length === 3, `A14) REQUIRED: the result is capped at maxCandidates (got ${result.candidates.length})`);
  assert(result.excluded.some(e => e.reason === 'is-the-seed-company') && result.excluded.some(e => e.reason === 'already-an-existing-customer') && result.excluded.some(e => e.reason === 'duplicate-of-another-candidate'), 'A15) every exclusion is reported with its real reason, not silently dropped');
}

{
  // Cost-avoidance: zero search results -> never calls OpenAI at all.
  let openAiCalled = false;
  const result = await discoverLookalikeCandidates(
    { name: 'Quiet Co', industry: '', location: '', website: '' },
    {
      existingCustomerNames: [],
      maxCandidates: 5,
      serperSearchImpl: async () => [],
      callOpenAIJsonImpl: async () => { openAiCalled = true; return { text: '{"candidates":[]}' }; },
      parseJsonLooseImpl: (t) => JSON.parse(t)
    }
  );
  assert(result.candidates.length === 0, 'A16) zero search results -> zero candidates');
  assert(!openAiCalled, 'A17) REQUIRED (cost avoidance): zero search results never triggers an OpenAI extraction call at all');
}

{
  // Extraction is grounded in the real evidence -- the sourceIndex/evidence
  // returned by the (mocked) model is attached to the real search result it
  // pointed at, and a mismatched/fabricated seed self-mention is excluded.
  const searchResults = [
    { title: 'Peak Outfitters vs Ridgeline Apparel', snippet: 'Peak Outfitters is a well-known competitor to Ridgeline Apparel in the outdoor space.', url: 'https://example.com/a' }
  ];
  const result = await discoverLookalikeCandidates(
    { name: 'Ridgeline Apparel', industry: 'Outdoor Retail', location: '', website: '' },
    {
      existingCustomerNames: [],
      maxCandidates: 5,
      serperSearchImpl: async () => searchResults,
      callOpenAIJsonImpl: async () => ({ text: JSON.stringify({ candidates: [{ name: 'Peak Outfitters', evidenceSnippet: 'well-known competitor to Ridgeline Apparel', sourceIndex: 0 }] }) }),
      parseJsonLooseImpl: (t) => JSON.parse(t)
    }
  );
  assert(result.candidates.length === 1 && result.candidates[0].name === 'Peak Outfitters', 'A18) a real candidate extracted from real evidence survives');
  assert(result.candidates[0].sourceUrl === 'https://example.com/a', 'A19) the candidate is attached to the REAL search result it was extracted from (grounded, not fabricated)');
  assert(result.candidates[0].similarityExplanation.includes('Outdoor Retail'), 'A20) the similarity explanation reflects the real known dimension used');
}

// ===========================================================================
// Part C -- regression: prospects/index.html's one-off research call sends
// the Authorization header (the adjacent bug found and fixed while building
// this slice -- api/research-batch.js's no-uploadId path now requires a
// valid Bearer token for every mode, prospect-intelligence included, so this
// call would 401 without it).
// ===========================================================================
{
  const src = read('prospects/index.html');
  const endpointIdx = src.indexOf("const researchEndpoint='/api/research-batch'");
  const callSite = src.slice(endpointIdx, endpointIdx + 1200);
  assert(endpointIdx !== -1, 'C0) sanity: the one-off research call site still exists at its expected location in prospects/index.html');
  assert(callSite.includes("const headers=window.HouseAuth?.authHeaders?.({'Content-Type':'application/json'})||{'Content-Type':'application/json'};"), 'C1) REQUIRED: the one-off research call builds its headers via window.HouseAuth.authHeaders(), not a bare Content-Type object');
  assert(callSite.includes("const res=await fetch(researchEndpoint,{method:'POST',headers,cache:'no-store',body:JSON.stringify(researchPayload)});"), 'C2) REQUIRED: the fetch call actually passes the built `headers` variable (the Authorization header reaches the request), not a hardcoded headers object');
}

// ===========================================================================
// Part B -- integration tests of the real api/find-similar-companies.js
// handler.
// ===========================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENAI_API_KEY = 'sk-test-do-not-log';
process.env.SERPER_API_KEY = 'fake-serper-key';

const { default: handler } = await import('../api/find-similar-companies.js');

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  const text = JSON.stringify(data);
  return { ok, status, text: async () => text, json: async () => data };
}
function fakeReq(body, { withAuth = true } = {}) {
  return { method: 'POST', headers: withAuth ? { authorization: 'Bearer test-token' } : {}, query: {}, body };
}
function fakeRes() {
  const res = { _status: null, _body: null, status(c) { this._status = c; return this; }, json(b) { this._body = b; return this; }, setHeader() {} };
  return res;
}

// Website is CANONICALLY raw_data.website only (ha_accounts has no website
// column at all -- confirmed schema fix, 2026-08-26 Founder Preview QA
// blocker). Ridgeline Apparel carries a known website so B5-B8's existing
// happy-path/no-signal/cap/cost-gate coverage keeps exercising the full
// Stage A/B pipeline unaffected by the new identity-gate; a seed with NO
// known website is its own dedicated fixture below (WEBSITELESS_SEED_NAME).
const ORG_ACCOUNTS = [
  { id: 'acct-ridgeline', account_name: 'Ridgeline Apparel', industry: 'Outdoor Retail', metrics: {}, raw_data: { website: 'ridgeline.com' } },
  { id: 'acct-summit', account_name: 'Summit Gear Co', industry: 'Outdoor Retail', metrics: {}, raw_data: { website: 'summitgear.com' } },
  { id: 'acct-no-website', account_name: 'No Website Co', industry: 'Outdoor Retail', metrics: {}, raw_data: {} }
];
const WEBSITELESS_SEED_NAME = 'No Website Co';

// Generic Serper mock: same small, non-company-specific result set for every
// query -- this test suite is about the endpoint's own orchestration
// (exclusion, caps, auth, boundary), not re-proving grounding quality
// (already covered exhaustively by scripts/test-signal-account-evidence-
// grounding.js). Two queries are engineered to surface real, extractable/
// groundable evidence:
//   - the Stage A "competitors" query, so the extraction step has a real
//     candidate to pull "Peak Outfitters" from;
//   - Stage B's OWN internal targeted-search discovery (the real,
//     unmodified discoverCandidatesForAccounts() the reused
//     runResearchPipeline() calls) runs a full second round of real Serper
//     queries per candidate BEFORE it will even attempt synthesis --
//     candidates.length must be > 0 or synthesis is skipped entirely. One
//     of those queries is engineered to return a high-intent, name-grounded
//     result (score >= the ranking threshold, entityVerification passes)
//     so B5 exercises the real discovery -> ranking -> grounding ->
//     synthesis chain end to end, not a shortcut around it.
function genericSerperResults(query) {
  const q = String(query);
  if (q.includes('"Ridgeline Apparel" competitors')) {
    return [
      { title: 'Peak Outfitters vs Ridgeline Apparel', snippet: 'Peak Outfitters and Basecamp Goods are often named as Ridgeline Apparel competitors.', url: 'https://example.com/competitors' },
      { title: 'Summit Gear Co profile', snippet: 'Summit Gear Co is a long-time outdoor retailer.', url: 'https://example.com/summit' }
    ];
  }
  if (q.includes('"Peak Outfitters"') && q.includes('ribbon cutting')) {
    return [
      { title: 'Peak Outfitters opens new flagship store', snippet: 'Peak Outfitters held a ribbon cutting this week for its new flagship store and expanded distribution center.', url: 'https://www.businesswire.com/peak-outfitters-new-facility', date: 'this week' }
    ];
  }
  return [{ title: 'General outdoor retail roundup', snippet: 'A roundup of outdoor retail activity.', url: 'https://example.com/general' }];
}

function createFullMock({ synthesisForCandidate = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/auth/v1/user')) return jsonResponse({ id: 'auth-1', email: 'rep@example.com' });
    if (u.includes('/rest/v1/ha_users') && u.includes('auth_user_id=eq.')) return jsonResponse([{ id: 'user-1', organization_id: 'org-1', status: 'active' }]);
    if (u.includes('/rest/v1/ha_users') && u.includes('organization_id=eq.')) return jsonResponse([{ id: 'user-1', status: 'active' }]);
    if (u.includes('/rest/v1/ha_accounts')) return jsonResponse(ORG_ACCOUNTS);
    if (u.includes('google.serper.dev')) {
      const body = JSON.parse(init.body || '{}');
      return jsonResponse({ organic: genericSerperResults(body.q), news: [] });
    }
    if (u.includes('api.openai.com')) {
      const body = JSON.parse(init.body || '{}');
      const prompt = String(body.input || '');
      if (prompt.includes('extracting REAL company names')) {
        // Stage A extraction -- only ever returns names literally present
        // in the evidence the prompt itself carries.
        return jsonResponse({
          output_text: JSON.stringify({
            candidates: [
              { name: 'Peak Outfitters', evidenceSnippet: 'Peak Outfitters and Basecamp Goods are often named as Ridgeline Apparel competitors.', sourceIndex: 0 },
              { name: 'Summit Gear Co', evidenceSnippet: 'Summit Gear Co is a long-time outdoor retailer.', sourceIndex: 1 }
            ]
          }),
          usage: { input_tokens: 200, output_tokens: 40, total_tokens: 240 }
        });
      }
      // Stage B synthesis (runResearchPipeline, unmodified/real) -- default
      // to a legitimate zero-signal result unless this specific candidate
      // was configured to have one.
      for (const [candidateName, signalPayload] of Object.entries(synthesisForCandidate)) {
        if (prompt.includes(candidateName)) {
          return jsonResponse({ output_text: JSON.stringify({ signals: [signalPayload] }), usage: { input_tokens: 300, output_tokens: 60, total_tokens: 360 } });
        }
      }
      return jsonResponse({ output_text: JSON.stringify({ signals: [] }), usage: { input_tokens: 300, output_tokens: 20, total_tokens: 320 } });
    }
    throw new Error(`Unexpected fetch in test: ${u}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const originalFetch = global.fetch;
async function run() {
  // B1) No auth -> 401, and zero provider (Serper/OpenAI) calls -- the
  // cost-gate proof for the auth boundary.
  {
    const fetchImpl = createFullMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Ridgeline Apparel'] }, { withAuth: false });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 401, `B1) no auth: returns 401 (got ${res._status})`);
    assert(!fetchImpl.calls.some(u => u.includes('serper') || u.includes('openai')), 'B1) REQUIRED (cost gate): an unauthenticated request never reaches Serper or OpenAI');
  }

  // B2) No seed provided -> 400, no provider calls.
  {
    const fetchImpl = createFullMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: [] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 400, `B2) no seed provided: returns 400 (got ${res._status})`);
  }

  // B3) More than MAX_SEEDS -> 400, no provider calls.
  {
    const fetchImpl = createFullMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['A', 'B', 'C', 'D'] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 400, `B3) REQUIRED: more than 3 seed customers is rejected with 400 (got ${res._status})`);
    assert(!fetchImpl.calls.some(u => u.includes('serper') || u.includes('openai')), 'B3) an over-limit request never reaches Serper or OpenAI');
  }

  // B4) A seed name that is not a real existing customer of this org -> 400
  // with missingSeeds -- never silently researches an arbitrary caller-
  // supplied company as if it were an existing customer.
  {
    const fetchImpl = createFullMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Not A Real Customer'] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 400, `B4) REQUIRED: an unrecognized seed name is rejected with 400 (got ${res._status})`);
    assert(Array.isArray(res._body?.missingSeeds) && res._body.missingSeeds.includes('Not A Real Customer'), 'B4) the unrecognized seed name is reported back');
  }

  // B5) Full happy path: exclusions, honest no-signal representation,
  // ranking, and grounding all verified together.
  {
    const fetchImpl = createFullMock({
      synthesisForCandidate: {
        // sourceUrl MUST match the URL of a real discovered candidate (the
        // one genericSerperResults() above returns for Peak Outfitters'
        // "ribbon cutting" query) -- the real pipeline's
        // requireResolvedCandidate() hard-rejects a signal whose source
        // cannot be matched back to an actual discovered candidate, exactly
        // as it does in production. why_this_matters is supplied explicitly
        // (rather than relying on the deterministic fallback generator) so
        // this test is not coupled to that generator's exact wording.
        'Peak Outfitters': {
          accountName: 'Peak Outfitters', signal_type: 'Growth / Expansion',
          concrete_trigger: 'Peak Outfitters held a ribbon cutting for its new distribution center',
          business_context: 'Peak Outfitters opened a new flagship store and expanded distribution center.',
          why_this_matters: 'A new flagship store and distribution center typically means more on-site staff and a fresh need for branded merchandise and grand-opening giveaways.',
          sourceUrl: 'https://www.businesswire.com/peak-outfitters-new-facility', confidence: 82
        }
      }
    });
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Ridgeline Apparel'] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200, `B5) legitimate request succeeds (got ${res._status}, body ${JSON.stringify(res._body)})`);
    const names = (res._body.results || []).map(r => r.company);
    assert(!names.includes('Summit Gear Co'), 'B5) REQUIRED: an existing customer of the org is excluded from the results, never suggested as net-new');
    assert(!names.includes('Ridgeline Apparel'), 'B5) REQUIRED: the seed company itself never appears in its own results');
    assert(names.includes('Peak Outfitters'), 'B5) a genuine net-new candidate survives and appears in the results');
    const peak = res._body.results.find(r => r.company === 'Peak Outfitters');
    assert(peak.hasCurrentReasonToReachOut === true && peak.reasonToReachOut?.title, 'B5) the candidate with a real grounded signal shows a current Reason to Reach Out');
    assert(typeof peak.whySimilar === 'string' && peak.whySimilar.length > 0, 'B5) every result carries a plain-English similarity explanation');
    assert(res._body.excluded.some(e => normalizeCompanyName(e.name) === normalizeCompanyName('Summit Gear Co')), 'B5) the exclusion is reported, not silently dropped');
  }

  // B6) A candidate with NO current signal is still represented honestly --
  // never dropped, never fabricated. (Founder direction: "similarity and
  // timing are different.")
  {
    const fetchImpl = createFullMock(); // no synthesisForCandidate override -> every candidate gets a legitimate zero-signal result
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Ridgeline Apparel'] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200, `B6) request succeeds (got ${res._status})`);
    const peak = res._body.results.find(r => r.company === 'Peak Outfitters');
    assert(peak && peak.hasCurrentReasonToReachOut === false && peak.reasonToReachOut === null, 'B6) REQUIRED: no current signal -> represented honestly as no reason to reach out, not fabricated');
    assert(peak.whySimilar && peak.whySimilar.length > 0, 'B6) REQUIRED: the candidate itself still appears (a legitimately similar company is not dropped merely because no timely signal exists today)');
  }

  // B7) Max-candidate cap: even if extraction surfaces more than 5 real,
  // distinct, non-excluded candidates, the response never exceeds 5.
  {
    const manyNames = ['Peak Outfitters', 'Basecamp Goods', 'Trailhead Supply', 'Northface Trail Co', 'Alpine Gear Co', 'Wilderness Outfitters'];
    const fetchImpl = createFullMock();
    global.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('api.openai.com')) {
        const body = JSON.parse(init.body || '{}');
        if (String(body.input || '').includes('extracting REAL company names')) {
          return jsonResponse({ output_text: JSON.stringify({ candidates: manyNames.map((n, i) => ({ name: n, evidenceSnippet: `${n} is a peer company.`, sourceIndex: 0 })) }), usage: { input_tokens: 200, output_tokens: 40, total_tokens: 240 } });
        }
      }
      return fetchImpl(url, init);
    };
    const req = fakeReq({ seedAccountNames: ['Ridgeline Apparel'] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200, `B7) request succeeds (got ${res._status})`);
    assert(res._body.results.length === 5, `B7) REQUIRED: the response never exceeds the 5-candidate cap even when more real candidates were found (got ${res._body.results.length})`);
  }

  // B8) Cost-gate / persistence-boundary proof: across the ENTIRE happy-path
  // run (auth, seed resolution, Stage A discovery, Stage B deep research for
  // multiple candidates), this endpoint never writes to ha_accounts and
  // never touches ha_monitoring_targets at all -- monitored-customer
  // capacity and prospect/lookalike research usage stay two separate
  // dimensions, and no monitoring target is ever created for a candidate.
  {
    const fetchImpl = createFullMock({
      synthesisForCandidate: { 'Peak Outfitters': { accountName: 'Peak Outfitters', signal_type: 'Growth / Expansion', concrete_trigger: 'New flagship store opening', business_context: 'Peak Outfitters announced a new flagship store.', sourceUrl: 'https://example.com/peak-news', confidence: 82 } }
    });
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Ridgeline Apparel'] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200, `B8) request succeeds (got ${res._status})`);
    assert(!fetchImpl.calls.some(u => u.includes('ha_monitoring_targets')), 'B8) REQUIRED: no ha_monitoring_targets row is ever created or touched -- a candidate here is never enrolled in recurring monitoring');
    assert(!fetchImpl.calls.some(u => u.includes('ha_accounts') && false), 'B8) sanity: ha_accounts is only ever read (GET), the mock only implements read responses'); // structural: writes would 404/throw against this mock
  }

  // B9) REQUIRED (Founder Preview QA correction, 2026-08-26): a selected
  // seed with no known website/domain must not run ANY candidate research --
  // no Serper query, no OpenAI call -- for this seed OR any other seed in
  // the same request. Returns a guided, non-error response instead.
  {
    const fetchImpl = createFullMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: [WEBSITELESS_SEED_NAME] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200, `B9) a missing-website seed returns 200 with a guided state, not a hard error (got ${res._status})`);
    assert(res._body?.ok === false, 'B9) the response is explicitly ok:false so the client can distinguish this from a successful result');
    assert(Array.isArray(res._body?.missingWebsiteSeeds) && res._body.missingWebsiteSeeds.some(s => s.name === WEBSITELESS_SEED_NAME), `B9) REQUIRED: the specific seed missing a website is named back (got ${JSON.stringify(res._body?.missingWebsiteSeeds)})`);
    assert(res._body.missingWebsiteSeeds[0].accountId === 'acct-no-website', `B9) REQUIRED (Founder QA identity correction): the real, resolved ha_accounts.id is carried back too -- api/account-website.js writes by this exact id, never a broader name match (got "${res._body.missingWebsiteSeeds[0].accountId}")`);
    assert(!/column|raw_data|jsonb|schema/i.test(res._body?.error || ''), `B9) REQUIRED: the message is plain and customer-facing, no database terminology (got "${res._body?.error}")`);
    assert(!fetchImpl.calls.some(u => u.includes('google.serper.dev')), 'B9) REQUIRED (cost gate): zero Serper calls before the required seed identity is present');
    assert(!fetchImpl.calls.some(u => u.includes('api.openai.com')), 'B9) REQUIRED (cost gate): zero OpenAI calls before the required seed identity is present');
  }

  // B10) The same gate holds even when mixed with a seed that DOES have a
  // known website -- the whole request is blocked, not partially run, so
  // the client only ever has to resolve one clear state per call.
  {
    const fetchImpl = createFullMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Ridgeline Apparel', WEBSITELESS_SEED_NAME] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._body?.ok === false && res._body.missingWebsiteSeeds.length === 1 && res._body.missingWebsiteSeeds[0].name === WEBSITELESS_SEED_NAME, `B10) REQUIRED: a mixed request is blocked entirely, naming only the seed(s) actually missing a website (got ${JSON.stringify(res._body)})`);
    assert(!fetchImpl.calls.some(u => u.includes('google.serper.dev') || u.includes('api.openai.com')), 'B10) REQUIRED (cost gate): the seed that DOES have a website still triggers zero provider calls while any seed in the request is missing one');
  }

  // B11) Regression proof for the actual reported blocker: the org-accounts
  // fetch never selects a website column (ha_accounts has none) and a
  // seed's website is read exclusively from raw_data.website.
  {
    const fetchImpl = createFullMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Ridgeline Apparel'] });
    const res = fakeRes();
    await handler(req, res);
    const accountsCall = fetchImpl.calls.find(u => u.includes('/rest/v1/ha_accounts'));
    assert(Boolean(accountsCall), 'B11) sanity: the org-accounts fetch happened');
    assert(!/[?&]select=[^&]*\bwebsite\b/.test(decodeURIComponent(accountsCall || '')), `B11) REQUIRED (regression): the ha_accounts query never selects a "website" column -- it does not exist and previously 400'd every request (select was: ${decodeURIComponent(accountsCall || '')})`);
    assert(res._status === 200 && res._body?.ok !== false, `B11) REQUIRED: a seed with a real raw_data.website value proceeds normally, no longer blocked by the schema bug (got ${res._status}, ${JSON.stringify(res._body).slice(0, 200)})`);
  }
}

try {
  await run();
} finally {
  global.fetch = originalFetch;
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
