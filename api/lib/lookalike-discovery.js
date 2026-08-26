// Find More Like Them V1 -- the one genuinely new piece of this slice.
// Everything downstream of "we have a real candidate company name" already
// exists and is reused unmodified (api/lib/research-pipeline.js's
// runResearchPipeline(), which itself composes discoverCandidatesForAccounts/
// buildSynthesisPrompt/callOpenAIJson/mapSignalsFromModelOutput --
// verifyCandidateCompanyGrounding() included, with no prospect-specific
// weakening). This module is only responsible for the step before that:
// given one existing customer (the seed) HA already has real data on, find a
// small, bounded set of real, distinct candidate company names that
// genuinely resemble it -- using only evidence HA already has or can cheaply
// establish via a real web search, never inventing unsupported specifics
// (no fabricated employee counts, revenue bands, or classifications).
//
// Two-stage design, deliberately not one LLM call that "just lists similar
// companies" from its own training data:
//   Stage A (this module): a few real Serper searches -> an OpenAI call
//     constrained to EXTRACT company names that are literally present in
//     that real search evidence, never to recall/invent names on its own.
//   Stage B (the caller, api/find-similar-companies.js): each surviving
//     candidate name is run through the existing, unmodified prospect-
//     intelligence research pipeline exactly like any other target company.
//
// Pure/testable: every function here takes its inputs explicitly (no env
// reads, no Supabase, no fetch except where noted) so the founder-QA-facing
// logic (which dimensions were used, what got excluded and why) is directly
// unit-testable without mocking providers.

function clean(v = '') { return String(v || '').trim(); }

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
// A small, bounded query set. Every query is built ONLY from real, known
// dimensions -- never a fabricated industry/location/scale. Degrades
// gracefully (a generic competitors/alternatives search) when nothing else
// is known, rather than inventing a dimension to search on.
// ---------------------------------------------------------------------------
export function buildLookalikeQueries(seedProfile = {}) {
  const { name, industry, location } = seedProfile;
  if (!name) return [];
  const queries = [`"${name}" competitors`, `"${name}" alternatives`];
  if (industry && location) queries.push(`${industry} companies ${location}`);
  else if (industry) queries.push(`${industry} companies similar to "${name}"`);
  else if (location) queries.push(`companies similar to "${name}" ${location}`);
  return queries.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Deterministic, non-fabricated explanation of WHY a candidate was surfaced
// -- built from which real dimensions were actually used to find it, never
// generated freely by the model. The model's own extracted evidence snippet
// (grounded in real search text, see extractCandidatesFromSearchResults
// below) is appended separately as supporting detail.
// ---------------------------------------------------------------------------
export function explainSimilarity(seedProfile = {}) {
  const { name, industry, location } = seedProfile;
  if (industry && location) return `Surfaced from a search for ${industry} companies in ${location}, the same industry and general market as ${name}.`;
  if (industry) return `Surfaced from a search for ${industry} companies similar to ${name} (industry match; no location on file for ${name} to narrow further).`;
  if (location) return `Surfaced from a search for companies similar to ${name} near ${location} (location match; no industry on file for ${name} to narrow further).`;
  return `Surfaced from a general competitors/alternatives search for ${name} -- limited profile data (no industry or location on file) was available for the seed company, so this comparison is broader than a category or location match.`;
}

// ---------------------------------------------------------------------------
// Stage A extraction prompt -- an EXTRACTION task, not a generation task.
// Explicitly forbids recalling companies from the model's own training
// data; a candidate is only valid if it is literally present in the
// supplied evidence.
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

export function normalizeCompanyName(name = '') {
  return clean(name).toLowerCase()
    .replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Exclusion + dedup + cap, per founder direction: exclude the seed itself,
// any existing monitored customer of the org, duplicate entities among the
// candidates themselves, and cap the final list. Pure function -- the
// caller resolves existingCustomerNames (the org's real ha_accounts names)
// and passes them in; this function never touches Supabase itself.
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
// Stage A end to end: real Serper searches -> grounded extraction -> exclude/
// dedup/cap. Provider calls are injected (serperSearchImpl, callOpenAIJsonImpl,
// parseJsonLooseImpl) so this stays testable without a real network call --
// the real caller (api/find-similar-companies.js) passes the actual
// serperSearch/callOpenAIJson/parseJsonLoose already exported from
// api/research-batch.js, never a second implementation.
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
  const seedProfile = buildSeedProfile(seedAccount);
  if (!seedProfile.name) return { seedProfile, candidates: [], excluded: [], queries: [], searchResultCount: 0 };

  const queries = buildLookalikeQueries(seedProfile);
  const searchResultBatches = await Promise.all(queries.map(q => serperSearchImpl(q)));
  const searchResults = searchResultBatches.flat().filter(r => r && (r.title || r.snippet));

  if (!searchResults.length) {
    return { seedProfile, candidates: [], excluded: [], queries, searchResultCount: 0 };
  }

  const prompt = buildExtractionPrompt(seedProfile, searchResults);
  const result = await callOpenAIJsonImpl({ apiKey, model, prompt, timeoutMs: 20000 });
  const parsed = parseJsonLooseImpl(result?.text) || { candidates: [] };
  const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];

  const enriched = rawCandidates.map(c => {
    const sourceIndex = Number.isInteger(c?.sourceIndex) ? c.sourceIndex : -1;
    const source = searchResults[sourceIndex] || null;
    return {
      name: clean(c?.name),
      evidenceSnippet: clean(c?.evidenceSnippet),
      sourceUrl: source?.url || '',
      sourceTitle: source?.title || '',
      similarityExplanation: explainSimilarity(seedProfile)
    };
  });

  const { candidates, excluded, cappedCount } = filterAndCapCandidates(enriched, {
    seedName: seedProfile.name, existingCustomerNames, maxCandidates
  });

  return { seedProfile, candidates, excluded, cappedCount, queries, searchResultCount: searchResults.length };
}
