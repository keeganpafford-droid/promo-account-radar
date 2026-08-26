// Find More Like Them V1 -- founder-directed bounded Preview slice
// (2026-08-26). "Existing Customer -> Find Companies Like This -> candidate
// discovery -> Prospect Intelligence."
//
// This endpoint is the orchestration layer only. The two pieces of actual
// logic it composes both already exist and are reused unmodified:
//   - Stage A (candidate discovery): api/lib/lookalike-discovery.js -- the
//     one genuinely new piece of this slice.
//   - Stage B (per-candidate research): api/lib/research-pipeline.js's
//     runResearchPipeline(), the SAME function the monitoring Queue worker
//     already reuses in-process -- discovery, grounding
//     (verifyCandidateCompanyGrounding(), unmodified, no prospect-specific
//     weakening), and synthesis all run exactly as they do for any other
//     prospect-intelligence-mode target.
//
// SAFETY / COST BOUNDARY (founder-directed, verified before writing this
// file): api/research-batch.js's prospect-intelligence/warm-account mode
// (no uploadId) is gated ONLY by resolveAuthenticatedCaller() -- any
// authenticated House Accounts user, any plan, no capacity/plan check at
// all. That pre-existing gap is real and is NOT fixed by this file (out of
// scope for this slice, reported separately to the founder) -- but THIS
// endpoint, the new capability this slice actually ships, has its own hard,
// non-billing caps: at most MAX_SEEDS explicit seed customers, at most
// MAX_CANDIDATES researched candidates total per call, user-initiated only
// (no background/scheduled invocation exists for this route), no bulk
// input. This is a per-request safety guard, not a usage/credits system.
//
// PERSISTENCE DOCTRINE: this endpoint never writes to ha_accounts and never
// creates an ha_monitoring_targets row -- a candidate here is a one-off
// research result, not a monitored customer. Saving a candidate for later
// reference is a SEPARATE, existing action (api/prospect-one-off.js,
// unmodified, called directly by the UI per-candidate) into the ha_prospect_*
// tables, which are already excluded from monitored-account capacity (see
// api/lib/entitlement.js). Monitored-customer capacity and prospect/
// lookalike research usage remain two separate economic dimensions, exactly
// as they were before this slice.
import { discoverLookalikeCandidates, filterAndCapCandidates, normalizeCompanyName } from './lib/lookalike-discovery.js';
import { serperSearch, callOpenAIJson, parseJsonLoose, mapLimit } from './research-batch.js';
import { runResearchPipeline } from './lib/research-pipeline.js';
import { normalizeDomain } from './lib/monitoring-identity.js';

const MAX_SEEDS = 3;
const MAX_CANDIDATES = 5;

function json(res, status, body) { res.setHeader('Cache-Control', 'no-store, max-age=0'); return res.status(status).json(body); }
function clean(v = '') { return String(v || '').trim(); }
function lower(v = '') { return clean(v).toLowerCase(); }
function env() {
  const raw = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!raw || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  return { url: String(raw).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, ''), key };
}
async function sb(path, opt = {}) {
  const { url, key } = env();
  const r = await fetch(`${url}/rest/v1/${path}`, { ...opt, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: opt.prefer || 'return=representation', ...(opt.headers || {}) } });
  const t = await r.text();
  let d = null;
  if (t) { try { d = JSON.parse(t); } catch { d = t; } }
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${typeof d === 'string' ? d : (d?.message || d?.hint || JSON.stringify(d))}`);
  return d;
}
async function authUser(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { url, key } = env();
  const r = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  return r.json();
}
// Same shape as api/prospect-one-off.js's own context() -- resolves the
// caller to a real ha_users row and their organization's user id set, so
// seed validation and the existing-customer exclusion set are scoped to
// the caller's real organization, never another org's data.
async function context(req) {
  const au = await authUser(req);
  if (!au?.id) return null;
  let rows = await sb(`ha_users?auth_user_id=eq.${encodeURIComponent(au.id)}&select=*&limit=1`);
  let user = Array.isArray(rows) ? rows[0] : null;
  if (!user && au.email) {
    rows = await sb(`ha_users?email=eq.${encodeURIComponent(lower(au.email))}&select=*&limit=1`);
    user = Array.isArray(rows) ? rows[0] : null;
  }
  if (!user) return null;
  const users = user.organization_id
    ? await sb(`ha_users?organization_id=eq.${encodeURIComponent(user.organization_id)}&select=id,status`)
    : [user];
  const active = (Array.isArray(users) ? users : []).filter(x => lower(x.status || 'active') !== 'inactive');
  return { user, userIds: active.map(x => x.id).filter(Boolean) };
}
function inFilter(vals) { return `in.(${vals.map(v => `"${String(v).replace(/"/g, '')}"`).join(',')})`; }

// account.metrics/raw_data are JSONB blobs whose exact shape depends on
// what the original CSV upload contained -- read defensively, never assume
// a field is present. Deliberately mirrors accountPromptContext()'s own
// field precedence (api/research-batch.js) so a seed built here matches
// what the normal research pipeline already considers "known" about an
// account.
//
// Founder-confirmed schema correction (2026-08-26, found in Preview QA): a
// previous version of this function read row.website and metrics.website --
// ha_accounts HAS NO website COLUMN AT ALL and never has (see
// supabase-schema.sql's own table definition), so selecting it 400'd every
// request. website is CANONICALLY only ever raw_data.website -- confirmed
// by api/company-identity.js's own header comment and read the exact same
// way everywhere else in the codebase (api/get-dashboard.js,
// api/monitoring-lists.js, api/lib/monitoring-targets.js). Do not
// reintroduce a row.website or metrics.website read here.
function toSeedAccount(row = {}) {
  const metrics = row.metrics && typeof row.metrics === 'object' ? row.metrics : {};
  const raw = row.raw_data && typeof row.raw_data === 'object' ? row.raw_data : {};
  return {
    name: clean(row.account_name),
    industry: clean(row.industry || metrics.industry || raw.industry || ''),
    location: clean(metrics.cityState || metrics.location || raw.location || ''),
    website: clean(raw.website || '')
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    const ctx = await context(req);
    if (!ctx) return json(res, 401, { error: 'Authentication required' });

    const body = req.body || {};
    const requestedNames = (Array.isArray(body.seedAccountNames) ? body.seedAccountNames : [body.seedAccountName])
      .map(clean).filter(Boolean);
    if (!requestedNames.length) return json(res, 400, { error: 'At least one seed company (an existing customer) is required.' });
    if (requestedNames.length > MAX_SEEDS) return json(res, 400, { error: `At most ${MAX_SEEDS} seed companies are supported per run.` });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || !process.env.SERPER_API_KEY) return json(res, 503, { error: 'Research is not configured for this environment.' });
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    // The org's real accounts -- used to (a) validate every requested seed
    // is a genuine existing customer, never an arbitrary caller-supplied
    // company, and (b) build the existing-customer exclusion set so a
    // candidate that is already one of this org's own customers is never
    // suggested as "net-new."
    const orgAccounts = ctx.userIds.length
      ? await sb(`ha_accounts?user_id=${inFilter(ctx.userIds)}&select=account_name,industry,metrics,raw_data&limit=5000`)
      : [];
    const accountsByNormalizedName = new Map((orgAccounts || []).map(a => [normalizeCompanyName(a.account_name), a]));
    const existingCustomerNames = (orgAccounts || []).map(a => a.account_name).filter(Boolean);

    const seeds = [];
    const missingSeeds = [];
    for (const name of requestedNames) {
      const match = accountsByNormalizedName.get(normalizeCompanyName(name));
      if (!match) { missingSeeds.push(name); continue; }
      seeds.push(toSeedAccount(match));
    }
    if (!seeds.length) return json(res, 400, { error: 'None of the requested seed companies match an existing customer account in your organization.', missingSeeds });

    // Founder product decision (2026-08-26): website/domain is a required
    // identity anchor for THIS feature specifically -- a strong anchor
    // materially improves lookalike discovery -- but is NOT globally
    // required for every monitored account. If HA doesn't already know a
    // selected seed's canonical website, this run must not proceed: no
    // Serper query, no OpenAI call, for ANY seed in this request, until
    // every seed carries a known website. normalizeDomain() (the same
    // existing normalizer Monitoring Identity V1 already uses to decide
    // whether an uploaded website is usable) is the single source of truth
    // for "known" here -- an empty/unparseable value is treated as missing.
    const missingWebsiteSeeds = seeds.filter(seed => !normalizeDomain(seed.website));
    if (missingWebsiteSeeds.length) {
      return json(res, 200, {
        ok: false,
        missingWebsiteSeeds: missingWebsiteSeeds.map(seed => ({ name: seed.name })),
        error: "A website helps House Accounts identify the right company and find more accurate matches."
      });
    }

    // Stage A: candidate discovery, per seed.
    const seedResults = [];
    let mergedCandidates = [];
    for (const seed of seeds) {
      const discovery = await discoverLookalikeCandidates(seed, {
        existingCustomerNames,
        maxCandidates: MAX_CANDIDATES,
        serperSearchImpl: serperSearch,
        callOpenAIJsonImpl: callOpenAIJson,
        parseJsonLooseImpl: parseJsonLoose,
        apiKey,
        model
      });
      seedResults.push({ seedName: seed.name, seedProfile: discovery.seedProfile, queries: discovery.queries, excluded: discovery.excluded });
      mergedCandidates.push(...discovery.candidates.map(c => ({ ...c, seedName: seed.name })));
    }

    // Re-apply dedup/cap across the MERGED set from all seeds combined --
    // per founder direction, the 5-candidate ceiling is per RUN, not per
    // seed. seedName is left blank here so a candidate is never excluded
    // for merely sharing a normalized name with itself across this pass.
    const { candidates: finalCandidates, excluded: mergeExcluded } = filterAndCapCandidates(mergedCandidates, {
      seedName: '', existingCustomerNames, maxCandidates: MAX_CANDIDATES
    });

    // Stage B: reuse the existing, unmodified prospect-intelligence research
    // pipeline for each surviving candidate -- the same function the
    // monitoring Queue worker already reuses in-process. Never persists
    // anything; never creates a monitoring target.
    const researched = await mapLimit(finalCandidates, 3, async candidate => {
      const pipelineResult = await runResearchPipeline(
        { name: candidate.name, industry: '', cityState: '', website: '' },
        { mode: 'prospect-intelligence', apiKey, model, runId: `lookalike-${Date.now()}-${normalizeCompanyName(candidate.name)}` }
      );
      return { candidate, pipelineResult };
    });

    const results = researched.map(({ candidate, pipelineResult }) => {
      const signals = Array.isArray(pipelineResult.signals) ? pipelineResult.signals : [];
      // Similarity and timing are different (founder direction): a
      // genuinely similar company is never dropped merely because no
      // timely signal exists today -- it is represented honestly instead.
      const topSignal = signals[0] || null;
      return {
        company: candidate.name,
        seedCompany: candidate.seedName,
        whySimilar: candidate.similarityExplanation,
        similarityEvidence: candidate.evidenceSnippet || null,
        similaritySourceUrl: candidate.sourceUrl || null,
        reasonToReachOut: topSignal ? {
          title: topSignal.signalTitle || topSignal.title || '',
          whyItMatters: topSignal.reasonToReachOut || topSignal.whyItMattersForPromo || '',
          identityConfidence: topSignal.identityConfidence || null,
          sourceUrl: topSignal.sourceUrl || null,
          sourceName: topSignal.sourceName || topSignal.cleanSourceName || null
        } : null,
        hasCurrentReasonToReachOut: Boolean(topSignal),
        allSignals: signals,
        researchCoverage: pipelineResult.coverage,
        researchError: pipelineResult.error || null
      };
    });

    // Rank: candidates with a grounded current Reason to Reach Out first
    // (founder direction: "Candidates with grounded current commercial
    // reasons can rank above equally similar candidates without them"),
    // stable otherwise (Stage A discovery order preserved within each
    // group).
    results.sort((a, b) => Number(b.hasCurrentReasonToReachOut) - Number(a.hasCurrentReasonToReachOut));

    return json(res, 200, {
      ok: true,
      seeds: seedResults,
      results,
      excluded: [...seedResults.flatMap(s => s.excluded), ...mergeExcluded],
      missingSeeds,
      candidateCount: results.length
    });
  } catch (err) {
    console.error('[find-similar-companies]', err);
    return json(res, 500, { error: err.message || 'Could not find similar companies' });
  }
}
