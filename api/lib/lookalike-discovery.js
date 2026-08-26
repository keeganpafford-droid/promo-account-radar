// Find More Like Them V2 -- candidate-generation quality pass (2026-08-26,
// Founder QA Round 2). Everything downstream of "we have a real candidate
// company name" already exists and is reused unmodified (api/lib/
// research-pipeline.js's runResearchPipeline(), which itself composes
// discoverCandidatesForAccounts/buildSynthesisPrompt/callOpenAIJson/
// mapSignalsFromModelOutput -- verifyCandidateCompanyGrounding() included,
// with no prospect-specific weakening). This module is only responsible for
// the step before that: given one existing customer (the seed) HA already
// has real data on, find a small, bounded set of real, distinct candidate
// company names that genuinely resemble it.
//
// V2 CHANGE FROM V1 (Founder QA Round 1 finding): a single query built from
// the uploaded industry label (often a low-information fallback like
// "General Business") produced poor or zero candidates for ordinary
// regional businesses. V2 corrects this two ways:
//   1. Seed profiling: since a website is now a required identity anchor
//      for this feature (Round 1 correction), buildGroundedSeedProfile()
//      spends ONE Serper query on the seed's own domain to derive a real,
//      evidence-supported business description/location/footprint hint --
//      preferred over the uploaded industry label whenever that label is a
//      known-generic fallback (isGenericIndustry()). Honest degrade: no
//      website evidence found -> profile stays at whatever real (non-
//      generic) data was already known, never fabricated.
//   2. Multi-lens discovery: instead of one query set, buildLensQueries()
//      builds up to 4 queries across three DISTINCT, separately-labeled
//      relationship lenses (peer/local/footprint -- see RELATIONSHIP_TYPE_
//      BY_LENS), each gated on genuinely having the evidence that lens
//      requires. Every query is TAGGED with its lens and a deterministic
//      match-quality rank before search, so relationshipType/matchBasis is
//      derived structurally from which lens produced a candidate -- never
//      guessed by the model, never claiming a similarity dimension that
//      isn't actually established for that specific candidate.
//
// Two-stage design, deliberately not one LLM call that "just lists similar
// companies" from its own training data:
//   Stage A (this module): a bounded set of real Serper searches across
//     lenses -> ONE OpenAI call constrained to EXTRACT company names that
//     are literally present in that real search evidence, never to
//     recall/invent names on its own.
//   Stage B (the caller, api/find-similar-companies.js): each surviving
//     candidate name is run through the existing, unmodified prospect-
//     intelligence research pipeline exactly like any other target company.
//
// Pure/testable: every function here takes its inputs explicitly (no env
// reads, no Supabase, no fetch except where noted) so the founder-QA-facing
// logic (which lens/dimension was used, what got excluded and why) is
// directly unit-testable without mocking providers.

function clean(v = '') { return String(v || '').trim(); }
function hostnameOf(url = '') {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Known-generic industry fallback values ALREADY established elsewhere in
// this codebase -- not invented for this feature. "General Business" is
// dashboard/index.html's inferIndustry() catch-all for any account that
// doesn't match its five hardcoded keyword buckets; "Saved Account" is
// api/get-dashboard.js's own placeholder when raw_data.industry is entirely
// blank. Both mean "no real industry is known," never "this company
// operates in a general-business vertical."
// ---------------------------------------------------------------------------
const GENERIC_INDUSTRY_VALUES = new Set(['general business', 'saved account']);
export function isGenericIndustry(industry = '') {
  const v = clean(industry).toLowerCase();
  return !v || GENERIC_INDUSTRY_VALUES.has(v);
}

// ---------------------------------------------------------------------------
// Seed profile -- only real, already-known (or explicitly supplied) fields.
// Deliberately does NOT include revenue/orderCount/relationshipStrength --
// those measure the relationship with the distributor, not the seed
// company's own market position, and are not evidence of what a lookalike
// company would look like. Per founder direction: relationshipStrength may
// inform which accounts get SUGGESTED as seeds, never what "similar" means
// once a seed is chosen.
// ---------------------------------------------------------------------------
export function buildSeedProfile(seedAccount = {}) {
  return {
    name: clean(seedAccount.name || seedAccount.account_name || ''),
    industry: clean(seedAccount.industry || ''),
    location: clean(seedAccount.cityState || seedAccount.location || ''),
    website: clean(seedAccount.website || '')
  };
}

// ---------------------------------------------------------------------------
// Owned-domain evidence query -- a single, bounded, cheap Serper search
// (never a separate Firecrawl scrape; Serper is both cheaper per the
// existing cost model in api/lib/research-pipeline.js and requires no extra
// provider configuration) anchored on the seed's own domain. A bare-domain
// query reliably resolves to the site's own homepage listing in a normal
// search index -- the same real evidence a human would see searching it.
// ---------------------------------------------------------------------------
export function buildOwnedDomainProfileQuery(seedProfile = {}) {
  return clean(seedProfile.website || '');
}

// ---------------------------------------------------------------------------
// Seed self-profile extraction prompt -- an EXTRACTION task over the seed's
// OWN real search evidence, never a generation task. Every field is
// optional and left blank when the evidence doesn't support it -- no
// fabricated employee counts, revenue bands, or classifications.
// ---------------------------------------------------------------------------
export function buildSeedProfileExtractionPrompt(seedProfile = {}, searchResults = []) {
  const { name, website } = seedProfile;
  const evidenceBlock = searchResults.map((r, i) => `[${i}] ${clean(r.title)}\n${clean(r.snippet)}\nSource: ${clean(r.url)}`).join('\n\n');
  return `You are extracting REAL facts about "${name}" from its own website's real search-engine listing below (domain: ${website}). Do not invent, guess, or infer any fact the evidence does not literally support.

Evidence:
${evidenceBlock || '(no evidence available)'}

Task: extract only what the evidence above directly supports.
- businessDescription: a short, SPECIFIC description of what "${name}" actually does or sells -- ONLY if stated. Leave "" if not supported. Never return a generic category like "general business" or "services."
- location: "${name}"'s HQ or primary service area -- ONLY if explicitly stated. Leave "" if not supported.
- footprintHint: a short phrase describing scale/footprint (e.g. "multiple locations", "regional distributor", "single location") -- ONLY if explicitly stated. Leave "" if not supported.
- evidenceSnippet: the exact quote or close paraphrase from the evidence that supports whichever field(s) you filled in. Leave "" if nothing was supported.

Never invent a specific employee count, revenue figure, or classification the evidence does not state.

Respond as JSON only: {"businessDescription":"","location":"","footprintHint":"","evidenceSnippet":""}`;
}

// ---------------------------------------------------------------------------
// Stage 0: spend at most ONE owned-domain Serper query (+ one OpenAI
// extraction call, skipped entirely if that query finds nothing usable --
// same cost-avoidance doctrine as Stage A below) establishing a grounded,
// evidence-backed profile of the seed BEFORE any candidate query is built.
// Honest degrade at every step: no website -> profile unchanged; no
// same-domain evidence found -> profile unchanged; evidence found but a
// field isn't supported -> that field stays blank, never guessed.
// ---------------------------------------------------------------------------
export async function buildGroundedSeedProfile(seedAccount = {}, {
  serperSearchImpl, callOpenAIJsonImpl, parseJsonLooseImpl, apiKey, model
} = {}) {
  const base = buildSeedProfile(seedAccount);
  const profile = {
    ...base,
    derivedBusinessDescription: '', derivedLocation: '', derivedFootprintHint: '',
    profileEvidenceSnippet: '', profileSourceUrl: ''
  };
  const query = buildOwnedDomainProfileQuery(base);
  if (!query) return profile;

  const rawResults = await serperSearchImpl(query);
  const domain = clean(base.website).toLowerCase();
  const sameSiteResults = (rawResults || []).filter(r => {
    if (!r || !(r.title || r.snippet)) return false;
    const host = hostnameOf(r.url);
    return Boolean(host) && (host === domain || host.endsWith(`.${domain}`));
  });
  if (!sameSiteResults.length) return profile;

  const prompt = buildSeedProfileExtractionPrompt(base, sameSiteResults);
  const result = await callOpenAIJsonImpl({ apiKey, model, prompt, timeoutMs: 20000 });
  const parsed = parseJsonLooseImpl(result?.text) || {};
  return {
    ...profile,
    derivedBusinessDescription: clean(parsed.businessDescription),
    derivedLocation: clean(parsed.location),
    derivedFootprintHint: clean(parsed.footprintHint),
    profileEvidenceSnippet: clean(parsed.evidenceSnippet),
    profileSourceUrl: sameSiteResults[0]?.url || ''
  };
}

// ---------------------------------------------------------------------------
// The real, grounded business descriptor to use for query-building and
// explanations -- domain-derived evidence first (more specific, more
// trustworthy than a keyword-heuristic upload fallback), then the uploaded
// industry ONLY if it is not one of the known-generic fallback values.
// Never "General Business" -- isGenericIndustry() filters that out.
// ---------------------------------------------------------------------------
export function resolveBusinessDescriptor(groundedProfile = {}) {
  return clean(groundedProfile.derivedBusinessDescription) ||
    (!isGenericIndustry(groundedProfile.industry) ? clean(groundedProfile.industry) : '');
}
export function resolveGroundedLocation(groundedProfile = {}) {
  return clean(groundedProfile.derivedLocation) || clean(groundedProfile.location);
}

// ---------------------------------------------------------------------------
// Multi-lens query set. Every query is tagged with:
//   - lens: which relationship lens it belongs to (drives the candidate's
//     eventual relationshipType -- see RELATIONSHIP_TYPE_BY_LENS)
//   - rank: a deterministic match-QUALITY rank (0 = strongest), used later
//     for internal sort ordering ONLY -- never surfaced to the customer as
//     a number (per founder direction: no fake numerical precision in the
//     UI). Lower rank = stronger evidence: explicit direct-peer evidence
//     (0) > specific business-type match (1) > similar footprint (2) >
//     geography-only (3).
// Lens B (local) and Lens C (footprint) are gated entirely on actually
// having the evidence they require -- skipped, not fabricated, otherwise.
// ---------------------------------------------------------------------------
export function buildLensQueries(seedProfile = {}, groundedProfile = {}) {
  const { name } = seedProfile;
  if (!name) return [];
  const descriptor = resolveBusinessDescriptor(groundedProfile);
  const location = resolveGroundedLocation(groundedProfile);
  const footprintHint = clean(groundedProfile.derivedFootprintHint);

  const queries = [];
  // Lens A -- business/peer. Always attempted. An explicit "competitors"
  // search is the strongest, most direct peer evidence (rank 0); a
  // descriptor-anchored search is a real but slightly less direct
  // business-type match (rank 1). With no descriptor at all, the second
  // query degrades to a plain "alternatives" search -- still explicit
  // peer-framing, so it stays rank 0 -- never a fabricated industry claim.
  queries.push({ query: `"${name}" competitors`, lens: 'peer', rank: 0 });
  queries.push(descriptor
    ? { query: `${descriptor} companies similar to "${name}"`, lens: 'peer', rank: 1 }
    : { query: `"${name}" alternatives`, lens: 'peer', rank: 0 });
  // Lens B -- local market. Only when the seed's own geography is grounded
  // (uploaded OR domain-derived) -- "near/in the seed customer's evidenced
  // market," never the rep's location. Weakest tier: geography alone is
  // explicitly NOT a similarity claim (founder direction).
  if (location) {
    queries.push({
      query: descriptor ? `${descriptor} companies near ${location}` : `companies near ${location}`,
      lens: 'local', rank: 3
    });
  }
  // Lens C -- similar footprint. Only when real, evidence-supported
  // footprint characteristics exist; skipped entirely otherwise (per
  // founder: defer rather than fabricate scale).
  if (footprintHint) {
    queries.push({
      query: descriptor ? `${footprintHint} ${descriptor} companies similar to "${name}"` : `${footprintHint} companies similar to "${name}"`,
      lens: 'footprint', rank: 2
    });
  }
  return queries;
}

// ---------------------------------------------------------------------------
// Deterministic, non-fabricated explanation of WHY a candidate was surfaced
// -- built from which lens actually produced it and which real dimensions
// were actually established, never generated freely by the model. The
// candidate's own extracted evidence snippet (grounded in real search text)
// is shown separately by the caller as candidate-specific supporting
// detail -- this text states the STRUCTURAL relationship, never claims a
// dimension (industry/geography/scale) that wasn't actually the basis.
// ---------------------------------------------------------------------------
export const RELATIONSHIP_TYPE_BY_LENS = { peer: 'Industry Peer', local: 'Nearby Opportunity', footprint: 'Similar Footprint' };

export function buildMatchBasis(lens, seedName, groundedProfile = {}) {
  const descriptor = resolveBusinessDescriptor(groundedProfile);
  const location = resolveGroundedLocation(groundedProfile);
  const footprintHint = clean(groundedProfile.derivedFootprintHint);
  if (lens === 'local') {
    return `Nearby Opportunity: found in ${seedName}'s own market${location ? ` (${location})` : ''} -- geography alone, not a claim of same industry or business type.`;
  }
  if (lens === 'footprint') {
    return `Surfaced via a similar operating footprint${footprintHint ? ` (${footprintHint})` : ''} to ${seedName}${descriptor ? `, also in ${descriptor}` : ''}.`;
  }
  // lens === 'peer' (or unrecognized -- fail toward the least specific,
  // still-honest claim)
  return descriptor
    ? `Surfaced as a peer in the same specific business (${descriptor}) as ${seedName}.`
    : `Surfaced from a direct competitors/alternatives search for ${seedName} -- no specific business type is known for ${seedName} beyond that.`;
}

export function normalizeCompanyName(name = '') {
  return clean(name).toLowerCase()
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Stage A extraction prompt -- an EXTRACTION task, not a generation task.
// Explicitly forbids recalling companies from the model's own training
// data; a candidate is only valid if it is literally present in the
// supplied evidence. Unchanged from V1 -- the evidence block is simply
// larger now (multiple lenses' worth of real search results), and each
// result's originating lens/rank is resolved deterministically by the
// caller from sourceIndex, never asked of the model.
// ---------------------------------------------------------------------------
export function buildExtractionPrompt(seedProfile = {}, searchResults = []) {
  const { name, industry, location } = seedProfile;
  const evidenceBlock = searchResults.map((r, i) => `[${i}] ${clean(r.title)}\n${clean(r.snippet)}\nSource: ${clean(r.url)}`).join('\n\n');
  return `You are extracting REAL company names from search-engine results. Do not invent, guess, or recall a company from your own training data -- a candidate is valid ONLY if its name is explicitly, literally present in the evidence text below.

Seed company: "${name}"
Known seed characteristics (do not assume any characteristic beyond these): industry=${industry || 'unknown'}, location=${location || 'unknown'}

Search evidence:
${evidenceBlock || '(no search results returned)'}

Task: list real, distinct companies mentioned in the evidence above that appear to be OTHER companies operating in a similar space to "${name}" (competitors, alternatives, or peer companies) -- never "${name}" itself, never a person, never a generic term.
- Only include a company whose name is literally present in the evidence text.
- "evidenceSnippet" must be a direct quote or close paraphrase of the actual text that mentions this company -- never a fabricated reason.
- "sourceIndex" is the [N] index of the evidence item the mention came from.
- Return at most 10 candidates. If none qualify, return an empty array.

Respond as JSON only: {"candidates": [{"name": "...", "evidenceSnippet": "...", "sourceIndex": 0}]}`;
}

// ---------------------------------------------------------------------------
// Exclusion + dedup + cap, per founder direction: exclude the seed itself,
// any existing monitored customer of the org, duplicate entities among the
// candidates themselves, and cap the final list. Pure function -- the
// caller resolves existingCustomerNames (the org's real ha_accounts names)
// and passes them in; this function never touches Supabase itself.
//
// Dedup order matters for lens/rank fidelity: the CALLER is responsible for
// ordering rawCandidates strongest-lens-first (see discoverLookalikeCandidates
// below) so that when the same company is independently surfaced by two
// lenses, the stronger lens's relationshipType/rank is the one that
// survives ("first occurrence wins" -- unchanged dedup semantics from V1).
// ---------------------------------------------------------------------------
export function filterAndCapCandidates(rawCandidates = [], { seedName = '', existingCustomerNames = [], maxCandidates = 5 } = {}) {
  const seedKey = normalizeCompanyName(seedName);
  const existingKeys = new Set(existingCustomerNames.map(normalizeCompanyName).filter(Boolean));
  const seen = new Set();
  const kept = [];
  const excluded = [];
  for (const candidate of rawCandidates) {
    const rawName = clean(candidate?.name);
    if (!rawName) continue;
    const key = normalizeCompanyName(rawName);
    if (!key) continue;
    if (key === seedKey) { excluded.push({ name: rawName, reason: 'is-the-seed-company' }); continue; }
    if (existingKeys.has(key)) { excluded.push({ name: rawName, reason: 'already-an-existing-customer' }); continue; }
    if (seen.has(key)) { excluded.push({ name: rawName, reason: 'duplicate-of-another-candidate' }); continue; }
    seen.add(key);
    kept.push({ ...candidate, name: rawName });
  }
  return { candidates: kept.slice(0, maxCandidates), excluded, cappedCount: Math.max(0, kept.length - maxCandidates) };
}

// ---------------------------------------------------------------------------
// Stage A end to end: grounded seed profile -> multi-lens real Serper
// searches -> ONE grounded extraction call -> deterministic lens/rank
// resolution -> exclude/dedup/cap. Provider calls are injected
// (serperSearchImpl, callOpenAIJsonImpl, parseJsonLooseImpl) so this stays
// testable without a real network call -- the real caller (api/
// find-similar-companies.js) passes the actual serperSearch/callOpenAIJson/
// parseJsonLoose already exported from api/research-batch.js, never a
// second implementation.
// ---------------------------------------------------------------------------
export async function discoverLookalikeCandidates(seedAccount, {
  existingCustomerNames = [],
  maxCandidates = 5,
  serperSearchImpl,
  callOpenAIJsonImpl,
  parseJsonLooseImpl,
  apiKey,
  model
} = {}) {
  const groundedProfile = await buildGroundedSeedProfile(seedAccount, { serperSearchImpl, callOpenAIJsonImpl, parseJsonLooseImpl, apiKey, model });
  if (!groundedProfile.name) return { seedProfile: groundedProfile, groundedProfile, candidates: [], excluded: [], queries: [], searchResultCount: 0 };

  const lensQueries = buildLensQueries(groundedProfile, groundedProfile);
  const searchResultBatches = await Promise.all(lensQueries.map(q => serperSearchImpl(q.query)));
  // Every result inherits its ORIGINATING query's lens/rank -- attached
  // here, before the extraction call, so lens assignment is 100%
  // deterministic (never asked of or trusted from the model).
  const searchResults = searchResultBatches.flatMap((batch, i) =>
    (batch || [])
      .filter(r => r && (r.title || r.snippet))
      .map(r => ({ ...r, lens: lensQueries[i].lens, rank: lensQueries[i].rank }))
  );

  if (!searchResults.length) {
    return { seedProfile: groundedProfile, groundedProfile, candidates: [], excluded: [], queries: lensQueries.map(q => q.query), searchResultCount: 0 };
  }

  const prompt = buildExtractionPrompt(groundedProfile, searchResults);
  const result = await callOpenAIJsonImpl({ apiKey, model, prompt, timeoutMs: 20000 });
  const parsed = parseJsonLooseImpl(result?.text) || { candidates: [] };
  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];

  const enriched = rawCandidates.map(c => {
    const sourceIndex = Number.isInteger(c?.sourceIndex) ? c.sourceIndex : -1;
    const source = searchResults[sourceIndex] || null;
    const lens = source?.lens || 'peer';
    const rank = Number.isInteger(source?.rank) ? source.rank : 3;
    return {
      name: clean(c?.name),
      evidenceSnippet: clean(c?.evidenceSnippet),
      sourceUrl: source?.url || '',
      sourceTitle: source?.title || '',
      lens,
      matchRank: rank,
      relationshipType: RELATIONSHIP_TYPE_BY_LENS[lens] || 'Industry Peer',
      similarityExplanation: buildMatchBasis(lens, groundedProfile.name, groundedProfile)
    };
  })
    // Strongest-lens-first ordering before dedup, so a company independently
    // surfaced by two lenses keeps the stronger lens's relationshipType/rank
    // (filterAndCapCandidates() keeps the FIRST occurrence of a duplicate).
    .sort((a, b) => a.matchRank - b.matchRank);

  const { candidates, excluded, cappedCount } = filterAndCapCandidates(enriched, {
    seedName: groundedProfile.name, existingCustomerNames, maxCandidates
  });

  return { seedProfile: groundedProfile, groundedProfile, candidates, excluded, cappedCount, queries: lensQueries.map(q => q.query), searchResultCount: searchResults.length };
}
