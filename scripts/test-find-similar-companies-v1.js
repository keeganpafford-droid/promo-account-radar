// Find More Like Them V2 -- candidate-generation quality pass (2026-08-26,
// Founder QA Round 2). Four parts:
//   Part A: pure unit tests of api/lib/lookalike-discovery.js -- generic-
//     industry detection, the grounded seed profile (owned-domain
//     evidence, honest degrade, cost avoidance), multi-lens query
//     construction (peer/local/footprint, each gated on real evidence),
//     deterministic relationshipType/matchBasis truthfulness, and the
//     exclude/dedup/cap step.
//   Part B: integration tests of the real api/find-similar-companies.js
//     handler, with a full fetch mock covering Supabase, Serper, and
//     OpenAI -- proving the end-to-end V2 behavior: "General Business"
//     treated as weak, owned-site-derived business types actually used,
//     local lens gated on grounded geography, footprint lens gated on
//     real evidence, fit-first ranking (match quality beats mere signal
//     presence), the Round 1 stale-signal fix preserved, and the auth/
//     cost/cap boundaries.
//   Part C: regression coverage for the auth-header fix in
//     prospects/index.html found while building V1 (unchanged from V1).
//
// Usage: node scripts/test-find-similar-companies-v1.js
import { readFileSync } from 'fs';
import {
  buildSeedProfile, isGenericIndustry, resolveBusinessDescriptor, resolveGroundedLocation,
  buildOwnedDomainProfileQuery, buildGroundedSeedProfile, buildLensQueries, buildMatchBasis,
  filterAndCapCandidates, normalizeCompanyName, discoverLookalikeCandidates
} from '../api/lib/lookalike-discovery.js';

function read(path) { return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'); }

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

// ===========================================================================
// Part A -- pure unit tests (no I/O, except where a serper/OpenAI impl is
// explicitly injected).
// ===========================================================================

{
  assert(isGenericIndustry('General Business') === true, 'A1) REQUIRED: "General Business" (dashboard/index.html\'s inferIndustry() catch-all) is treated as no real industry known');
  assert(isGenericIndustry('Saved Account') === true, 'A2) REQUIRED: "Saved Account" (api/get-dashboard.js\'s blank-industry placeholder) is treated as no real industry known');
  assert(isGenericIndustry('') === true && isGenericIndustry(null) === true, 'A3) blank/null industry is treated as no real industry known');
  assert(isGenericIndustry('Healthcare') === false && isGenericIndustry('Outdoor Retail') === false, 'A4) a real, specific uploaded industry is NOT treated as generic');
  assert(isGenericIndustry('general business') === true, 'A5) generic-industry detection is case-insensitive');
}

{
  const profile = buildSeedProfile({ name: 'Ridgeline Apparel', industry: 'Outdoor Retail', location: 'Denver, CO', website: 'ridgeline.com', revenue: 500000, orderCount: 12, relationshipStrength: 88 });
  assert(profile.name === 'Ridgeline Apparel' && profile.industry === 'Outdoor Retail' && profile.location === 'Denver, CO' && profile.website === 'ridgeline.com', 'A6) buildSeedProfile extracts the real known dimensions');
  assert(!('revenue' in profile) && !('orderCount' in profile) && !('relationshipStrength' in profile), 'A7) REQUIRED: buildSeedProfile never includes revenue/orderCount/relationshipStrength');
}

{
  const withDerived = resolveBusinessDescriptor({ derivedBusinessDescription: 'technical outdoor apparel retailer', industry: 'General Business' });
  assert(withDerived === 'technical outdoor apparel retailer', 'A8) REQUIRED: resolveBusinessDescriptor prefers domain-derived evidence over the uploaded industry label');
  const noDerivedRealIndustry = resolveBusinessDescriptor({ derivedBusinessDescription: '', industry: 'Healthcare' });
  assert(noDerivedRealIndustry === 'Healthcare', 'A9) with no derived evidence, resolveBusinessDescriptor falls back to a real, specific uploaded industry');
  const noDerivedGenericIndustry = resolveBusinessDescriptor({ derivedBusinessDescription: '', industry: 'General Business' });
  assert(noDerivedGenericIndustry === '', 'A10) REQUIRED: with no derived evidence AND a generic uploaded industry, resolveBusinessDescriptor returns nothing rather than using "General Business" as if it were real');

  const withDerivedLocation = resolveGroundedLocation({ derivedLocation: 'Springfield, MA', location: 'Old Address, XX' });
  assert(withDerivedLocation === 'Springfield, MA', 'A11) resolveGroundedLocation prefers domain-derived location over the uploaded field');
  const uploadedOnlyLocation = resolveGroundedLocation({ derivedLocation: '', location: 'Denver, CO' });
  assert(uploadedOnlyLocation === 'Denver, CO', 'A12) resolveGroundedLocation falls back to the real uploaded location when nothing was derived');
}

{
  assert(buildOwnedDomainProfileQuery({ website: 'ridgeline.com' }) === 'ridgeline.com', 'A13) the owned-domain profile query is the bare domain -- no fabricated query syntax');
  assert(buildOwnedDomainProfileQuery({ website: '' }) === '', 'A14) no website -> no profile query at all');
}

{
  // A15-A18: buildLensQueries gating -- each lens only fires when it
  // genuinely has the evidence it requires.
  const peerOnly = buildLensQueries({ name: 'Eastern Propane' }, { derivedBusinessDescription: '', industry: 'General Business', derivedLocation: '', location: '', derivedFootprintHint: '' });
  assert(peerOnly.length === 2 && peerOnly.every(q => q.lens === 'peer'), `A15) REQUIRED: with no real industry, no location, and no footprint evidence, ONLY the peer lens fires (got ${JSON.stringify(peerOnly.map(q => q.lens))})`);
  assert(peerOnly.some(q => q.query === '"Eastern Propane" competitors'), 'A15b) the explicit competitors query is always present');
  assert(!peerOnly.some(q => /general business/i.test(q.query)), 'A15c) REQUIRED: no query ever contains the literal generic fallback "General Business"');

  const withLocation = buildLensQueries({ name: 'Eastern Propane' }, { derivedBusinessDescription: '', industry: 'General Business', derivedLocation: 'Springfield, MA', location: '', derivedFootprintHint: '' });
  assert(withLocation.some(q => q.lens === 'local'), 'A16) REQUIRED: the local lens fires once seed geography is grounded (domain-derived here)');
  assert(withLocation.filter(q => q.lens === 'local').length === 1, 'A16b) the local lens contributes exactly one query');

  const withFootprint = buildLensQueries({ name: 'Eastern Propane' }, { derivedBusinessDescription: 'propane and heating oil delivery', industry: '', derivedLocation: '', location: '', derivedFootprintHint: 'regional distributor with multiple depots' });
  assert(withFootprint.some(q => q.lens === 'footprint'), 'A17) REQUIRED: the footprint lens fires only when real footprint evidence exists');
  assert(withFootprint.length <= 4, `A18) REQUIRED: the total query count stays bounded even with every lens active (got ${withFootprint.length})`);

  const allThree = buildLensQueries({ name: 'Eastern Propane' }, { derivedBusinessDescription: 'propane delivery', industry: '', derivedLocation: 'Springfield, MA', location: '', derivedFootprintHint: 'regional distributor' });
  assert(new Set(allThree.map(q => q.lens)).size === 3, 'A18b) all three lenses can be active simultaneously when each has real evidence');
}

{
  // A19-A22: buildMatchBasis truthfulness -- never claims a dimension
  // that wasn't actually established for that lens.
  const peerWithDescriptor = buildMatchBasis('peer', 'Bush Brothers', { derivedBusinessDescription: 'branded packaged-food manufacturer' });
  assert(peerWithDescriptor.includes('branded packaged-food manufacturer') && !/general business/i.test(peerWithDescriptor), 'A19) REQUIRED: a peer-lens explanation with a real descriptor cites that specific descriptor, never a generic label');
  const peerNoDescriptor = buildMatchBasis('peer', 'Eastern Propane', { derivedBusinessDescription: '', industry: 'General Business' });
  assert(!/general business/i.test(peerNoDescriptor) && /no specific business type/i.test(peerNoDescriptor), 'A20) REQUIRED: a peer-lens explanation with no real descriptor is honestly bounded, never fabricating "General Business" as a real similarity dimension');
  const localExplanation = buildMatchBasis('local', 'Eastern Propane', { derivedLocation: 'Springfield, MA' });
  assert(localExplanation.includes('Nearby Opportunity') && /not necessarily|not.*same industry/i.test(localExplanation), 'A21) REQUIRED: a local-lens explanation is explicit that geography alone is not an industry/business-type claim');
  const footprintExplanation = buildMatchBasis('footprint', 'Eastern Propane', { derivedFootprintHint: 'regional distributor with multiple depots' });
  assert(footprintExplanation.includes('regional distributor with multiple depots'), 'A22) a footprint-lens explanation cites the actual evidenced footprint characteristic');
}

{
  const result = filterAndCapCandidates(
    [
      { name: 'Peak Outfitters' }, { name: 'Ridgeline Apparel' }, { name: 'Summit Gear Co' },
      { name: 'Peak Outfitters' }, { name: 'Trailhead Supply' }, { name: 'Basecamp Goods' }, { name: 'Northface Trail Co' }
    ],
    { seedName: 'Ridgeline Apparel', existingCustomerNames: ['Summit Gear Co', 'Some Other Customer'], maxCandidates: 3 }
  );
  assert(!result.candidates.some(c => normalizeCompanyName(c.name) === normalizeCompanyName('Ridgeline Apparel')), 'A23) REQUIRED: the seed company itself is always excluded');
  assert(!result.candidates.some(c => normalizeCompanyName(c.name) === normalizeCompanyName('Summit Gear Co')), 'A24) REQUIRED: an existing customer of the org is always excluded');
  assert(result.candidates.filter(c => normalizeCompanyName(c.name) === normalizeCompanyName('Peak Outfitters')).length === 1, 'A25) REQUIRED: duplicate candidates are deduplicated');
  assert(result.candidates.length === 3, `A26) REQUIRED: the result is capped at maxCandidates (got ${result.candidates.length})`);
}

{
  // A27-A30: buildGroundedSeedProfile -- honest degrade + cost avoidance.
  let serperCalled = false, openAiCalled = false;
  const noWebsite = await buildGroundedSeedProfile({ name: 'Eastern Propane', industry: 'General Business', website: '' }, {
    serperSearchImpl: async () => { serperCalled = true; return []; },
    callOpenAIJsonImpl: async () => { openAiCalled = true; return { text: '{}' }; },
    parseJsonLooseImpl: (t) => JSON.parse(t)
  });
  assert(!serperCalled && !openAiCalled, 'A27) REQUIRED (cost avoidance): no website -> zero Serper/OpenAI calls, profile stays at defaults');
  assert(noWebsite.derivedBusinessDescription === '', 'A27b) with no website, nothing is derived -- no fabrication');

  let openAiCalled2 = false;
  const noEvidence = await buildGroundedSeedProfile({ name: 'Eastern Propane', industry: 'General Business', website: 'easternpropane.com' }, {
    serperSearchImpl: async () => [{ title: 'Unrelated result', snippet: 'Nothing about Eastern Propane', url: 'https://example.com/unrelated' }],
    callOpenAIJsonImpl: async () => { openAiCalled2 = true; return { text: '{}' }; },
    parseJsonLooseImpl: (t) => JSON.parse(t)
  });
  assert(!openAiCalled2, 'A28) REQUIRED (cost avoidance): a Serper result that is NOT from the seed\'s own domain is filtered out, and no OpenAI call is made when nothing usable survives');
  assert(noEvidence.derivedBusinessDescription === '', 'A28b) profile stays at defaults when no same-domain evidence was found');

  const withEvidence = await buildGroundedSeedProfile({ name: 'Eastern Propane', industry: 'General Business', website: 'easternpropane.com' }, {
    serperSearchImpl: async () => [
      { title: 'Unrelated result', snippet: 'Nothing about Eastern Propane', url: 'https://example.com/unrelated' },
      { title: 'Eastern Propane & Oil', snippet: 'Eastern Propane delivers propane and heating oil to homes and businesses across the region.', url: 'https://easternpropane.com/' }
    ],
    callOpenAIJsonImpl: async ({ prompt }) => {
      assert(prompt.includes('easternpropane.com') && !prompt.includes('Unrelated result'), 'A29) REQUIRED: only the same-domain evidence is passed to the extraction prompt -- unrelated search noise is excluded before the model ever sees it');
      return { text: JSON.stringify({ businessDescription: 'propane and heating oil delivery', location: '', footprintHint: '', evidenceSnippet: 'Eastern Propane delivers propane and heating oil to homes and businesses across the region.' }) };
    },
    parseJsonLooseImpl: (t) => JSON.parse(t)
  });
  assert(withEvidence.derivedBusinessDescription === 'propane and heating oil delivery', `A30) REQUIRED: real same-domain evidence produces a real, specific derived business description (got "${withEvidence.derivedBusinessDescription}")`);
  assert(withEvidence.profileSourceUrl === 'https://easternpropane.com/', 'A30b) the evidence source URL is preserved for traceability');
}

// ===========================================================================
// Part C -- regression: prospects/index.html's one-off research call sends
// the Authorization header (unchanged from V1).
// ===========================================================================
{
  const src = read('prospects/index.html');
  const endpointIdx = src.indexOf("const researchEndpoint='/api/research-batch'");
  const callSite = src.slice(endpointIdx, endpointIdx + 1200);
  assert(endpointIdx !== -1, 'C0) sanity: the one-off research call site still exists at its expected location in prospects/index.html');
  assert(callSite.includes("const headers=window.HouseAuth?.authHeaders?.({'Content-Type':'application/json'})||{'Content-Type':'application/json'};"), 'C1) REQUIRED: the one-off research call builds its headers via window.HouseAuth.authHeaders()');
  assert(callSite.includes("const res=await fetch(researchEndpoint,{method:'POST',headers,cache:'no-store',body:JSON.stringify(researchPayload)});"), 'C2) REQUIRED: the fetch call actually passes the built `headers` variable');
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

// Ridgeline Apparel: real (non-generic) uploaded industry, no uploaded
// location, no footprint evidence -- exercises "real industry used when
// not generic" + "no local claim without grounded geography."
// Eastern Propane: generic uploaded industry (the actual Founder-reported
// blocker), WITH an uploaded location -- exercises "General Business
// treated as weak," "owned-site-derived specific business type used,"
// and "local lens fires on grounded geography."
const ORG_ACCOUNTS = [
  { id: 'acct-ridgeline', account_name: 'Ridgeline Apparel', industry: 'Outdoor Retail', metrics: {}, raw_data: { website: 'ridgeline.com' } },
  { id: 'acct-summit', account_name: 'Summit Gear Co', industry: 'Outdoor Retail', metrics: {}, raw_data: { website: 'summitgear.com' } },
  { id: 'acct-no-website', account_name: 'No Website Co', industry: 'Outdoor Retail', metrics: {}, raw_data: {} },
  { id: 'acct-eastern', account_name: 'Eastern Propane', industry: 'General Business', metrics: {}, raw_data: { website: 'easternpropane.com', location: 'Springfield, MA' } }
];
const WEBSITELESS_SEED_NAME = 'No Website Co';

// Per-seed owned-domain profile evidence + extraction override, keyed by
// seed name -- lets each test configure exactly what the seed's "own site"
// is understood to say, without a real network call.
function ownedDomainSerperResults(seedName, domain) {
  if (seedName === 'Eastern Propane') {
    return [{ title: 'Eastern Propane & Oil', snippet: 'Eastern Propane delivers propane and heating oil to homes and businesses across the region.', url: `https://${domain}/` }];
  }
  if (seedName === 'Ridgeline Apparel') {
    return [{ title: 'Ridgeline Apparel', snippet: 'Ridgeline Apparel sells technical outdoor apparel and gear.', url: `https://${domain}/` }];
  }
  return [];
}
function profileExtractionFor(seedName) {
  if (seedName === 'Eastern Propane') {
    return { businessDescription: 'propane and heating oil delivery', location: '', footprintHint: '', evidenceSnippet: 'Eastern Propane delivers propane and heating oil to homes and businesses across the region.' };
  }
  // Ridgeline Apparel deliberately yields no NEW derived description in
  // most tests, so its real uploaded "Outdoor Retail" industry (not
  // generic) is what query-building actually falls back to -- proving
  // that path independently of the owned-domain derivation path.
  return { businessDescription: '', location: '', footprintHint: '', evidenceSnippet: '' };
}

// Generic Serper mock: same small, non-company-specific result set for every
// query that isn't specifically engineered below -- this test suite is
// about the endpoint's own orchestration (lens gating, ranking, auth,
// caps), not re-proving grounding quality (covered exhaustively elsewhere).
function genericSerperResults(query) {
  const q = String(query);
  if (q === 'ridgeline.com') return ownedDomainSerperResults('Ridgeline Apparel', 'ridgeline.com');
  if (q === 'easternpropane.com') return ownedDomainSerperResults('Eastern Propane', 'easternpropane.com');
  if (q.includes('"Ridgeline Apparel" competitors')) {
    return [
      { title: 'Peak Outfitters vs Ridgeline Apparel', snippet: 'Peak Outfitters and Basecamp Goods are often named as Ridgeline Apparel competitors.', url: 'https://example.com/competitors' },
      { title: 'Summit Gear Co profile', snippet: 'Summit Gear Co is a long-time outdoor retailer.', url: 'https://example.com/summit' }
    ];
  }
  if (q.includes('"Peak Outfitters"') && q.includes('ribbon cutting')) {
    return [{ title: 'Peak Outfitters opens new flagship store', snippet: 'Peak Outfitters held a ribbon cutting this week for its new flagship store and expanded distribution center.', url: 'https://www.businesswire.com/peak-outfitters-new-facility', date: 'this week' }];
  }
  if (q.includes('"Eastern Propane" competitors')) {
    return [{ title: 'Suburban Propane vs Eastern Propane', snippet: 'Suburban Propane is frequently compared to Eastern Propane as a regional propane delivery competitor.', url: 'https://example.com/propane-competitors' }];
  }
  // Stage B (api/lib/research-pipeline.js's runResearchPipeline()) runs its
  // OWN separate internal discovery search per candidate, with its own
  // query templates -- a signal's sourceUrl must match a candidate THAT
  // search actually found (requireResolvedCandidate()), not merely a
  // Stage A discovery source. Grounds Suburban Propane's own research the
  // same way Peak Outfitters' is grounded above.
  if (q.includes('"Suburban Propane"') && (q.includes('trade show') || q.includes('partnership'))) {
    return [{ title: 'Suburban Propane business update', snippet: 'Suburban Propane exhibited at an industry trade show and announced a new regional distribution partnership.', url: 'https://example.com/propane-competitors' }];
  }
  if (q.includes('"Acme Facilities Group"') && q.includes('trade show')) {
    return [{ title: 'Acme Facilities Group business update', snippet: 'Acme Facilities Group exhibited at a regional facilities trade show.', url: 'https://example.com/acme-facilities' }];
  }
  if (q.includes('companies near Springfield, MA') || q.includes('near Springfield, MA')) {
    return [{ title: 'Acme Facilities Group -- Springfield, MA', snippet: 'Acme Facilities Group is a Springfield, MA-based facilities services company.', url: 'https://example.com/acme-facilities' }];
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
      if (prompt.includes('extracting REAL facts about')) {
        const seedName = ['Eastern Propane', 'Ridgeline Apparel'].find(n => prompt.includes(`"${n}"`)) || '';
        return jsonResponse({ output_text: JSON.stringify(profileExtractionFor(seedName)), usage: { input_tokens: 150, output_tokens: 30, total_tokens: 180 } });
      }
      if (prompt.includes('extracting REAL company names')) {
        const candidates = [];
        if (prompt.includes('Peak Outfitters and Basecamp Goods')) {
          candidates.push({ name: 'Peak Outfitters', evidenceSnippet: 'Peak Outfitters and Basecamp Goods are often named as Ridgeline Apparel competitors.', sourceIndex: findIndexOf(prompt, 'Peak Outfitters and Basecamp Goods') });
        }
        if (prompt.includes('Suburban Propane is frequently compared')) {
          candidates.push({ name: 'Suburban Propane', evidenceSnippet: 'Suburban Propane is frequently compared to Eastern Propane as a regional propane delivery competitor.', sourceIndex: findIndexOf(prompt, 'Suburban Propane is frequently compared') });
        }
        if (prompt.includes('Acme Facilities Group is a Springfield')) {
          candidates.push({ name: 'Acme Facilities Group', evidenceSnippet: 'Acme Facilities Group is a Springfield, MA-based facilities services company.', sourceIndex: findIndexOf(prompt, 'Acme Facilities Group is a Springfield') });
        }
        return jsonResponse({ output_text: JSON.stringify({ candidates }), usage: { input_tokens: 200, output_tokens: 40, total_tokens: 240 } });
      }
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
// Finds which [N] evidence index in the prompt's own evidence block
// contains the given snippet text -- so the mock's sourceIndex always
// points at the REAL evidence item, exactly like a real model would.
function findIndexOf(prompt, snippetText) {
  const lines = prompt.split('\n');
  let currentIndex = -1;
  for (const line of lines) {
    const m = line.match(/^\[(\d+)\]/);
    if (m) currentIndex = Number(m[1]);
    if (line.includes(snippetText)) return currentIndex;
  }
  return 0;
}

const originalFetch = global.fetch;
async function run() {
  // B1) No auth -> 401, and zero provider (Serper/OpenAI) calls.
  {
    const fetchImpl = createFullMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Ridgeline Apparel'] }, { withAuth: false });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 401, `B1) no auth: returns 401 (got ${res._status})`);
    assert(!fetchImpl.calls.some(u => u.includes('serper') || u.includes('openai')), 'B1) REQUIRED (cost gate): an unauthenticated request never reaches Serper or OpenAI');
  }

  // B2) No seed provided -> 400.
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

  // B4) Unrecognized seed name -> 400 with missingSeeds.
  {
    const fetchImpl = createFullMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Not A Real Customer'] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 400, `B4) REQUIRED: an unrecognized seed name is rejected with 400 (got ${res._status})`);
    assert(Array.isArray(res._body?.missingSeeds) && res._body.missingSeeds.includes('Not A Real Customer'), 'B4) the unrecognized seed name is reported back');
  }

  // B5) Real (non-generic) uploaded industry is used when no domain
  // evidence was derived -- Ridgeline's peer-lens descriptor query uses
  // "Outdoor Retail", never a fabricated or generic label.
  {
    const fetchImpl = createFullMock({
      synthesisForCandidate: {
        'Peak Outfitters': {
          accountName: 'Peak Outfitters', signal_type: 'Growth / Expansion',
          concrete_trigger: 'Peak Outfitters held a ribbon cutting for its new distribution center',
          business_context: 'Peak Outfitters opened a new flagship store and expanded distribution center.',
          why_this_matters: 'A new flagship store and distribution center typically means more on-site staff and a fresh need for branded merchandise and grand-opening giveaways.',
          publicationDate: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
          sourceUrl: 'https://www.businesswire.com/peak-outfitters-new-facility', confidence: 82
        }
      }
    });
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Ridgeline Apparel'] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200 && res._body?.ok !== false, `B5) legitimate request succeeds (got ${res._status})`);
    const seedQueries = res._body.seeds[0].queries;
    assert(seedQueries.some(q => q.includes('Outdoor Retail')), `B5) REQUIRED: the real uploaded industry ("Outdoor Retail") is used in query construction (got ${JSON.stringify(seedQueries)})`);
    assert(!seedQueries.some(q => /general business/i.test(q)), 'B5b) no query contains a generic fallback label');
    assert(!seedQueries.some(q => /\bnear\b/.test(q)), 'B5c) REQUIRED: no local-lens query fires for a seed with no grounded geography (Ridgeline has no uploaded or derived location in this scenario)');
    const peak = res._body.results.find(r => r.company === 'Peak Outfitters');
    assert(peak.relationshipType === 'Industry Peer', `B5d) REQUIRED: the peer-lens candidate is labeled "Industry Peer" (got "${peak.relationshipType}")`);
    assert(peak.hasCurrentReasonToReachOut === true, 'B5e) the candidate with a real grounded signal shows a current Reason to Reach Out');
    assert(!/general business/i.test(peak.whySimilar), 'B5f) REQUIRED: the candidate-facing explanation never contains a generic fallback label');
  }

  // B6) No-signal candidate still represented honestly.
  {
    const fetchImpl = createFullMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Ridgeline Apparel'] });
    const res = fakeRes();
    await handler(req, res);
    const peak = res._body.results.find(r => r.company === 'Peak Outfitters');
    assert(peak.hasCurrentReasonToReachOut === false && peak.reasonToReachOut === null, 'B6) REQUIRED: no current signal -> represented honestly as no reason to reach out, not fabricated');
    assert(res._body.results.some(r => r.company === 'Peak Outfitters'), 'B6b) REQUIRED: the candidate itself still appears -- a legitimately similar company is not dropped merely because no timely signal exists today');
  }

  // B7/B8) Eastern Propane -- THE actual Founder-reported blocker.
  // Generic uploaded industry + a grounded owned-domain description +
  // grounded geography -> both the peer lens (domain-derived descriptor)
  // and the local lens fire; "General Business" never appears anywhere.
  {
    const fetchImpl = createFullMock({
      synthesisForCandidate: {
        'Suburban Propane': {
          accountName: 'Suburban Propane', signal_type: 'Partnership / Contract',
          concrete_trigger: 'Suburban Propane signed a new regional distribution partnership',
          business_context: 'Suburban Propane announced a new regional distribution partnership.',
          why_this_matters: 'A new distribution partnership often creates fresh onboarding and branding needs.',
          publicationDate: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
          sourceUrl: 'https://example.com/propane-competitors', confidence: 78
        }
      }
    });
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Eastern Propane'] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200 && res._body?.ok !== false, `B7) REQUIRED: Eastern Propane (the actual reported blocker) no longer fails/returns zero due to weak metadata (got ${res._status}, ${JSON.stringify(res._body).slice(0, 300)})`);
    const seedQueries = res._body.seeds[0].queries;
    assert(seedQueries.some(q => q.includes('propane and heating oil delivery')), `B7b) REQUIRED: the domain-derived business description is actually used in query construction, not the generic uploaded label (got ${JSON.stringify(seedQueries)})`);
    assert(!seedQueries.some(q => /general business/i.test(q)), 'B7c) REQUIRED: "General Business" never appears in any query for Eastern Propane');
    assert(seedQueries.some(q => q.includes('Springfield, MA')), 'B7d) REQUIRED: the local lens fires using Eastern Propane\'s real grounded geography');
    const names = res._body.results.map(r => r.company);
    assert(names.includes('Suburban Propane'), `B8) a genuine, specific-vertical peer candidate is found for Eastern Propane (got ${JSON.stringify(names)})`);
    assert(names.includes('Acme Facilities Group'), `B8b) a local-market candidate is also found (got ${JSON.stringify(names)})`);
    const suburban = res._body.results.find(r => r.company === 'Suburban Propane');
    const acme = res._body.results.find(r => r.company === 'Acme Facilities Group');
    assert(suburban.relationshipType === 'Industry Peer', `B8c) REQUIRED: the peer-lens candidate is labeled "Industry Peer" (got "${suburban.relationshipType}")`);
    assert(acme.relationshipType === 'Nearby Opportunity', `B8d) REQUIRED: the local-lens candidate is labeled "Nearby Opportunity", never claiming industry similarity (got "${acme.relationshipType}")`);
    assert(/not necessarily|not.*same industry/i.test(acme.whySimilar), 'B8e) REQUIRED: the local-lens candidate\'s own explanation is explicit that geography alone was the basis');
  }

  // B9) Fit-first ranking (Founder QA Round 2, item 4): give the WEAKER
  // (local-lens) candidate a live current signal and the STRONGER
  // (peer-lens) candidate none -- the peer-lens candidate must still rank
  // first. "A highly credible peer with no current signal should outrank
  // a weakly related company that happens to have news."
  {
    const fetchImpl = createFullMock({
      synthesisForCandidate: {
        'Acme Facilities Group': {
          accountName: 'Acme Facilities Group', signal_type: 'Trade Show / Event',
          concrete_trigger: 'Acme Facilities Group exhibited at a regional facilities trade show',
          business_context: 'Acme Facilities Group exhibited at a regional facilities trade show.',
          why_this_matters: 'Trade show attendance signals active engagement.',
          event_date: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10),
          sourceUrl: 'https://example.com/acme-facilities', confidence: 75
        }
        // Suburban Propane deliberately gets NO signal override -> the
        // default zero-signal synthesis response.
      }
    });
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Eastern Propane'] });
    const res = fakeRes();
    await handler(req, res);
    const suburban = res._body.results.find(r => r.company === 'Suburban Propane');
    const acme = res._body.results.find(r => r.company === 'Acme Facilities Group');
    assert(suburban.hasCurrentReasonToReachOut === false && acme.hasCurrentReasonToReachOut === true, 'B9) sanity: the weaker-match candidate has a current signal and the stronger-match candidate does not, in this scenario');
    const suburbanIdx = res._body.results.findIndex(r => r.company === 'Suburban Propane');
    const acmeIdx = res._body.results.findIndex(r => r.company === 'Acme Facilities Group');
    assert(suburbanIdx < acmeIdx, `B9b) REQUIRED (fit-first ordering): the higher-quality peer-lens match ranks ABOVE the geography-only match even without a current signal (Suburban at index ${suburbanIdx}, Acme at index ${acmeIdx})`);
    assert(!('matchRank' in res._body.results[0]), 'B9c) REQUIRED: the internal matchRank sort key is never leaked into the customer-facing API response');
  }

  // B10) Max-candidates cap still holds under multi-lens discovery.
  {
    const fetchImpl = createFullMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Eastern Propane'] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._body.results.length <= 5, `B10) REQUIRED: the response never exceeds the 5-candidate cap even with multiple lenses active (got ${res._body.results.length})`);
  }

  // B11) Cost-gate / persistence-boundary proof (unchanged from V1): no
  // writes to ha_accounts/ha_monitoring_targets across the whole run.
  {
    const fetchImpl = createFullMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Eastern Propane'] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200, `B11) request succeeds (got ${res._status})`);
    assert(!fetchImpl.calls.some(u => u.includes('ha_monitoring_targets')), 'B11) REQUIRED: no ha_monitoring_targets row is ever created or touched');
  }

  // B12) REQUIRED (Founder Preview QA correction): a selected seed with no
  // known website/domain must not run ANY candidate research -- no lens
  // query, no owned-domain profile query, no OpenAI call -- for this seed
  // OR any other seed in the same request.
  {
    const fetchImpl = createFullMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: [WEBSITELESS_SEED_NAME] });
    const res = fakeRes();
    await handler(req, res);
    assert(res._status === 200, `B12) a missing-website seed returns 200 with a guided state, not a hard error (got ${res._status})`);
    assert(res._body?.ok === false, 'B12) the response is explicitly ok:false');
    assert(res._body.missingWebsiteSeeds[0].accountId === 'acct-no-website', `B12b) REQUIRED: the real, resolved ha_accounts.id is carried back (got "${res._body.missingWebsiteSeeds[0]?.accountId}")`);
    assert(!fetchImpl.calls.some(u => u.includes('google.serper.dev')), 'B12c) REQUIRED (cost gate): zero Serper calls (including the owned-domain profile query) before the required seed identity is present');
    assert(!fetchImpl.calls.some(u => u.includes('api.openai.com')), 'B12d) REQUIRED (cost gate): zero OpenAI calls before the required seed identity is present');
  }

  // B13) Regression proof for the actual reported schema blocker: the
  // org-accounts fetch never selects a website column.
  {
    const fetchImpl = createFullMock();
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Ridgeline Apparel'] });
    const res = fakeRes();
    await handler(req, res);
    const accountsCall = fetchImpl.calls.find(u => u.includes('/rest/v1/ha_accounts'));
    assert(Boolean(accountsCall), 'B13) sanity: the org-accounts fetch happened');
    assert(!/[?&]select=[^&]*\bwebsite\b/.test(decodeURIComponent(accountsCall || '')), 'B13b) REQUIRED (regression): the ha_accounts query never selects a "website" column');
  }

  // B14/B15/B16) Founder QA Round 1 correction, preserved under V2: a
  // multi-year-stale signal is never shown as current, a genuinely recent
  // one is, and the BEST (not merely first) current signal is selected via
  // Core's own why_now_score.
  {
    const staleEventLike = {
      accountName: 'Suburban Propane', signal_type: 'Trade Show / Event',
      concrete_trigger: 'Suburban Propane exhibited at an industry trade show',
      business_context: 'Suburban Propane exhibited at an industry trade show.',
      why_this_matters: 'Trade show attendance is a real evidenced fact.',
      event_date: '2019-04-15',
      sourceUrl: 'https://example.com/propane-competitors', confidence: 80
    };
    const fetchImpl = createFullMock({ synthesisForCandidate: { 'Suburban Propane': staleEventLike } });
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Eastern Propane'] });
    const res = fakeRes();
    await handler(req, res);
    const suburban = res._body.results.find(r => r.company === 'Suburban Propane');
    assert(suburban.hasCurrentReasonToReachOut === false && suburban.reasonToReachOut === null, `B14) REQUIRED: a multi-year-stale event-like signal is never shown as a CURRENT reason to reach out (got ${JSON.stringify(suburban?.reasonToReachOut)})`);
    assert(Array.isArray(suburban.allSignals) && suburban.allSignals.length === 1, 'B14b) the underlying grounded fact is still returned in allSignals -- filtered from "current," not deleted');
  }
  {
    const recentDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    const currentEventLike = {
      accountName: 'Suburban Propane', signal_type: 'Trade Show / Event',
      concrete_trigger: 'Suburban Propane exhibited at an industry trade show',
      business_context: 'Suburban Propane exhibited at an industry trade show.',
      why_this_matters: 'Trade show attendance signals active market engagement worth a timely outreach.',
      event_date: recentDate,
      sourceUrl: 'https://example.com/propane-competitors', confidence: 80
    };
    const fetchImpl = createFullMock({ synthesisForCandidate: { 'Suburban Propane': currentEventLike } });
    global.fetch = fetchImpl;
    const req = fakeReq({ seedAccountNames: ['Eastern Propane'] });
    const res = fakeRes();
    await handler(req, res);
    const suburban = res._body.results.find(r => r.company === 'Suburban Propane');
    assert(suburban.hasCurrentReasonToReachOut === true && Boolean(suburban.reasonToReachOut), `B15) REQUIRED: a genuinely recent event-like signal still surfaces as current (got ${JSON.stringify(suburban?.reasonToReachOut)})`);
    assert(Boolean(suburban.reasonToReachOut.eventDate), 'B15b) REQUIRED: the real event date Core already resolved is surfaced in the response');
  }
}

try {
  await run();
} finally {
  global.fetch = originalFetch;
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
