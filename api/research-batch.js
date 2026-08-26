// Vercel Serverless Function: v38 Unified Signal Intelligence Engine.
// Endpoint: POST /api/research-batch
// Purpose: Google-AI-style business signal discovery for House Accounts.
// Pipeline: intent plan -> normalized candidates -> verification/clustering -> AI enrichment -> ranked opportunities.

import {
  buildQueryPlan,
  normalizeCandidate as normalizeSharedCandidate,
  clusterCandidates,
  classifySignalFamily,
  displaySignalType,
  normalizeOpportunity,
  validateOpportunity,
  dedupeOpportunities,
  resolveEventType,
  displayLabelForEventType,
  canonicalTemplateFamily,
  sellerCopyForTemplateFamily,
  extractEventDate,
  findPublicationContextDate,
  calendarDaysBetween,
  resolveOpportunityEvents,
  verifyCandidateCompanyGrounding,
  deriveAccountLocationFromContent,
  diagnoseAccountLocationExtraction,
  COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT,
  normalizeCommercialIntelligence,
  findLikelyRelatedPurchase
} from './signal-intelligence.js';
import { normalizeCompanyName } from './company-identity.js';
import { createHash, timingSafeEqual } from 'crypto';
// Phase 1 monitoring-architecture foundation: the budget-gated synthesis
// call, extracted so its budget is caller-provided rather than hardcoded
// to this endpoint's own ~58s platform ceiling -- see that module's header
// comment for the full extraction-scope rationale (deliberately narrow;
// discoverCandidatesForAccounts/accountPromptContext/pairedPurchases/
// callOpenAIJson stay exported directly from this file rather than being
// physically moved, to avoid a circular import between the two modules).
import { runBudgetedSynthesis } from './lib/research-pipeline.js';

// Phase 2A implementation-review item 5 — instrumentation privacy. Normal
// production logs use counts and hashed identifiers only; raw customer/
// account names and full event_fingerprint strings (which embed a
// normalized company name — see eventFingerprint()/resolveEvents() in
// signal-intelligence.js) are withheld by default. Set the server-side
// (never client-controllable) env var HA_DEBUG_INSTRUMENTATION=true to
// include full identifiers for QA/debugging.
const DEBUG_INSTRUMENTATION = String(process.env.HA_DEBUG_INSTRUMENTATION || '').toLowerCase() === 'true';

// Reliability fix (scale/research-runtime-benchmark) -- time-budget
// constants. Not derived from the earlier 35s hypothesis: real Preview
// evidence showed normal successful single-account requests (Home Depot,
// 'warm-account' mode) totaling roughly 25-33s end to end, with the OpenAI
// synthesis call alone starting around 2.6s in and accounting for nearly
// all of that -- while one observed run instead ran synthesis for ~55s and
// was platform-killed at Vercel's ~58s maxDuration with zero response.
//
// REQUEST_DEADLINE_MS: the point (measured from this invocation's own
// startedAt) beyond which no new provider work should be started. Reserves
// ~8s under the platform's ~58s ceiling -- ample given that once a call
// aborts, everything remaining (parsing, signal shaping, JSON response
// construction) is synchronous, in-memory, and sub-second -- while leaving
// the normal 25-33s case completely untouched.
const REQUEST_DEADLINE_MS = 50000;
// MIN_USEFUL_OPENAI_MS: below this much remaining budget, do not start the
// OpenAI call at all -- measured normal-case synthesis alone already takes
// ~22-30s for a single account, so a call given less time than this is
// overwhelmingly likely to be aborted for nothing, spending real provider
// cost for zero benefit. Fail immediately and truthfully instead (this
// throws into the same catch block a slow-but-real OpenAI failure already
// uses, so it is accounted and logged identically).
const MIN_USEFUL_OPENAI_MS = 15000;
// OPENAI_CALL_MAX_MS: an independent ceiling on the OpenAI call itself even
// when more of REQUEST_DEADLINE_MS is technically still available (e.g. an
// unusually fast discovery/Firecrawl stage) -- keeps consistent margin
// between "the call gave up" and REQUEST_DEADLINE_MS regardless of how much
// budget the earlier stages happened to leave.
const OPENAI_CALL_MAX_MS = 45000;
// Serper/Firecrawl were NOT the offender in the observed failure, but both
// had zero timeout too (confirmed by inspection) -- the same structural
// risk (one hung call consuming the whole budget) applies equally to them.
// These are generous relative to normal call latency for these providers,
// so they should never fire for a genuinely healthy call.
const SERPER_CALL_TIMEOUT_MS = 10000;
// Matches the `timeout` field already sent in the Firecrawl request body
// (a hint to Firecrawl's own API, not previously enforced locally) -- now
// also enforced client-side so a call Firecrawl itself fails to bound does
// not hang this function indefinitely either.
const FIRECRAWL_CALL_TIMEOUT_MS = 12000;

function shortHash(value = '') {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

// Priority 0 (reliability): no maxDuration override existed here before this
// fix (confirmed by repo-wide grep). Verified in the Vercel dashboard: this
// project runs Fluid Compute (Pro plan, 300s project default), so the real
// risk this override addresses is not "might exceed a tiny Hobby ceiling" —
// it's the nested-invocation cancellation gap: aborting the caller's
// (api/weekly-scan.js) client-side fetch does not reliably cancel this
// function's own already-dispatched invocation, which can keep running
// server-side and keep spending external API calls (OpenAI, web search)
// after nobody is listening for the result. This endpoint writes nothing to
// the database itself (verified — no supabase()/ha_signals calls anywhere in
// this file), so a response that arrives after the caller gave up is
// discarded, not persisted; the exposure is wasted compute/API spend, not
// data inconsistency. Capping this function's maxDuration to strictly below
// the caller's per-chunk AbortController timeout (60s, api/weekly-scan.js)
// means the platform itself ends a hung invocation before the caller would
// even give up, rather than after — minimizing that orphaned-spend window
// instead of leaving it open-ended.
//
// The actual override lives in vercel.json's "functions" block (this project
// is zero-config/framework-less; current Vercel guidance for that project
// type is to configure duration there), not as an in-file `export const
// config` — precedence between the two mechanisms when both are present is
// not clearly documented, so this file intentionally does not also export
// one. vercel.json's value for this path must be kept at or below
// api/weekly-scan.js's RESEARCH_FETCH_TIMEOUT_MS by hand.


// Constant-time-ish secret comparison: equal-length secrets are compared via
// crypto.timingSafeEqual (no early-exit on byte mismatch); a length mismatch
// short-circuits to false since Node's timingSafeEqual throws on unequal
// lengths and there is no secret-dependent information to protect in a
// length check alone. Never logs either input. Kept as a local copy (rather
// than imported from weekly-scan.js) so this independently-deployed
// serverless function has no build-time dependency on another one.
function safeSecretEqual(provided, expected) {
  const providedBuf = Buffer.from(String(provided || ''), 'utf8');
  const expectedBuf = Buffer.from(String(expected || ''), 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

function clean(text = '') {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Founder QA follow-up (identity-bootstrap trace): api/research-account.js's
// single-account pipeline already derives an account's likely domain from a
// non-free contact email (see its own domainFromEmailDomain(), fed a
// pre-extracted domain from dashboard/index.html's extractEmailDomain()) --
// but a warm/mixed account (any account with BOTH order history and any
// contact -- see deriveAccountIntelligenceMode()) routes to THIS endpoint
// instead, whose safeAccounts mapping never derived a domain from a contact
// email at all. Confirmed production case: Dover Honda has an order history
// (-> 'mixed' mode -> routed here) and an uploaded contact with a corporate
// email, but no uploaded website/location -- this endpoint had no path to
// ever learn that domain. Mirrors research-account.js's exact free-provider
// exclusion list. Only ever used as a FALLBACK when no website was uploaded
// -- an explicit account.website always wins.
//
// Known, accepted limitation (not solved here): this cannot distinguish a
// contact's own company domain from a parent/dealer-group domain shared
// across many locations (e.g. a large auto group's email domain used by
// several differently-named dealerships). entityMatch()'s domain bonus is
// still additive to, not a replacement for, the bare company-name match, so
// a parent-domain source still has to name the specific account by name to
// benefit at all -- but this does not fully close that gap. Flagged for the
// founder rather than solved with an entity-specific exclusion list.
// Global Business Trigger Intelligence sprint, founder correction round:
// widened to also exclude IANA-reserved documentation/placeholder domains
// (RFC 2606: example.com/.net/.org/.edu) -- see api/research-account.js's
// domainFromEmailDomain() for the full rationale (mirrored here, not
// shared; scripts/test-global-business-trigger-intelligence.js proves both
// endpoints and dashboard/index.html's extractEmailDomain() agree).
const FREE_EMAIL_DOMAINS_RE = /gmail\.com|yahoo\.com|hotmail\.com|outlook\.com|icloud\.com|aol\.com|example\.com|example\.net|example\.org|example\.edu/;
function domainFromContactEmail(email = '') {
  const match = String(email || '').trim().toLowerCase().match(/@([^\s>]+)$/);
  if (!match) return '';
  const domain = match[1].replace(/^www\./, '');
  if (!domain || FREE_EMAIL_DOMAINS_RE.test(domain)) return '';
  return domain;
}

// Problem 3 (Preview QA follow-up round): every AI-generated free-text field
// -- Conversation Starter, why-now copy, business context, etc. -- is capped
// through this single function, which previously always hard-cut at exactly
// `max` characters and only backed off to the nearest earlier WORD boundary,
// never a sentence or clause boundary. That reliably produces fragment
// endings mid-thought (confirmed production case: an Avidia Conversation
// Starter cut to "...saw Avidia Bank celebrated the renovation of its
// Westborough branch with a ceremonial ribbon..." -- a grammatically
// dangling clause, not a usable opener). Prefer the last real sentence
// ending (. ! ?) inside the window, then the last clause boundary (comma,
// semicolon, colon, em/en dash), and only fall back to a bare word boundary
// when neither exists reasonably close to `max` -- "reasonably close" is
// enforced by MIN_KEEP_RATIO so a sentence/clause break very early in the
// text (which would silently produce a much shorter result than the caller
// asked for) is never preferred over the fuller word-boundary cut.
const COMPACT_MIN_KEEP_RATIO = 0.6;
function compact(text = '', max = 240) {
  const t = clean(text);
  if (!t) return '';
  if (t.length <= max) return t;
  const window = t.slice(0, max);
  const minKeep = Math.floor(max * COMPACT_MIN_KEEP_RATIO);

  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  if (sentenceEnd >= minKeep) return window.slice(0, sentenceEnd + 1).trim();

  const clauseEnd = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' — '), window.lastIndexOf(' - '));
  if (clauseEnd >= minKeep) return window.slice(0, clauseEnd).trim() + '…';

  return window.replace(/\s+\S*$/, '') + '…';
}

function parseJsonLoose(text = '') {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }
  const arrayMatch = String(text).match(/\[[\s\S]*\]/);
  if (arrayMatch) { try { return { signals: JSON.parse(arrayMatch[0]) }; } catch {} }
  const objMatch = String(text).match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch {} }
  return null;
}

function sourceDomain(url = '') {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Reliability fix (scale/research-runtime-benchmark, real Home Depot
// evidence): NONE of this file's outbound provider calls previously had any
// timeout -- confirmed by direct inspection of every fetch() call site. A
// single-account request's own stage-timing checkpoints showed synthesis
// starting at 2.6s and the invocation still running at Vercel's ~58s
// maxDuration kill, with no further checkpoint log ever appearing -- i.e.
// the OpenAI call itself ran for ~55s before the PLATFORM silently
// terminated the whole function with zero response. A platform timeout is
// not a JS-catchable event: no further code (not even a catch/finally)
// executes once it fires. fetchWithTimeout() gives every provider call an
// AbortController-bounded ceiling so a slow/hung call fails with a normal,
// catchable Error WELL BEFORE that platform kill -- turning a silent,
// undiagnosable 504 into an ordinary thrown error the existing client code
// already handles correctly (safeParseResearchResponse() in
// dashboard/index.html throws on any !res.ok response, and every caller of
// this endpoint already routes a thrown error into
// reportResearchRunOutcome('fail', ...) -- confirmed by reading each call
// site, not assumed). No client-side change is required for this fix to be
// truthful: a request that times out becomes a failed, retryable research
// run, exactly like any other failure already does today -- never a
// "successful research, zero opportunities" outcome.
async function fetchWithTimeout(url, options = {}, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      let host = url;
      try { host = new URL(url).hostname; } catch {}
      throw new Error(`Request to ${host} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Phase 2D item F: the smallest telemetry improvement for diagnosing rate
// pressure -- a structured log line distinguishing a 429 (rate limit) from
// any other provider failure, with Retry-After captured when the provider
// sends one. Deliberately observability-only: no retry, no backoff, no
// adaptive throttling decision is made from this -- every provider wrapper
// below keeps its existing failure behavior byte-for-byte unchanged, this
// only adds a console.log side effect (which Vercel Observability Plus can
// search/alert on) at the exact moment a 429 is seen. Never logs the
// request body, API key, or any other secret -- only provider name, HTTP
// status, and the numeric retry delay if the header parses.
function logIfRateLimited(provider, resp) {
  if (!resp || resp.status !== 429) return;
  const retryAfterHeader = resp.headers?.get ? resp.headers.get('retry-after') : null;
  const retryAfterSeconds = retryAfterHeader != null && Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) : null;
  console.log('[provider.rate-limited]', JSON.stringify({ provider, httpStatus: resp.status, retryAfterSeconds }));
}

// Identity-bootstrap sprint: returns BOTH the existing compacted string
// (unchanged for every current consumer -- prompt-size-bounded, single-line,
// exactly what it always was) and the raw scraped text before compact()'s
// whitespace collapse. compact() calls clean(), which folds every \n into a
// single space -- fine for a short prompt-ready summary, but it destroys the
// exact line-boundary signal deriveAccountLocationFromContent() depends on
// to tell "Dover Honda -- Dover, NH" apart from the next line down.
// Confirmed production defect: a real, correctly-enriched candidate on the
// account's own trusted domain still failed to yield derived identity,
// because by the time its content reached pageContent, every dealer-group
// directory entry had already been merged onto one line.
async function firecrawlScrape(url) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey || !url) return { compact: '', raw: '' };
  try {
    const resp = await fetchWithTimeout('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, timeout: 12000 })
    }, FIRECRAWL_CALL_TIMEOUT_MS);
    if (!resp.ok) {
      logIfRateLimited('firecrawl', resp);
      return { compact: '', raw: '' };
    }
    const data = await resp.json();
    const text = data?.data?.markdown || data?.markdown || data?.data?.text || data?.text || '';
    return { compact: compact(text, 1800), raw: String(text || '') };
  } catch { return { compact: '', raw: '' }; }
}

async function enrichCandidatesWithFirecrawl(candidates = [], perAccountLimit = 6, totalLimit = 100) {
  if (!process.env.FIRECRAWL_API_KEY) return { candidates, scrapedCount: 0, attemptedCount: 0 };
  const byAccount = new Map();
  const selectedKeys = new Set();
  const selected = [];
  for (const c of candidates) {
    const acct = c.accountName || 'unknown';
    const count = byAccount.get(acct) || 0;
    if (count >= perAccountLimit || selected.length >= totalLimit) continue;
    if (!c.url || /linkedin\.com|facebook\.com|instagram\.com|x\.com|twitter\.com|pdf/i.test(c.url)) continue;
    const key = c.url.split('#')[0].toLowerCase();
    if (selectedKeys.has(key)) continue;
    selectedKeys.add(key);
    byAccount.set(acct, count + 1);
    selected.push(c);
  }
  const scraped = await mapLimit(selected, 8, async c => ({ key: c.url.split('#')[0].toLowerCase(), content: await firecrawlScrape(c.url) }));
  const contentMap = new Map((scraped || []).filter(x => x && x.content && x.content.compact).map(x => [x.key, x.content]));
  let scrapedCount = 0;
  // Prompt-size fix (scale/research-runtime-benchmark): previously this also
  // rewrote `snippet` to `${original snippet}\n\nPage content: ${content}` --
  // re-embedding the SAME scraped text that `pageContent` already carries
  // verbatim. Both fields flow into the synthesis prompt unchanged (see the
  // candidate map below), so every scraped candidate was sending its own
  // content twice for zero additional evidence. Real Home Depot evidence: 30
  // candidates / 63,999 prompt chars, 6 of them Firecrawl-scraped -- each
  // scraped candidate could carry up to ~1800 (pageContent) + ~2200
  // (snippet, itself embedding up to ~2000 of the same content) chars, so up
  // to ~12,000 of the observed 64k characters were this exact duplication
  // for this one request. `snippet` now stays the original short search
  // snippet; `pageContent` remains the sole carrier of scraped content --
  // the same evidence is still sent, exactly once.
  const enriched = candidates.map(c => {
    const content = contentMap.get((c.url || '').split('#')[0].toLowerCase());
    if (!content) return c;
    scrapedCount++;
    // pageContent stays exactly what every existing consumer (prompt
    // synthesis, display) already expects -- compacted, single-line,
    // prompt-size-bounded. pageContentRaw is new and additive: the same
    // scraped text with its real line breaks intact, read ONLY by
    // buildDerivedIdentity()'s name-associated-location extraction, which
    // needs those line boundaries to tell one directory entry from the next.
    return { ...c, pageContent: content.compact, pageContentRaw: content.raw, provider: `${c.provider || 'search'}+firecrawl` };
  });
  return { candidates: enriched, scrapedCount, attemptedCount: selected.length };
}

function safeArray(value, max = 6) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean).slice(0, max);
  return String(value || '').split(/[;|\n,]/).map(clean).filter(Boolean).slice(0, max);
}

function normalizeSignalType(type = '', evidence = '') {
  if (/predictable|seasonal|fallback|timing/i.test(String(type || ''))) return 'Predictable Timing';
  const family = classifySignalFamily(`${type || ''} ${evidence || ''}`);
  return displaySignalType(family);
}

function confidenceNumber(conf) {
  if (typeof conf === 'number') return Math.max(0, Math.min(100, conf > 1 ? conf : conf * 100));
  const n = String(conf || '').match(/\d{1,3}/);
  if (n) return Math.max(0, Math.min(100, Number(n[0])));
  if (/high/i.test(String(conf))) return 86;
  if (/low/i.test(String(conf))) return 45;
  return 70;
}

function confidenceLabel(score) {
  if (score >= 80) return 'High';
  if (score >= 65) return 'Medium';
  return 'Low';
}

function isJunkText(text = '') {
  const t = String(text || '').toLowerCase();
  return !t ||
    /javascript disabled|enable javascript|cookies|privacy policy|terms of use|site map|contact us|skip to content|all rights reserved|page not found|access denied|robot|captcha/.test(t) ||
    t.length < 18;
}

function classifySource(url = '', title = '') {
  const t = `${url} ${title}`.toLowerCase();
  if (/careers|career|jobs|greenhouse|lever|workable|indeed|ziprecruiter|glassdoor/.test(t)) return 'careers';
  if (/news|press|release|announcement|businesswire|prnewswire|globenewswire|mainebiz|inc\.com/.test(t)) return 'news/press';
  if (/community|csr|sustainability|charity|fundraising|sponsor|festival|volunteer/.test(t)) return 'community/csr';
  if (/event|events|conference|expo|summit|webinar|booth|exhibitor/.test(t)) return 'events';
  if (/award|awards|recognition|best places|inc 5000|fastest growing/.test(t)) return 'awards';
  if (/leadership|team|executive|appointed|named|promoted/.test(t)) return 'leadership';
  if (/linkedin/.test(t)) return 'linkedin';
  return 'web';
}

function queryTemplates(company, context = {}, mode = 'ranked') {
  const loc = context.location ? ` ${context.location}` : '';
  const industry = context.industry ? ` ${context.industry}` : '';
  const quoted = `"${company}"`;
  const domain = String(context.website || '').replace(/^https?:\/\//,'').replace(/^www\./,'').split('/')[0] || '';

  if (mode === 'prospect-intelligence' || mode === 'warm-account') {
    // Prospect Intelligence must attempt an intent-driven buying-moment search chain
    // before creating Predictable Timing fallback opportunities. Keep searches surgical:
    // the goal is to find concrete reasons to contact the company now, not summarize it.
    const industryLower = String(context.industry || '').toLowerCase();
    const industryEventTerms =
      /packaging|manufactur|industrial|automation|food|beverage|consumer goods/.test(industryLower) ? `"PACK EXPO" OR "Battery Show" OR "MD&M" OR "CES"` :
      /medical|health|device|biotech|pharma/.test(industryLower) ? `"MD&M" OR "BIO International" OR "AACC" OR "HIMSS"` :
      /software|technology|electronics|robotics|ai|data/.test(industryLower) ? `"CES" OR "TechCrunch" OR "AWS re:Invent" OR "SaaStr"` :
      '';

    return [
      // A. Growth / Launch / Corporate Change
      `${quoted}${loc} AND ("subsidiary" OR "launch" OR "spin-off" OR acquired OR merger OR rebrand)`,
      `${quoted}${loc} AND ("new facility" OR expansion OR "ribbon cutting" OR headquarters OR "manufacturing plant" OR "new location" OR "distribution center")`,

      // B. Events / Conferences / Trade Shows
      `${quoted}${loc} AND (exhibitor OR booth OR conference OR expo OR "trade show" OR summit OR "open house" OR "customer event" OR webinar)`,
      industryEventTerms ? `${quoted}${loc} AND (${industryEventTerms})` : '',

      // C. Hiring / People / Culture
      `${quoted}${loc} AND (hiring OR careers OR jobs OR "now hiring")`,
      `${quoted}${loc} AND ("employee experience" OR "talent acquisition" OR "people operations" OR HR OR onboarding)`,
      `${quoted}${loc} AND ("event coordinator" OR "field marketing" OR "trade show manager" OR "marketing manager")`,
      `${quoted}${loc} AND (appointed OR promoted OR "named president" OR "named CEO" OR "named vice president" OR "joins as" OR "new executive" OR "leadership change")`,
      context.contactName ? `"${context.contactName}" "${company}"${loc} (appointed OR promoted OR promotion OR "new role" OR "joins" OR "named" OR "new company")` : '',

      // D. Community / Sponsorship / CSR
      `${quoted}${loc} AND (sponsor OR "community event" OR charity OR volunteer OR "golf tournament" OR "5K")`,
      `${quoted}${loc} AND (school OR STEM OR foundation OR donation OR fundraiser)`,

      // E. Awards / Milestones / Recognition
      `${quoted}${loc} AND (award OR recognized OR anniversary OR milestone)`,
      `${quoted}${loc} AND ("safety milestone" OR "years without" OR "lost-time accident")`,

      // F. Operational Friction / Internal Morale. These are only usable when handled with care.
      `${quoted}${loc} AND (lawsuit OR "legal dispute" OR court OR town OR "power outage" OR "facility issue")`,

      // G. Media / Trade Publication Coverage
      `${quoted}${loc} AND ("featured in" OR interview OR magazine OR profile)`,

      // Owned-site intent pages. Firecrawl enrichment will prioritize these later.
      // (Already domain-scoped -- appending location here would only narrow
      // an already-precise site: search, not disambiguate an ambiguous name.)
      domain ? `site:${domain} (news OR press OR "press release" OR blog OR careers OR jobs OR events OR community OR locations OR sustainability)` : '',
      domain ? `site:${domain} ("trade show" OR conference OR booth OR exhibitor OR "open house" OR webinar OR event OR summit)` : '',
      domain ? `site:${domain} ("new facility" OR "new location" OR expansion OR "ribbon cutting" OR anniversary OR award OR launch OR partnership)` : '',
      context.oneOffResearch && context.contactName ? `"${context.contactName}" "${company}"${loc} (interview OR podcast OR webinar OR conference OR speaker OR award OR promoted OR promotion OR article OR quoted OR patent OR LinkedIn)` : '',
      context.oneOffResearch && context.contactName ? `"${context.contactName}" "${company}"${loc} (community OR volunteer OR anniversary OR launch OR event OR initiative)` : ''
    ].filter(Boolean);
  }
  // Existing customer/house account workflows keep the original broader research strategy.
  return [
    `${quoted}${loc}${industry}`,
    `${quoted}${loc} (acquired OR acquisition OR merger OR merged OR funding OR investment OR "private equity" OR partnership OR "customer win" OR contract)`,
    `${quoted}${loc} (hiring OR jobs OR careers OR "now hiring" OR recruiting OR "open positions" OR "join our team")`,
    `${quoted}${loc} (summit OR conference OR expo OR exhibitor OR booth OR webinar OR event OR sponsor OR sponsorship)`,
    `${quoted}${loc} (award OR "Inc. 5000" OR "fastest growing" OR "best places to work" OR recognition OR milestone OR anniversary)`,
    `${quoted}${loc} (launch OR unveiled OR rollout OR "new product" OR "new division" OR rebrand OR "new service")`,
    `${quoted}${loc} (expansion OR "new office" OR "new location" OR facility OR headquarters OR warehouse OR manufacturing OR "new building")`,
    `${quoted}${loc} (community OR charity OR fundraiser OR sponsorship OR sustainability OR volunteer OR donation OR nonprofit)`,
    `${quoted}${loc} (CEO OR president OR "vice president" OR appointed OR named OR promoted OR leadership OR joins OR "new executive")`,
    context.contactName ? `"${context.contactName}" "${company}" (appointed OR promoted OR promotion OR "new role" OR joins OR named OR "new company")` : '',
    `site:${domain} (${quoted} OR news OR press OR careers OR events OR awards OR community OR leadership)`,
    `${quoted}${loc} ("trade show" OR "annual meeting" OR "open house" OR "customer event" OR "sales kickoff")`,
    `${quoted}${loc} ("safety" OR "employee engagement" OR "recognition program" OR "recruiting campaign")`
  ].filter(q => !q.startsWith('site: '));
}

// Trust correction (identity-bootstrap follow-up): title/snippet must NEVER
// assert the account's name before any content has actually been fetched --
// account.website may be a shared/group domain (e.g. derived from a
// contact's email at a multi-brand dealer group, not necessarily this exact
// account's own exclusive site), and entityMatch() scans title/snippet
// directly. A synthetic placeholder that says "Dover Honda careers page"
// would satisfy the bare-name-match check on its own say-so, before
// Firecrawl ever confirms the fetched page has anything to do with the
// account -- exactly the "corroborator manufactures the entity match"
// failure mode the name-match gate fix (verifyCandidateCompanyGrounding())
// exists to close. These placeholders describe only what House Accounts
// itself did (probed this domain/path) and carry zero claim about what the
// page contains -- accountName stays as ROUTING metadata (which account
// this candidate belongs to, consumed by requireResolvedCandidate() and
// similar), never as TEXT entityMatch() can read as evidence. Once
// Firecrawl enrichment adds real pageContent, THAT content -- not this
// placeholder -- is what establishes (or fails to establish) grounding.
function priorityOwnedPages(account = {}) {
  const website = clean(account.website || '');
  if (!website) return [];
  let origin = '';
  try { origin = new URL(website.startsWith('http') ? website : `https://${website}`).origin; } catch { return []; }
  const paths = ['/news','/press','/press-releases','/blog','/careers','/jobs','/events','/community','/about','/sustainability','/locations'];
  const domainLabel = sourceDomain(origin) || 'unverified source';
  return paths.map(path => ({
    title: `${domainLabel} ${path.replace('/', '') || 'site'} page (unverified, pending content fetch)`,
    snippet: `Unverified candidate discovered by probing ${origin}${path} for this account's associated domain. No content has been fetched yet -- this placeholder is provenance only and cannot itself establish company identity.`,
    url: `${origin}${path}`,
    source: sourceDomain(origin),
    date: '',
    provider: 'owned-site',
    query: 'priority-owned-page',
    accountName: account.name,
    sourceType: 'owned-page',
    score: 18
  }));
}

// Ephemeral account-identity bootstrap (identity-bootstrap sprint). Only
// ever used to strengthen grounding for THIS research run -- never
// persisted to ha_accounts/ha_signals, never mutates safeAccounts itself.
//
// Ordering/non-circularity: this must be built ONLY from candidates that
// are (a) real fetched content (never a synthetic priorityOwnedPages()
// placeholder -- Firecrawl's own pageContent field is the only source
// scanned) and (b) hosted on the account's own trusted domain (uploaded
// website, or the contact-email-derived organizational domain). The
// third-party candidate later evaluated USING this derived identity
// (e.g. a dovernh.org signal) is never itself eligible to BE the identity
// source -- it lives on a different domain entirely, and the caller
// additionally excludes the exact sourceUrl this identity came from when
// grounding candidates, so a page can never verify itself.
//
// Trust distinction preserved (see websiteProvenance on safeAccounts): an
// uploaded website is a direct user assertion; a contact-derived domain
// only proves an organizational relationship. Both are required to run
// through the SAME strict extraction (deriveAccountLocationFromContent()'s
// name-associated-location rule, never global co-presence) before
// anything is derived -- a shared/group domain's page must explicitly tie
// the account name to a location exactly like any other source would.
function buildDerivedIdentity(account = {}, candidates = []) {
  const domain = clean(account.website || '');
  if (!domain) return null;
  const eligible = (candidates || []).filter(c => {
    if (!c || !c.pageContent) return false; // real fetched content only, never a synthetic placeholder
    const candidateDomain = sourceDomain(c.url || '');
    if (!candidateDomain) return false;
    return candidateDomain === domain || candidateDomain.endsWith(`.${domain}`);
  });
  for (const candidate of eligible) {
    // Prefer pageContentRaw (real line breaks intact -- see
    // enrichCandidatesWithFirecrawl()'s own comment) so a dealer-group
    // directory's line-by-line entries stay distinguishable. Falls back to
    // the compacted pageContent only for a candidate shape that never had a
    // raw variant (defensive, not the expected production path).
    const location = deriveAccountLocationFromContent(account.name, candidate.pageContentRaw || candidate.pageContent);
    if (location) {
      return {
        domain,
        domainProvenance: account.websiteProvenance || '',
        location,
        sourceUrl: candidate.url,
        sourceType: 'official-domain-account-page',
        confidence: 'confirmed'
      };
    }
  }
  return null;
}

// Firecrawl-slot prioritization (identity-bootstrap sprint): reorders the
// pooled candidate list -- SAME array, same length, same total enrichment
// ceiling -- so a candidate that already shows real, pre-fetch identity
// specificity gets first claim on enrichCandidatesWithFirecrawl()'s
// per-account slots, instead of competing on unrelated content-based
// scoring alone. This spends the EXISTING budget differently; it adds no
// query and no provider call.
//
// Conservative eligibility, exactly as scoped -- ALL THREE required:
//   1. hosted on the account's own trusted domain (uploaded or contact-
//      derived);
//   2. its title/snippet ALREADY (pre-fetch) names the account by a bare
//      phrase match -- a real search-result signal, not a guess;
//   3. is not a synthetic owned-page placeholder -- automatically excluded
//      by (2), since priorityOwnedPages()'s placeholders no longer contain
//      the account name in their title/snippet at all (see the trust/
//      provenance checkpoint fix). No separate check is needed for this,
//      but the invariant is asserted directly in this function's own test.
function prioritizeIdentityBootstrapCandidates(candidates = [], accountsByName = new Map()) {
  const isEligible = (c) => {
    if (!c || !c.url) return false;
    const account = accountsByName.get(c.accountName);
    const domain = clean(account?.website || '');
    if (!domain) return false;
    const candidateDomain = sourceDomain(c.url);
    if (!candidateDomain || (candidateDomain !== domain && !candidateDomain.endsWith(`.${domain}`))) return false;
    const companyName = clean(account?.name || '').toLowerCase();
    if (!companyName) return false;
    const text = `${c.title || ''} ${c.snippet || ''}`.toLowerCase();
    return text.includes(companyName);
  };
  const prioritized = [];
  const rest = [];
  for (const c of candidates || []) (isEligible(c) ? prioritized : rest).push(c);
  return [...prioritized, ...rest];
}

function parseSignalDate(dateText = '') {
  const t = String(dateText || '').trim();
  if (!t) return null;
  const d = new Date(t);
  if (!isNaN(d.getTime())) return d;
  const y = t.match(/\b(20\d{2})\b/);
  if (y) return new Date(`${y[1]}-06-15T00:00:00Z`);
  return null;
}

function freshnessScore(dateText = '') {
  const t = String(dateText || '').toLowerCase();
  if (/today|yesterday|this week|recently|now|upcoming|current/.test(t)) return 100;
  const d = parseSignalDate(dateText);
  if (!d) return 55;
  const days = Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
  if (days <= 30) return 100;
  if (days <= 90) return 88;
  if (days <= 180) return 74;
  if (days <= 365) return 58;
  if (days <= 730) return 28;
  return 5;
}

function sourceQualityScore(url = '', sourceType = '') {
  const t = `${url} ${sourceType}`.toLowerCase();
  if (/company|careers|job posting|news\/press|businesswire|prnewswire|globenewswire|press release/.test(t)) return 95;
  if (/mainebiz|inc\.com|forbes|industry|association|mereda|chamber|conference|expo/.test(t)) return 82;
  if (/linkedin/.test(t)) return 72;
  if (/facebook|instagram|x\.com|twitter/.test(t)) return 50;
  return 64;
}

function adjustedConfidence(raw = {}, sourceUrl = '', sourceType = '') {
  const ai = confidenceNumber(raw.confidence || raw.opportunityScore || raw.score || 70);
  const fresh = freshnessScore(raw.publicationDate || raw.publishedDate || raw.date || '');
  const source = sourceQualityScore(sourceUrl || raw.sourceUrl || '', sourceType || raw.sourceType || raw.sourceName || '');
  const multi = Array.isArray(raw.sources) && raw.sources.length > 1 ? 100 : 55;
  return Math.round(Math.max(0, Math.min(100, (source * 0.35) + (fresh * 0.30) + (ai * 0.25) + (multi * 0.10))));
}

async function serperSearch(query) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return [];
  let httpStatus = 0;
  try {
    const resp = await fetchWithTimeout('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 8 })
    }, SERPER_CALL_TIMEOUT_MS);
    httpStatus = resp.status;
    if (!resp.ok) {
      logIfRateLimited('serper', resp);
      return [{
        title: '',
        snippet: '',
        url: '',
        source: '',
        date: '',
        provider: 'serper',
        query,
        httpStatus,
        rateLimited: httpStatus === 429,
        searchError: `Serper returned HTTP ${httpStatus}`
      }];
    }
    const data = await resp.json();
    return [...(data.organic || []), ...(data.news || [])].map(r => ({
      title: clean(r.title),
      snippet: clean(r.snippet || r.description || ''),
      url: r.link || r.url || '',
      source: r.source || sourceDomain(r.link || r.url || ''),
      date: r.date || '',
      provider: 'serper',
      query,
      httpStatus
    })).filter(r => r.url || r.title).slice(0, 10);
  } catch (error) {
    return [{
      title: '',
      snippet: '',
      url: '',
      source: '',
      date: '',
      provider: 'serper',
      query,
      httpStatus,
      searchError: error?.message || 'Serper request failed'
    }];
  }
}

async function tavilySearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];
  try {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, query, search_depth: 'advanced', max_results: 8, include_answer: false })
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.results || []).map(r => ({
      title: clean(r.title),
      snippet: clean(r.content || r.snippet || ''),
      url: r.url || '',
      source: sourceDomain(r.url || ''),
      date: r.published_date || '',
      provider: 'tavily',
      query
    })).filter(r => r.url || r.title).slice(0, 8);
  } catch { return []; }
}

async function braveSearch(query) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return [];
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8&freshness=py`;
    const resp = await fetch(url, { headers: { 'X-Subscription-Token': apiKey, 'Accept': 'application/json' } });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.web?.results || []).map(r => ({
      title: clean(r.title),
      snippet: clean(r.description || ''),
      url: r.url || '',
      source: sourceDomain(r.url || ''),
      date: r.age || '',
      provider: 'brave',
      query
    })).filter(r => r.url || r.title).slice(0, 8);
  } catch { return []; }
}

async function runSearch(query) {
  // Prospect Intelligence uses Serper as the configured search provider.
  // Do not require Tavily or Brave for targeted search.
  return await serperSearch(query);
}

function scoreCandidate(r, accountName) {
  const text = `${r.title} ${r.snippet} ${r.url}`;
  const t = text.toLowerCase();
  if (isJunkText(text)) return 0;
  let score = 0;
  if (t.includes(accountName.toLowerCase().split(' ')[0])) score += 8;

  // High-intent buying moments get priority over generic company activity.
  if (/facility expansion|new facility|ribbon cutting|new location|distribution center|warehouse|plant opening|headquarters opening/.test(t)) score += 34;
  if (/trade show|exhibitor|booth|conference|expo|summit|open house|customer event|dealer meeting|sales meeting|webinar/.test(t)) score += 32;
  if (/product launch|unveiled|rollout|new product|new division|rebrand|merger|acquisition/.test(t)) score += 28;
  if (/contract win|major contract|customer win|partnership|awarded|selected by|major deal/.test(t)) score += 27;
  if (/hiring hr|hiring marketing|event manager|field marketing|employee experience|talent acquisition|people operations|onboarding/.test(t)) score += 26;
  if (/safety milestone|anniversary|award|recognized|inc\.? 5000|fastest growing|best places to work|winner/.test(t)) score += 20;
  if (/community event|charity|fundraiser|sponsorship|sponsor|festival|volunteer|philanthropy/.test(t)) score += 18;

  // Generic versions still count, but less.
  if (/hiring|jobs|careers|now hiring|open positions|recruiting/.test(t)) score += 12;
  if (/launch|unveiled|rollout|new product|new division|rebrand/.test(t)) score += 10;
  if (/expansion|new office|new location|facility|headquarters|warehouse|manufacturing/.test(t)) score += 12;
  if (/acquired|acquisition|merger|funding|investment|partnership|customer win|contract/.test(t)) score += 10;
  if (/2026|2025|today|yesterday|this week|recently|announced|upcoming|now/.test(t)) score += 10;
  if (/layoff|downsizing|bankruptcy|plant closure|closure|recall|scandal|investigation/.test(t)) score -= 40;
  if (/lawsuit|legal dispute|court|town|power outage|facility issue|operational disruption/.test(t)) score += 10;
  if (/contact us|privacy|terms|map|directions|mission statement|history/.test(t)) score -= 20;
  return Math.max(0, score);
}

function normalizedCandidateUrl(value = '') {
  try {
    const u = new URL(value);
    u.hash = '';
    // Remove common tracking parameters so the same article is not treated as new evidence.
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid'].forEach(k => u.searchParams.delete(k));
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch {
    return String(value || '').split('#')[0].toLowerCase();
  }
}

function normalizedCandidateTitle(value = '') {
  return clean(value)
    .toLowerCase()
    .replace(/\b(press release|news release|breaking news|updated)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w.length > 2)
    .slice(0, 14)
    .join(' ');
}

function dedupeCandidates(candidates = []) {
  const seenUrls = new Set();
  const seenStories = new Set();
  const out = [];
  for (const c of candidates) {
    const urlKey = normalizedCandidateUrl(c.url || '');
    const titleKey = normalizedCandidateTitle(c.title || c.snippet || '');
    const storyKey = `${String(c.accountName || '').toLowerCase()}|${titleKey}`;
    if ((urlKey && seenUrls.has(urlKey)) || (titleKey && seenStories.has(storyKey))) continue;
    if (urlKey) seenUrls.add(urlKey);
    if (titleKey) seenStories.add(storyKey);
    out.push(c);
  }
  return out;
}

function prospectDebugLog(label, payload = {}) {
  try {
    console.log(`[Prospect Research] ${label}`, JSON.stringify(payload, null, 2));
  } catch {
    console.log(`[Prospect Research] ${label}`, payload);
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      try { results[current] = await mapper(items[current], current); }
      catch (e) { results[current] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// product/commercial-activation-reasoning, Core defect fix: safeAccounts
// (below) never carried a paired {category, project, dateStr} purchase
// shape through at all -- accountPromptContext()'s own `recentPurchases`
// field (used only for recent-past fulfillment judgment in the live
// model's own prompt, see COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT) and
// findLikelyRelatedPurchase()'s deterministic fallback (called below with
// `account.purchases`) both silently read undefined forever, so an
// uploaded purchase could never be matched to a recent-past signal on this
// path. The dashboard's own batchPayloadForAccounts() already computes and
// sends this exact paired shape as `recentPurchases`; this accepts either
// that pre-paired shape or a raw uploaded purchases array (other callers,
// e.g. api/weekly-scan.js's accountPayload()) and normalizes either into
// the one shape both consumers need.
function pairedPurchases(a = {}) {
  const source = (Array.isArray(a.recentPurchases) && a.recentPurchases.length) ? a.recentPurchases : a.purchases;
  return Array.isArray(source)
    ? source.map(p => ({ category: p?.category || '', project: p?.project || '', dateStr: p?.dateStr || p?.date || p?.orderDate || p?.order_date || '' })).filter(p => p.dateStr).slice(0, 8)
    : [];
}

function accountPromptContext(accounts) {
  return accounts.map((a, idx) => ({
    id: String(idx),
    name: clean(a.name),
    industry: clean(a.industry || ''),
    location: clean(a.cityState || a.location || ''),
    website: clean(a.website || ''),
    notes: clean(a.notes || ''),
    historicalRevenue: a.revenue || 0,
    orderCount: a.orderCount || 0,
    relationshipScore: a.relationshipStrength || a.relationshipScore || '',
    quickWinScore: a.quickWinScore || '',
    historicalCategoriesPurchased: Array.isArray(a.categories) ? a.categories.slice(0, 10) : [],
    recentOrderDates: Array.isArray(a.recentOrderDates) ? a.recentOrderDates.slice(0, 5) : [],
    // product/commercial-opportunity-intelligence, QA correction round 2:
    // PAIRED {category, project, dateStr} records -- unlike the two fields
    // above, which are separate, unpaired arrays -- so the model can judge
    // whether an uploaded purchase date is genuinely close to a recent-past
    // signal's event date (see COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT).
    recentPurchases: Array.isArray(a.recentPurchases) ? a.recentPurchases.slice(0, 8) : [],
    knownContacts: Array.isArray(a.contacts) ? a.contacts.slice(0, 6) : [],
    existingSignals: Array.isArray(a.existingSignals) ? a.existingSignals.slice(0, 5) : [],
    repeatPatterns: Array.isArray(a.repeatPatterns) ? a.repeatPatterns.slice(0, 5) : [],
    intelligenceMode: clean(a.intelligenceMode || ''),
    assignedRep: clean(a.assignedRep || '')
  }));
}

async function discoverCandidatesForAccounts(accounts = [], mode = 'ranked') {
  const sourceCoverage = {};
  const allCandidates = [];
  const samples = [];
  const diagnostics = [];
  const perAccount = await mapLimit(accounts, Math.max(1, Math.min(Number(process.env.RESEARCH_ACCOUNT_CONCURRENCY || 4), 8)), async account => {
    const accountStartedAt = Date.now();
    const accountMode = clean(account.intelligenceMode).toLowerCase();
    const effectiveMode = (accountMode === 'warm' || accountMode === 'mixed') ? 'warm-account' : mode;
    const sharedPlan = buildQueryPlan(account.name, account);
    const sharedQueries = sharedPlan.map(item => item.query);
    const allQueries = [...sharedQueries, ...queryTemplates(account.name, account, effectiveMode)]
      .filter((q, index, arr) => q && arr.indexOf(q) === index);
    // Prospect mode remains deepest, while existing-customer research now receives
    // enough coverage to find multiple distinct public buying moments per account.
    const deepResearch = effectiveMode === 'prospect-intelligence' || effectiveMode === 'warm-account';
    const queryLimit = Math.max(6, Math.min(Number(process.env.RESEARCH_QUERIES_PER_ACCOUNT || (deepResearch ? 12 : 10)), 18));
    const queries = allQueries.slice(0, queryLimit);
    // Phase 2D item D: bound Serper dispatch specifically for the
    // Queue-worker ('weekly-monitoring') path -- the Phase 2D concurrency
    // audit found this line was the one materially bursty phase in the
    // whole pipeline, firing ALL of one account's queries via a fully
    // unbounded Promise.all (up to 18 simultaneous requests, the env-
    // clamped ceiling on queryLimit above). Every other mode (interactive
    // research, prospect intelligence, warm-account) is unaffected:
    // passing queries.length as mapLimit()'s own concurrency limit spins
    // up exactly queries.length single-item workers, which is
    // behaviorally identical concurrent dispatch to
    // Promise.all(queries.map(runSearch)) -- interactive timing does not
    // change. Absolute query count and result-set order are unchanged
    // either way: mapLimit() (defined above) preserves input-index order
    // in its output array regardless of completion order, which is
    // exactly what queriesWithResults below already depends on. runSearch()
    // never rejects (serperSearch() catches internally and always returns
    // an array), so mapLimit()'s own per-item error handling is never
    // reached in practice -- switching from Promise.all changes only
    // simultaneous dispatch, nothing else observable.
    const serperConcurrencyLimit = mode === 'weekly-monitoring'
      ? Math.max(1, Number(process.env.MONITORING_SERPER_CONCURRENCY || 4))
      : queries.length;
    // Phase 2D item F: observability for the configured monitoring Serper
    // concurrency bound itself, distinct from the per-request 429 telemetry
    // in logIfRateLimited() -- lets Observability Plus confirm the bound in
    // effect on a given Queue worker without inferring it from request timing.
    if (mode === 'weekly-monitoring') {
      console.log('[research-batch.serper-concurrency]', JSON.stringify({ accountName: account.name, serperConcurrencyLimit, queryCount: queries.length }));
    }
    const resultSets = await mapLimit(queries, serperConcurrencyLimit, runSearch);
    const rawSearchResults = resultSets.flat();
    let raw = rawSearchResults.filter(r => r && (r.url || r.title));
    if (deepResearch) raw = raw.concat(priorityOwnedPages(account));

    const scored = raw.map(r => {
      const queryPlanItem = sharedPlan.find(item => item.query === r.query);
      const legacyScore = scoreCandidate(r, account.name);
      const normalized = normalizeSharedCandidate({
        ...r,
        accountName: account.name,
        intendedSignalFamily: queryPlanItem?.signalFamily || '',
        sourceType: classifySource(r.url, r.title)
      }, account, queryPlanItem?.signalFamily || '');
      return {
        ...normalized,
        sourceType: classifySource(r.url, r.title),
        score: Math.round((legacyScore * 0.45) + ((normalized.candidateScore || 0) * 0.55))
      };
    });

    const ranked = clusterCandidates(dedupeCandidates(scored
      .filter(r => r.entityVerification?.level !== 'rejected')
      .filter(r => r.score >= (deepResearch ? 10 : 12))
      .sort((a,b) => b.score - a.score)))
      .slice(0, deepResearch ? 30 : 24);

    const liveCandidateCount = ranked.filter(r => (r.provider || '') !== 'owned-site' && r.score >= 18).length;
    const highIntentCandidateCount = ranked.filter(r => r.score >= 28).length;
    const queriesWithResults = queries.map((q, i) => {
      const set = resultSets[i] || [];
      const realResults = set.filter(r => r && (r.url || r.title));
      const statuses = [...new Set(set.map(r => r.httpStatus).filter(Boolean))];
      const errors = set.map(r => r.searchError).filter(Boolean);
      return {
        query: q,
        provider: 'serper',
        serperHttpStatus: statuses.length ? statuses.join(',') : (process.env.SERPER_API_KEY ? 'no-status' : 'not-configured'),
        resultsReturned: realResults.length,
        error: errors[0] || ''
      };
    });

    diagnostics.push({
      companyName: account.name,
      targetedQueriesRun: queries.length,
      queries: queriesWithResults,
      sourcesReturned: raw.length,
      rankedCandidates: ranked.length,
      topSources: ranked.slice(0, 5).map(r => ({
        title: r.title,
        url: r.url,
        domain: sourceDomain(r.url),
        sourceType: r.sourceType,
        score: r.score,
        query: r.query
      })),
      liveSignalCandidateFound: liveCandidateCount > 0,
      highIntentCandidateFound: highIntentCandidateCount > 0,
      fallbackEligibleAfterSearch: highIntentCandidateCount === 0,
      uniqueCandidateUrls: new Set(ranked.map(r => normalizedCandidateUrl(r.url)).filter(Boolean)).size,
      enrichedPages: ranked.filter(r => r.pageContent).length,
      status: 'processed',
      elapsedMs: Date.now() - accountStartedAt
    });

    if (mode === 'prospect-intelligence' || mode === 'warm-account') {
      prospectDebugLog('Targeted search complete', {
        company: account.name,
        // Benchmark diagnostic (scale/research-runtime-benchmark): elapsed
        // time for THIS account's discovery stage, since a genuine Vercel
        // platform timeout kills the invocation before any response body
        // (including the diagnostics.searchDiagnostics[].elapsedMs this
        // function already returns) can ever reach the client -- only a
        // console.log line that executed before the kill survives. accountStartedAt
        // is set at the top of this account's own worker in mapLimit(), a few
        // ms after request start for a single-account request.
        elapsedMs: Date.now() - accountStartedAt,
        queriesRun: queries,
        queryResultCounts: queriesWithResults,
        resultsReturned: raw.length,
        rankedCandidates: ranked.length,
        topResults: ranked.slice(0, 3).map(r => ({
          title: r.title,
          url: r.url,
          sourceType: r.sourceType,
          score: r.score,
          query: r.query
        })),
        liveSignalCandidateFound: liveCandidateCount > 0,
        highIntentCandidateFound: highIntentCandidateCount > 0,
        fallbackEligibleAfterSearch: highIntentCandidateCount === 0
      });
    }

    for (const r of ranked) {
      sourceCoverage[r.provider || 'search'] = (sourceCoverage[r.provider || 'search'] || 0) + 1;
      sourceCoverage[r.sourceType || 'web'] = (sourceCoverage[r.sourceType || 'web'] || 0) + 1;
    }
    samples.push(...ranked.slice(0, 3).map(r => ({
      accountName: account.name,
      status: 'candidate',
      reason: `score ${r.score}`,
      title: r.title,
      domain: sourceDomain(r.url),
      sourceType: r.sourceType,
      query: r.query
    })));
    allCandidates.push(...ranked);
    return ranked;
  });
  return { candidates: allCandidates, perAccount, sourceCoverage, samples, diagnostics };
}

function responseOutputText(data = {}) {
  if (typeof data.output_text === 'string') return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'output_text' && part.text) chunks.push(part.text);
      if (part.text && typeof part.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('\n');
}

// Commercial-readiness core validation, item 1: the OpenAI Responses API
// already reports token usage in every response body (data.usage) -- this
// was previously discarded. Returning it alongside the text (rather than
// adding a separate metered call) is the smallest reliable way to capture
// real token counts.
function openaiUsageFromResponse(data = {}) {
  const usage = data?.usage || {};
  return {
    inputTokens: Number(usage.input_tokens || usage.prompt_tokens || 0) || 0,
    outputTokens: Number(usage.output_tokens || usage.completion_tokens || 0) || 0,
    totalTokens: Number(usage.total_tokens || 0) || 0
  };
}
async function callOpenAIJson({ apiKey, model, prompt, timeoutMs }) {
  const resp = await fetchWithTimeout('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: prompt,
      temperature: 0.1,
      max_output_tokens: 9000
    })
  }, timeoutMs);
  if (!resp.ok) {
    logIfRateLimited('openai', resp);
    throw new Error(await resp.text().catch(() => `OpenAI error ${resp.status}`));
  }
  const data = await resp.json();
  return { text: responseOutputText(data), usage: openaiUsageFromResponse(data) };
}

async function callOpenAIWebSearch({ apiKey, model, accounts, timeoutMs }) {
  const prompt = `Research these companies for public buying moments that create timely reasons for a promotional-products salesperson to start a conversation.

House Accounts is not trying to summarize companies. It is trying to answer: "Why should I contact this company today?"

For accounts marked intelligenceMode="warm", treat them as known or assigned relationships without uploaded order history. Use uploaded contacts first when they align with the opportunity. Do not describe them as cold prospects and do not invent historical purchases.

Use the account context below, including any uploaded contacts. Research each company once. If uploaded contacts align with the recommended buying team, they may be used as potentialContacts. Do not invent people.

Accounts:
${JSON.stringify(accountPromptContext(accounts), null, 2)}

Extract concrete buying moments from the last 18 months when possible. Prioritize: facility expansion, new location, ribbon cutting, trade show/exhibitor participation, booth/conference/summit/webinar/customer event, product launch, hiring with HR/marketing/event/employee-experience context, community event/sponsorship, corporate philanthropy, safety milestone, company anniversary, major award actively promoted, partnership/contract win, rebrand, merger, acquisition, open house, dealer meeting, sales meeting.

Do not summarize companies. Do not return generic company descriptions. Suppress clearly negative or irrelevant signals such as layoffs, downsizing, restructuring, bankruptcy, lawsuits, plant closures, investigations, recalls, or scandals. Do not use generic sustainability claims unless tied to a concrete event, certification, award, facility, deadline, campaign, partnership, or active program.

Preserve the concrete trigger. Do not reduce "New Facility Inauguration in Virginia" to "Expansion" or "Hosting FTC Scrimmage at headquarters" to "Community engagement." Use concrete_trigger and signalTitle to name the specific event.

For each accepted signal, answer both: what happened and why it likely happened. Add a short businessContext. For hiring signals, identify whether hiring appears tied to growth, expansion, new facility, product launch, seasonal ramp, contract demand, leadership change, or increased production demand. If the driver is not clear, say that naturally and lower confidence rather than omitting a meaningful signal.

Score every signal using ABD:
- actionability_score: how clear is the reason to reach out?
- budget_score: does this usually create promotional spend?
- deadline_score: is there a timely reason to act now?

Openers must reference the concrete trigger and suggest a specific promotional play, then ask for a simple next step. Example: "Saw [Company] is opening its new Virginia facility. For plant rollouts, teams usually balance employee onboarding, local PR, and opening-day gifts. I had a few ideas around durable branded apparel and launch kits — worth sending over?"

Recommended Buying Team rules:
- Always include recommended_buying_team with 1 to 3 departments inferred from the signal and context.
- Examples: HR / People, Talent Acquisition, Marketing, Events, Operations, Community Relations, Product Marketing, Sales.

Leadership and contact-change rules:
- Treat executive appointments, promotions, known-contact role changes, and known-contact company changes as Leadership Change only when the person, company, and new role are supported by a credible public source.
- Preserve the person's name, exact new title, company, and announcement date when available.
- A leadership change is not automatically high priority. Rank it against facility expansion, acquisitions, launches, events, hiring initiatives, seasonal buying windows, and other opportunities using the same ABD / Why Now logic.
- Penalize stale, weakly sourced, or role-only leadership mentions. Do not infer a promotion or company change from an undated directory listing alone.

Potential Contacts rules:
- Include potential_contacts only when a public source or uploaded contact supports the person and role.
- If a user supplied a contact name, attempt to verify that person first and prefer them when the evidence supports their company and role.
- Return at most 2 contacts.
- Never invent names, titles, email addresses, phone numbers, LinkedIn URLs, or contact pages.
- For each verified public contact, return only public details actually present in the supplied research: linkedin, email, direct_phone, company_phone, contact_page, confidence, and sources_used.
- Research confidence describes verification quality, not buying intent. Use High only when name, title, and company are verified; Medium when name/company are verified but title is inferred or incomplete; Low for department-only recommendations.

Return JSON only with shape: {"signals":[{"company_name":"","accountName":"","signal_type":"","signalType":"","concrete_trigger":"","buying_moment":"","signalTitle":"","whatChanged":"","event_date":"","location":"","source_url":"","source_name":"","business_context":"","businessContext":"","why_this_matters":"","whyItMattersForPromo":"","recommended_buying_team":[""],"recommendedBuyingTeam":[""],"potential_contacts":[{"name":"","title":"","reason":"","sourceUrl":"","linkedin":"","email":"","direct_phone":"","company_phone":"","contact_page":"","confidence":"High|Medium|Low","sources_used":[{"name":"","url":""}]}],"potentialContacts":[{"name":"","title":"","reason":"","sourceUrl":"","linkedin":"","email":"","directPhone":"","companyPhone":"","contactPage":"","confidence":"High|Medium|Low","sourcesUsed":[{"name":"","url":""}]}],"why_these_contacts":"","whyTheseContacts":"","promo_categories":[""],"likelyProducts":[""],"suggested_opener":"","suggestedOpener":"","actionability_score":0,"budget_score":0,"deadline_score":0,"why_now_score":0,"confidence":0,"sourceName":"","sourceUrl":"","sources":[{"name":"","url":""}],"publicationDate":""}]}.

Confidence must be 0-100. Return nothing only for clear duplicates, spam, unverifiable items, or signals with no meaningful sales relevance.`;
  const body = {
    model,
    input: prompt,
    tools: [{ type: process.env.OPENAI_WEB_SEARCH_TOOL || 'web_search_preview' }],
    max_output_tokens: 9000
  };
  const resp = await fetchWithTimeout('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, timeoutMs);
  if (!resp.ok) throw new Error(await resp.text().catch(() => `OpenAI web search error ${resp.status}`));
  const data = await resp.json();
  return { text: responseOutputText(data), usage: openaiUsageFromResponse(data) };
}


function buildBusinessContext(raw = {}, type = '', summary = '', accountName = '') {
  const explicit = compact(raw.businessContext || raw.companyContext || raw.strategicContext || raw.whyItHappened || raw.growthDriver || raw.businessDriver || '', 260);
  if (explicit) return explicit;

  const text = clean(`${raw.whatChanged || ''} ${raw.signalTitle || ''} ${raw.title || ''} ${raw.summary || ''} ${raw.signalDetail || ''} ${raw.whyItMattersForPromo || ''}`).toLowerCase();
  const company = accountName || 'The company';

  if (/new facility|facility opening|opens? (a )?new|distribution center|warehouse|plant|manufacturing site/.test(text)) {
    return `${company} appears to be expanding physical operations through a new facility or location, which can create onboarding, apparel, signage, and internal communication needs.`;
  }
  if (/contract|customer win|awarded|selected by|major deal|agreement/.test(text)) {
    return `${company} appears to be supporting new customer or contract demand, which can lead to hiring, production ramp-up, and customer-facing brand needs.`;
  }
  if (/funding|investment|raised|series [abc]|capital|private equity/.test(text)) {
    return `${company} appears to have new capital available for growth, which may support hiring, marketing, onboarding, or expansion initiatives.`;
  }
  if (/acquisition|acquired|merger|integrat/.test(text)) {
    return `${company} appears to be going through a business change that may require internal alignment, employee communication, and brand consistency.`;
  }
  if (/launch|new product|unveils|introduces|rollout/.test(text)) {
    return `${company} appears to be bringing a new product or initiative to market, creating a timely reason to ask about launch support and brand visibility.`;
  }
  if (/seasonal|temporary|peak season|holiday ramp/.test(text)) {
    return `${company} appears to be preparing for a seasonal ramp, which can create short-term needs around recruiting, onboarding, uniforms, and recognition.`;
  }
  if (/second shift|third shift|production capacity|capacity|ramp up|increased demand/.test(text)) {
    return `${company} appears to be increasing production capacity, which can create timely needs around team apparel, safety programs, and employee engagement.`;
  }
  if (/hiring|jobs|careers|recruit|open position|now hiring|headcount/.test(text) || /hiring/i.test(type)) {
    return `The company is actively hiring, although the specific business initiative driving the hiring could not be determined from public information.`;
  }
  if (/event|conference|expo|trade show|summit|open house/.test(text)) {
    return `${company} appears to be preparing for a public event or industry presence, which can create needs around booth materials, attendee gifts, apparel, and follow-up campaigns.`;
  }
  if (/award|recognition|honor|winner|best of|milestone|anniversary/.test(text)) {
    return `${company} has a recognition or milestone moment that can create a natural conversation around employee appreciation, customer gifts, or branded celebration items.`;
  }
  if (/leadership|appoint|promot|named|joins as|new ceo|president|vp|director/.test(text)) {
    return `${company} appears to have leadership changes that may signal new priorities, team-building needs, or upcoming internal communication initiatives.`;
  }
  return compact(summary || 'Recent public business activity creates a timely reason to learn what is changing inside the company.', 240);
}

function contextToPromoWhy(context = '', type = '', ground = {}) {
  const c = clean(context);
  const accountName = clean(ground.accountName || '');
  if (!c) return accountName ? `Recent public activity from ${accountName} creates a timely reason to start a conversation.` : 'Recent public business activity creates a timely reason to start a conversation.';
  if (/specific growth driver is not yet clear/i.test(c)) return 'Hiring creates a practical reason to ask who owns onboarding, recruiting, and employee engagement support.';
  return compact(`${c} That creates a practical reason to ask about onboarding, employee engagement, events, apparel, recognition, or brand support tied to the change.`, 280);
}

// Paid-beta grounded outreach (Priority 2): when there isn't enough factual
// context to name a specific reason to reach out, this is a transparent
// limited state -- it says plainly that the detail is thin -- rather than
// inventing urgency or implying a merch program that doesn't exist.
function honestLimitedOpener(accountName = '') {
  return accountName
    ? `We found public activity for ${accountName}, but not enough detail yet to point to one specific reason to reach out. Worth a quick check-in to see what's changing internally.`
    : "We found public activity for this account, but not enough detail yet to point to one specific reason to reach out. Worth a quick check-in to see what's changing internally.";
}

function contextToOpener(context = '', type = '', ground = {}) {
  const c = clean(context);
  const accountName = clean(ground.accountName || '');
  const who = accountName ? `${accountName} is` : "you're";
  // Seller-copy classification-drift correction: same rule as
  // canonicalTemplateFamily()'s own header comment -- this is the LAST-
  // resort fallback (only reached once salesReadyOpener() has already found
  // no canonical family support), so a specific claim here is gated the
  // same way, never re-derived from free text alone. The prior funding/
  // capital/investment/growth branch had no canonical-family counterpart
  // anywhere in this template family and is dropped rather than gated --
  // it falls to the honest, topic-neutral honestLimitedOpener() below
  // instead of asserting an ungated "recent growth news" claim.
  const family = canonicalTemplateFamily(type);
  if (family === 'hiring' || /specific growth driver is not yet clear/i.test(c)) {
    return `I noticed ${who} growing the team recently. Is anything changing internally that your team is planning around?`;
  }
  if (!c) return honestLimitedOpener(accountName);
  if (family === 'events') return `Saw ${accountName || 'the'} event activity and had a quick question — who handles branded materials or attendee follow-up?`;
  if (family === 'facility') return `Saw ${accountName ? `${accountName}'s` : 'the'} expansion activity and had a quick question — who supports team onboarding, apparel, or site launch needs?`;
  return honestLimitedOpener(accountName);
}

function buildConcreteTrigger(raw = {}, type = '', accountName = '') {
  const direct = compact(raw.concrete_trigger || raw.concreteTrigger || raw.buying_moment || raw.buyingMoment || raw.signalTitle || raw.title || raw.whatChanged || '', 150);
  if (direct && !/^(business activity|recent activity|expansion|hiring|community engagement|recognition)$/i.test(direct)) return direct;
  const text = clean(`${raw.signalTitle || ''} ${raw.whatChanged || ''} ${raw.summary || ''} ${raw.signalDetail || ''} ${raw.sourceName || ''}`).trim();
  if (text) return compact(text, 120);
  return `${accountName || 'Company'} ${type || 'Business Activity'}`;
}

// Seller-copy classification-drift correction: the ONE place free text may
// still influence WHICH specific seller-facing claim (facility expansion,
// hiring, award, launch, etc.) a template selects is gated out here.
// salesReadyWhy()/salesReadyOpener()/contextToOpener()/
// promoCategoriesForMoment()/inferRecommendedBuyingTeam() below select
// their SPECIFIC bucket ONLY via canonicalTemplateFamily() (now shared,
// imported from signal-intelligence.js -- api/research-account.js's own
// opportunityForSignal()/detectDepartment()/contactForSignal() consume the
// exact same function, so neither endpoint maintains an independent
// event-family classifier; see that function's own header comment for the
// full production root-cause writeup). Free text may still feed a
// topic-neutral generic fallback (contextToPromoWhy(), honestLimitedOpener())
// -- it must never manufacture a SPECIFIC claim the canonical
// classification does not itself support.

function inferBuyingMoment(raw = {}, type = '', trigger = '', context = '') {
  const explicit = compact(raw.buying_moment || raw.buyingMoment || raw.opportunityCategory || '', 90);
  if (explicit) return explicit;
  const t = clean(`${type} ${trigger} ${context}`).toLowerCase();
  if (/community|sponsor|festival|fundraiser|philanthropy|volunteer|csr/.test(t)) return 'Community / Sponsorship Event';
  if (/facility|new location|ribbon cutting|plant|warehouse|distribution center|headquarters/.test(t)) return 'Facility / Location Expansion';
  if (/trade show|exhibitor|booth|conference|expo|summit|open house|customer event|dealer meeting|webinar/.test(t)) return 'Event / Trade Show';
  if (/product launch|new product|rollout|unveil/.test(t)) return 'Product Launch';
  if (/rebrand|merger|acquisition|integrat/.test(t)) return 'Brand / Business Change';
  if (/contract|customer win|partnership|awarded|selected/.test(t)) return 'Contract / Partnership Win';
  if (/hiring|recruit|talent|employee experience|field marketing|event manager|onboarding/.test(t)) return 'Hiring / Team Growth';
  if (/award|recognition|anniversary|milestone|safety/.test(t)) return 'Recognition / Milestone';
  return normalizeSignalType(type || trigger || 'Business Activity');
}

function promoCategoriesForMoment(moment = '', type = '', context = '') {
  const family = canonicalTemplateFamily(type);
  if (family === 'community') return ['Event Giveaways','Volunteer Apparel','Banners','Community Gifts'];
  if (family === 'facility') return ['Employee Apparel','Onboarding Kits','Safety Items','Opening-Day Gifts'];
  if (family === 'events') return ['Event Kits','Booth Giveaways','Branded Apparel','Follow-Up Gifts'];
  if (family === 'hiring') return ['Onboarding Items','Recruiting Materials','Employee Apparel','Recognition Gifts'];
  if (family === 'launch') return ['Launch Kits','Customer Gifts','Event Giveaways','Branded Apparel'];
  if (family === 'award') return ['Recognition Gifts','Awards','Employee Apparel','Celebration Kits'];
  if (family === 'partnership') return ['Customer Appreciation','Sales Kits','Executive Gifts','Event Giveaways'];
  return ['Employee Apparel','Event Kits','Customer Appreciation','Recognition Gifts'];
}

// Grounds the "why this matters" text in the department the signal already
// points at and one real historical-order fact, when either is available --
// without inventing a merch program or claiming anything is already planned.
function groundedWhySuffix(ground = {}) {
  const dept = clean((ground.recommendedBuyingTeam || [])[0] || '');
  const historical = clean(ground.historicalFact || '');
  if (historical) return ` ${dept ? `${dept} ` : ''}may already be worth a note, since ${historical}.`;
  if (dept) return ` ${dept} is the most likely owner of a need like this.`;
  return '';
}

function salesReadyWhy(trigger = '', context = '', moment = '', type = '', ground = {}) {
  // product/commercial-opportunity-intelligence, QA correction round 2: a
  // confident purchase match for a recent-past event overrides the generic
  // topic-based templates below with an honest, specific one -- this is the
  // ONLY place this deterministic fallback ever claims we supplied
  // something, and only when a genuinely close uploaded purchase date
  // supports it (findLikelyRelatedPurchase() in signal-intelligence.js).
  if (ground.relatedPurchase?.confidence === 'confident' && ground.relatedPurchase.purchase?.category) {
    return `We supplied ${clean(ground.relatedPurchase.purchase.category)} for this -- worth asking how it went and finding out what's next.`;
  }
  const suffix = groundedWhySuffix(ground);
  const family = canonicalTemplateFamily(type);
  if (family === 'community') return `Community programs often need volunteer apparel, banners, giveaways, sponsor gifts, and simple branded items for attendees or partners.${suffix}`;
  if (family === 'facility') return `Facility launches usually create needs around employee apparel, onboarding materials, safety items, local PR giveaways, and opening-day gifts.${suffix}`;
  if (family === 'events') return `Events usually require booth giveaways, attendee gifts, team apparel, signage, and follow-up items that help the sales or marketing team stay memorable.${suffix}`;
  if (family === 'hiring') return `Hiring and onboarding create practical needs around recruiting materials, new-hire kits, employee apparel, and internal engagement.${suffix}`;
  if (family === 'launch') return `Launches often need sales samples, customer gifts, launch kits, event materials, and branded touchpoints for internal and external audiences.${suffix}`;
  if (family === 'award') return `Recognition moments create a natural reason to discuss employee gifts, awards, celebration kits, safety incentives, or customer-facing thank-you items.${suffix}`;
  if (family === 'partnership') return `Major wins can create needs around employee communication, customer appreciation, launch support, and brand visibility with new stakeholders.${suffix}`;
  return contextToPromoWhy(context, type, ground);
}

// Builds the opener's lead sentence with an accurate tense: "coming up" only
// for a genuinely future, confidently-dated event; "recently had" (past
// tense) for an event-like signal within the 45-day follow-up window;
// tense-neutral possessive for ongoing business-change signals (which use
// publication recency, not an event date) and for anything with no
// actionability info supplied at all.
function leadSentence(accountName = '', specific = '', actionability = {}) {
  if (!accountName) return `Saw ${specific}.`;
  if (actionability.status === 'upcoming') return `Saw ${accountName} has ${specific} coming up.`;
  if (actionability.status === 'recent-past') return `Saw ${accountName} recently had ${specific}.`;
  return `Saw ${accountName}'s ${specific}.`;
}

function salesReadyOpener(trigger = '', context = '', moment = '', type = '', ground = {}, activationIdeas = []) {
  const specific = compact(trigger || moment || '', 90);
  const accountName = clean(ground.accountName || '');
  if (!specific) return honestLimitedOpener(accountName);
  const lead = leadSentence(accountName, specific, ground.actionability || {});

  // product/commercial-opportunity-intelligence, QA correction round 2:
  // two evidence-backed overrides, both returning early before the
  // existing topic-based templates below. Upcoming event + real, specific
  // activation ideas -> a genuine permission-based concept offer using the
  // actual generated ideas, never invented ones. Recent-past event -> tier
  // B/C/D per the founder's historical-event correction: a confidently-
  // matched uploaded purchase gets a follow-up referencing what we actually
  // supplied; no confident match (or an ambiguous one) gets a neutral
  // posture that never claims prior fulfillment. Every other case (ongoing
  // signals, upcoming events with no strong ideas) is completely
  // unchanged.
  if (ground.actionability?.status === 'upcoming' && Array.isArray(activationIdeas) && activationIdeas.length) {
    const leadIdeas = activationIdeas.slice(0, 2).map(idea => clean(idea)).join(' and ');
    return `${lead} We had a couple ideas for this, including ${leadIdeas}. Would it be okay if I sent a few concepts over?`;
  }
  if (ground.actionability?.status === 'recent-past') {
    if (ground.relatedPurchase?.confidence === 'confident' && ground.relatedPurchase.purchase?.category) {
      return `Saw ${specific} wrapped up. We supplied ${clean(ground.relatedPurchase.purchase.category)} for it -- how did that go, and what's next on the calendar?`;
    }
    // Commercial Activation Reasoning sprint: a recent-past event with
    // nothing to follow up on (no confidently-matched prior purchase) but
    // real, specific activationIdeas is a fresh opportunity, not a
    // check-in on an old order -- e.g. a just-completed acquisition's
    // integration/welcome window (the founder's own Gallagher/Wilson M.
    // Beck example: "Saw Gallagher acquired Wilson M. Beck. We had a
    // couple ideas for a thoughtful welcome/integration piece..."). A
    // confident purchase match always wins over this (asking how a known
    // order went is more specific than a generic concept offer), which is
    // why this sits strictly after that check, never before it.
    if (ground.relatedPurchase?.confidence !== 'confident' && Array.isArray(activationIdeas) && activationIdeas.length) {
      const leadIdeas = activationIdeas.slice(0, 2).map(idea => clean(idea)).join(' and ');
      return `${lead} We had a couple ideas for this, including ${leadIdeas}. Would it be okay if I sent a few concepts over?`;
    }
    if (ground.relatedPurchase?.confidence === 'none') {
      return `Saw ${specific} wrapped up -- how did it go? Anything else like it coming up this season?`;
    }
    // 'ambiguous', or relatedPurchase not computed -- preserve uncertainty,
    // never guess at fulfillment either way.
    return `Saw ${specific} wrapped up -- how did it go? What's next on the calendar?`;
  }

  const dept = clean((ground.recommendedBuyingTeam || [])[0] || '');
  const deptAsk = dept ? ` Is ${dept} the right team to ask about that?` : '';
  const historicalNote = ground.historicalFact ? ` Since ${ground.historicalFact}, this seems worth a quick note.` : '';
  const family = canonicalTemplateFamily(type);
  if (family === 'community') return `${lead} Community events usually need volunteer apparel, banners, giveaways, and thank-you gifts.${historicalNote} Want me to send over a few ideas that could fit?${deptAsk}`;
  if (family === 'facility') return `${lead} For site launches, teams usually balance employee onboarding, local PR, safety gear, and opening-day gifts.${historicalNote} I had a few practical ideas around apparel and launch kits — worth sending over?${deptAsk}`;
  if (family === 'events') return `${lead} Events like that usually need booth giveaways, team apparel, attendee gifts, and follow-up items.${historicalNote} Want me to send over a few ideas?${deptAsk}`;
  if (family === 'hiring') return `${lead} When teams are growing, onboarding kits, recruiting materials, and employee apparel usually become timely.${historicalNote}${deptAsk || ' Is there someone I should ask about that?'}`;
  if (family === 'launch') return `${lead} Launches usually need internal hype, sales support, and customer-facing branded items.${historicalNote} I had a few simple launch-kit ideas — worth sending over?${deptAsk}`;
  if (family === 'award') return `${lead} Moments like that are a good chance to recognize employees or thank customers.${historicalNote} Would a few branded celebration or recognition ideas be useful?${deptAsk}`;
  if (family === 'partnership') return `${lead} Wins like that often create internal and customer-facing communication needs.${historicalNote} I had a few ideas around team apparel and thank-you kits — worth sending over?${deptAsk}`;
  return contextToOpener(context, type, ground);
}


function inferRecommendedBuyingTeam(type = '', context = '', summary = '', raw = {}) {
  const explicit = safeArray(raw.recommendedBuyingTeam || raw.buyingTeam || raw.likelyBuyingTeam || raw.likelyBuyers, 4);
  const family = canonicalTemplateFamily(type);
  let team = [];
  if (family === 'hiring') {
    team = ['HR / People', 'Talent Acquisition'];
  } else if (family === 'events' || family === 'community') {
    team = ['Marketing', family === 'community' ? 'Community Relations' : 'Events'];
  } else if (family === 'launch') {
    team = ['Marketing', 'Product Marketing'];
  } else if (family === 'facility') {
    team = ['Operations', 'HR / People'];
  } else if (family === 'award') {
    team = ['Marketing', 'HR / People'];
  } else if (family === 'partnership') {
    team = ['Marketing', 'Sales'];
  }
  for (const item of explicit) {
    if (!team.some(t => t.toLowerCase() === item.toLowerCase())) team.push(item);
  }
  if (!team.length) team = ['Marketing', 'HR / People'];
  return team.map(t => t.replace(/human resources/i, 'HR / People').replace(/people operations/i, 'HR / People')).filter(Boolean).slice(0, 3);
}

function normalizePotentialContacts(value, max = 2) {
  const items = Array.isArray(value) ? value : [];
  return items.map(c => {
    if (typeof c === 'string') {
      const parts = c.split(/\s+[-–—]\s+/);
      return { name: clean(parts[0]), title: clean(parts.slice(1).join(' — ')), reason: '', confidence: 'Low', sourcesUsed: [] };
    }
    const sourcesUsed = safeArray(c?.sourcesUsed || c?.sources_used || c?.sources, 4).map(src => ({
      name: clean(src?.name || src?.sourceName || src?.title || sourceDomain(src?.url || src?.sourceUrl || '')),
      url: clean(src?.url || src?.sourceUrl || '')
    })).filter(src => src.name || src.url);
    const linkedin = clean(c?.linkedin || c?.linkedIn || c?.linkedinUrl || c?.linkedin_profile || '');
    const email = clean(c?.email || c?.companyEmail || c?.publicEmail || c?.directEmail || '');
    const directPhone = clean(c?.directPhone || c?.direct_phone || c?.phone || '');
    const companyPhone = clean(c?.companyPhone || c?.company_phone || '');
    const contactPage = clean(c?.contactPage || c?.contact_page || '');
    const sourceUrl = clean(c?.sourceUrl || c?.url || linkedin || contactPage || '');
    if (sourceUrl && !sourcesUsed.some(src => src.url === sourceUrl)) {
      sourcesUsed.unshift({ name: clean(c?.sourceName || sourceDomain(sourceUrl) || 'Public source'), url: sourceUrl });
    }
    let confidence = clean(c?.confidence || c?.researchConfidence || c?.research_confidence || '');
    if (!/^(high|medium|low)$/i.test(confidence)) {
      confidence = clean(c?.name) && clean(c?.title) && (linkedin || email || sourceUrl) ? 'High'
        : clean(c?.name) && (clean(c?.title) || linkedin || sourceUrl) ? 'Medium' : 'Low';
    }
    confidence = confidence.charAt(0).toUpperCase() + confidence.slice(1).toLowerCase();
    return {
      name: clean(c?.name || c?.fullName || c?.person || ''),
      title: clean(c?.title || c?.role || c?.jobTitle || ''),
      reason: clean(c?.reason || c?.whyRelevant || c?.relevance || c?.why || ''),
      sourceUrl, linkedin, email, directPhone, companyPhone, contactPage, confidence, sourcesUsed
    };
  }).filter(c => c.name && !/unknown|n\/a|not available|team|department/i.test(c.name)).slice(0, max);
}

function contactText(contact = {}) {
  return clean(`${contact.name || ''} ${contact.title || ''} ${contact.role || ''} ${contact.email || ''} ${contact.linkedin || ''}`).toLowerCase();
}

function buyingTeamKeywords(team = []) {
  const text = clean(team.join(' ')).toLowerCase();
  const keywords = new Set();
  if (/hr|human resources|people|talent|recruit|onboard|employee/.test(text)) {
    ['hr','human resources','people','talent','recruit','recruiting','recruitment','onboarding','employee','culture','workforce'].forEach(k => keywords.add(k));
  }
  if (/marketing|brand|product marketing|event|events|community|relations|csr/.test(text)) {
    ['marketing','marketer','marcomm','communications','brand','branding','events','event','community','relations','csr','partnerships','sponsorship','product marketing'].forEach(k => keywords.add(k));
  }
  if (/operations|production|manufacturing|warehouse|facility|safety|distribution/.test(text)) {
    ['operations','operation','production','manufacturing','plant','facility','facilities','warehouse','distribution','safety','ehs','supply chain'].forEach(k => keywords.add(k));
  }
  if (/sales|business development|customer/.test(text)) {
    ['sales','business development','customer','account'].forEach(k => keywords.add(k));
  }
  return [...keywords];
}

function contactMatchesBuyingTeam(contact = {}, team = []) {
  const txt = contactText(contact);
  if (!txt) return false;
  const keywords = buyingTeamKeywords(team);
  return keywords.some(k => txt.includes(k));
}

function normalizeUploadedContacts(contacts = []) {
  const seen = new Set();
  return safeArray(contacts, 12).map(c => {
    if (typeof c === 'string') return { name: clean(c), title: '', department: '', email: '', phone: '', linkedin: '', source: 'From your uploaded account list' };
    return {
      name: clean(c?.name || c?.contactName || c?.fullName || ''),
      title: clean(c?.title || c?.role || c?.jobTitle || ''),
      department: clean(c?.department || c?.contactDepartment || ''),
      email: clean(c?.email || c?.contactEmail || ''),
      phone: clean(c?.phone || c?.contactPhone || c?.directPhone || ''),
      linkedin: clean(c?.linkedin || c?.linkedIn || c?.linkedinUrl || ''),
      reason: clean(c?.reason || ''),
      source: clean(c?.source || 'From your uploaded account list')
    };
  }).filter(c => c.name || c.email).filter(c => {
    const key = `${c.name}|${c.email}|${c.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectUploadedContactsForTeam(contacts = [], team = [], max = 2) {
  return normalizeUploadedContacts(contacts)
    .filter(c => contactMatchesBuyingTeam(c, team))
    .slice(0, max)
    .map(c => ({
      name: c.name || c.email,
      title: c.title,
      email: c.email,
      linkedin: c.linkedin,
      directPhone: c.phone,
      sourceType: 'uploaded',
      reason: c.reason || 'This uploaded contact aligns with the recommended buying team for this opportunity.',
      source: 'From your uploaded account list',
      sourcesUsed: [{ name: 'From your uploaded account list', url: '' }],
      confidence: c.title && (c.email || c.linkedin) ? 'High' : (c.title || c.email || c.linkedin ? 'Medium' : 'Low')
    }));
}

function mergePotentialContacts(uploaded = [], publicContacts = [], max = 2) {
  const out = [];
  const seen = new Set();
  for (const c of [...uploaded, ...publicContacts]) {
    if (!c || !c.name) continue;
    const key = `${c.name}|${c.email || ''}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

function buildWhyTheseContacts(contacts = [], team = [], type = '', context = '') {
  const explicit = contacts.map(c => c.reason).filter(Boolean).join(' ');
  if (explicit) return compact(explicit, 220);
  if (!contacts.length) return '';
  const c = clean(`${type} ${context} ${team.join(' ')}`).toLowerCase();
  if (/hiring|recruit|talent|onboarding|people|hr/.test(c)) return 'These roles appear closest to recruiting, onboarding, or employee engagement tied to this opportunity.';
  if (/event|conference|expo|community|csr|sponsor/.test(c)) return 'These roles appear closest to the event, community, or brand initiative behind this opportunity.';
  if (/product|launch|marketing|rebrand/.test(c)) return 'These roles appear closest to the marketing or launch initiative behind this opportunity.';
  if (/operations|facility|production|safety|warehouse/.test(c)) return 'These roles appear closest to the operational change creating the outreach opportunity.';
  return 'These contacts appear to be the most relevant public starting points for this opportunity.';
}


function buildSuggestedContact(potentialContacts = [], recommendedBuyingTeam = [], raw = {}) {
  const verified = potentialContacts[0];
  if (verified) {
    return {
      name: verified.name,
      title: verified.title || recommendedBuyingTeam[0] || '',
      whyThisContact: clean(verified.reason || raw.whyThisContact || raw.why_this_contact || 'This person appears aligned with the buying team most likely to own the detected initiative.'),
      linkedin: verified.linkedin || '',
      email: verified.email || '',
      directPhone: verified.directPhone || '',
      companyPhone: verified.companyPhone || '',
      contactPage: verified.contactPage || '',
      researchConfidence: verified.confidence || 'Medium',
      sourcesUsed: verified.sourcesUsed || [],
      sourceType: verified.sourceType || (String(verified.source || '').toLowerCase().includes('uploaded') ? 'uploaded' : 'public')
    };
  }
  return {
    name: '',
    title: recommendedBuyingTeam[0] || 'Relevant department lead',
    whyThisContact: clean(raw.whyThisContact || raw.why_this_contact || 'Start with the department most likely to own the detected initiative.'),
    linkedin: '', email: '', directPhone: '', companyPhone: '', contactPage: '',
    researchConfidence: 'Low',
    sourcesUsed: [],
    sourceType: 'department'
  };
}

function hasNegativeOrIrrelevantContext(text = '') {
  const t = clean(text).toLowerCase();
  return /layoff|laid off|downsizing|restructuring|bankruptcy|lawsuit|litigation|plant closure|closing plant|closure|investigation|recall|scandal|fraud|settlement|data breach|fined|penalty|strike|labor dispute/.test(t);
}

function isGenericSustainabilityOnly(text = '') {
  const t = clean(text).toLowerCase();
  return /sustainability|green|eco|environment|carbon|recycling|esg/.test(t) &&
    !/certification|certified|award|campaign|event|deadline|facility|initiative|volunteer|earth day|report launch|new program|partnership|donation|sponsor/.test(t);
}

function isWeakOldAward(raw = {}, text = '') {
  const t = clean(text).toLowerCase();
  if (!/award|recognition|honor|ranking|best places|top \d+|inc\.? 5000/.test(t)) return false;
  const fresh = freshnessScore(raw.publicationDate || raw.publishedDate || raw.date || '');
  return fresh < 35 && !/actively promoting|celebrat|anniversary|milestone|event|campaign|press release/.test(t);
}

// Global Business Trigger Intelligence sprint, founder correction round
// (silent signal-loss diagnostics): now returns the specific rule name that
// fired (a truthy string) or '' (falsy, unchanged call-site behavior) --
// existing `if (... && prospectKillRule(...))` callers are unaffected since
// both a boolean `true` and a non-empty string are truthy. This is what lets
// makeSignal() below stamp a concrete, loggable reason instead of a bare
// null, without adding a return-shape/schema change to makeSignal() itself.
function prospectKillRule(raw = {}, type = '', summary = '', businessContext = '') {
  const text = `${type} ${raw.signalType || ''} ${raw.signalTitle || ''} ${raw.title || ''} ${summary} ${businessContext} ${raw.whyItMattersForPromo || ''} ${raw.sourceName || ''} ${raw.sourceUrl || ''}`;
  if (hasNegativeOrIrrelevantContext(text)) return 'negative-or-irrelevant-context';
  if (isGenericSustainabilityOnly(text)) return 'generic-sustainability-only';
  if (isWeakOldAward(raw, text)) return 'weak-old-award';
  return '';
}

function abdScores(raw = {}, type = '', summary = '', businessContext = '') {
  const text = clean(`${type} ${raw.signalType || ''} ${raw.signalTitle || ''} ${raw.title || ''} ${summary} ${businessContext} ${raw.whyItMattersForPromo || ''}`).toLowerCase();
  let actionability = Number(raw.actionability_score || raw.actionabilityScore || 55);
  let budgetLikelihood = Number(raw.budget_score || raw.budgetScore || 50);
  let deadlineUrgency = Number(raw.deadline_score || raw.deadlineScore || raw.why_now_score || raw.whyNowScore || (freshnessScore(raw.publicationDate || raw.publishedDate || raw.date || raw.event_date || '') >= 80 ? 65 : 45));

  if (/new facility|facility opening|new location|plant|warehouse|distribution center|expansion|headquarters|ribbon cutting|rebrand|merger|acquisition|product launch|trade show|expo|conference|open house|customer event|anniversary|safety milestone|contract|customer win/.test(text)) actionability += 22;
  if (/hiring|recruit|onboarding|employee appreciation|recognition|event|trade show|facility|uniform|safety|sales kickoff|community event|sponsor|customer appreciation|holiday|booth|launch kit|opening-day/.test(text)) budgetLikelihood += 24;
  if (/upcoming|this month|this quarter|scheduled|opening|launching|event|conference|trade show|deadline|seasonal|hiring now|now hiring|new facility|ribbon cutting|event date/.test(text)) deadlineUrgency += 22;

  if (/generic sustainability|sustainability statement|mission statement|old award|vague community|general community/.test(text)) {
    actionability -= 18; budgetLikelihood -= 12; deadlineUrgency -= 12;
  }
  if (hasUnclearBusinessContext(businessContext)) {
    actionability -= 5; deadlineUrgency -= 4;
  }

  const clamp = n => Math.max(0, Math.min(100, Math.round(n)));
  return { actionability: clamp(actionability), budgetLikelihood: clamp(budgetLikelihood), deadlineUrgency: clamp(deadlineUrgency) };
}

function abdAdjustedConfidence(base = 0, raw = {}, type = '', summary = '', businessContext = '') {
  const abd = abdScores(raw, type, summary, businessContext);
  const abdTotal = Math.round((abd.actionability * 0.4) + (abd.budgetLikelihood * 0.35) + (abd.deadlineUrgency * 0.25));
  const blended = Math.round((Number(base || 0) * 0.62) + (abdTotal * 0.38));
  return { score: Math.max(0, Math.min(100, blended)), abd };
}

function currentPredictableTimingTheme(now = new Date()) {
  const month = now.getMonth() + 1;
  if ([1,2].includes(month)) return { trigger:'Predictable Timing: New Year Sales Kickoff / Annual Planning', context:'No major current public signal was found, but many companies use Q1 to plan sales kickoff, recruiting, recognition, and employee engagement programs.', opener:'I was thinking ahead to Q1 planning and sales kickoff needs. Are branded employee, customer, or event programs on your team’s radar right now?', categories:['Sales Kickoff Items','Employee Recognition','Recruiting Materials','Customer Gifts'], team:['Sales','Marketing','HR / People'] };
  if ([3,4].includes(month)) return { trigger:'Predictable Timing: Trade Show Season / Spring Events', context:'No major current public signal was found, but spring often brings trade shows, recruiting events, customer meetings, and community programs.', opener:'I was thinking ahead to spring events and customer-facing programs. Are there any trade shows, recruiting events, or community initiatives your team is preparing for?', categories:['Event Kits','Booth Giveaways','Employee Apparel','Customer Appreciation'], team:['Marketing','Events','Sales'] };
  if ([5,6].includes(month)) return { trigger:'Predictable Timing: Summer Intern Onboarding / Employee Engagement', context:'No major current public signal was found, but many companies plan summer onboarding, intern programs, employee appreciation, and recruiting activities around this period.', opener:'I was thinking about summer onboarding and employee engagement programs. Would a few simple ideas for interns, new hires, or team appreciation be useful?', categories:['Onboarding Items','Employee Apparel','Recognition Gifts','Recruiting Materials'], team:['HR / People','Talent Acquisition','Marketing'] };
  if ([7,8,9].includes(month)) return { trigger:'Predictable Timing: Employee Appreciation / Fall Planning', context:'No major current public signal was found, but this company may still have recurring promotional needs tied to employee engagement, recruiting, events, or customer appreciation.', opener:'I was thinking ahead to fall employee and customer programs and had a few timely ideas that may fit your team. Is this something you’re planning for now?', categories:['Employee Appreciation','Customer Appreciation','Event Kits','Branded Apparel'], team:['HR / People','Marketing','Events'] };
  return { trigger:'Predictable Timing: Holiday / Q4 Gifting', context:'No major current public signal was found, but Q4 is a common planning window for holiday gifting, customer appreciation, employee recognition, and year-end events.', opener:'I was thinking ahead to holiday gifting and year-end appreciation. Are customer gifts or employee recognition programs something your team is planning now?', categories:['Holiday Gifts','Customer Appreciation','Employee Recognition','Executive Gifts'], team:['Marketing','Sales','HR / People'] };
}

function makePredictableTimingSignal(account = {}) {
  const theme = currentPredictableTimingTheme();
  const accountName = clean(account.name || account.accountName || 'Target Account');
  const recommendedBuyingTeam = theme.team;
  const potentialContacts = selectUploadedContactsForTeam(account.contacts || [], recommendedBuyingTeam, 2);
  return {
    accountName,
    isReal: false,
    isFallbackOpportunity: true,
    signalLayerType: 'Predictable Timing',
    type: 'Predictable Timing',
    signalType: 'Predictable Timing',
    opportunityType: 'PREDICTABLE_TIMING',
    title: theme.trigger,
    signalTitle: theme.trigger,
    signalDetail: theme.trigger,
    shortSummary: theme.trigger,
    signalSnippet: theme.trigger,
    whatChanged: theme.trigger,
    businessContext: theme.context,
    companyContext: theme.context,
    evidence: 'Predictable promo buying cycle based on seasonal timing; no major live public signal found.',
    sourceUrl: '',
    sourceType: 'Predictable Timing',
    sourceAuthority: 'Predictable Timing',
    cleanSourceName: 'Predictable Timing',
    sources: [],
    publishedDate: '',
    dateFound: new Date().toISOString(),
    detectedAt: new Date().toISOString(),
    confidence: 0.52,
    confidenceScore: 52,
    confidenceLevel: 'Low',
    priority: 'Low',
    abdScores: { actionability: 55, budgetLikelihood: 66, deadlineUrgency: 45 },
    reasonToReachOut: 'Many companies plan branded merchandise around seasonal employee, customer, and event programs even when there is no public announcement.',
    whyNow: 'Many companies plan branded merchandise around seasonal employee, customer, and event programs even when there is no public announcement.',
    whyItMattersForPromo: 'Many companies plan branded merchandise around seasonal employee, customer, and event programs even when there is no public announcement.',
    conversationStarter: theme.opener,
    suggestedOpener: theme.opener,
    recommendedBuyingTeam,
    recommended_buying_team: recommendedBuyingTeam,
    buyingTeam: recommendedBuyingTeam,
    potentialContacts,
    potential_contacts: potentialContacts,
    suggestedContactDetails,
    suggested_contact_details: suggestedContactDetails,
    uploadedContacts: normalizeUploadedContacts(account.contacts || []),
    whyTheseContacts: potentialContacts.length ? buildWhyTheseContacts(potentialContacts, recommendedBuyingTeam, 'Predictable Timing', theme.context) : '',
    suggestedContact: potentialContacts[0]?.name || recommendedBuyingTeam[0],
    likelyBuyers: recommendedBuyingTeam,
    affectedDepartment: recommendedBuyingTeam[0],
    likelyConversations: ['Seasonal program planning', 'Employee or customer appreciation', 'Upcoming events'],
    likelyProducts: theme.categories,
    commonPromoCategories: theme.categories,
    opportunityCategory: theme.trigger,
    opportunityExplanation: 'Predictable seasonal timing creates a lower-priority but still useful reason to start a planning conversation.',
    valueSource: 'Predictable Timing',
    aiQualified: true,
    source: 'predictable-timing'
  };
}

function hasUnclearBusinessContext(context = '') {
  return /specific business initiative driving|specific growth driver|not yet clear|could not be determined|unclear/i.test(clean(context));
}

function hasMeaningfulSignal(raw = {}, type = '', summary = '', businessContext = '') {
  const text = clean(`${type} ${raw.signalType || ''} ${raw.signalTitle || ''} ${raw.title || ''} ${summary} ${businessContext} ${raw.whyItMattersForPromo || ''} ${raw.sourceUrl || ''}`).toLowerCase();
  if (isJunkText(text)) return false;
  return /hiring|jobs|careers|recruit|open position|now hiring|expansion|facility|new office|new location|warehouse|plant|funding|investment|acquisition|merger|contract|customer win|partnership|event|conference|expo|trade show|summit|award|recognition|milestone|anniversary|leadership|appoint|promot|launch|new product|rebrand|community|charity|sponsor|sustainability|safety|employee engagement/.test(text);
}

function leadershipVerificationAdjustment(raw = {}, type = '', summary = '', businessContext = '', sourceUrl = '') {
  if (!/leadership|appoint|promot|named|joins as|new executive|new ceo|new president|new vice president/i.test(`${type} ${raw.signalType || ''} ${raw.signalTitle || ''} ${summary} ${businessContext}`)) return 0;
  const text = clean(`${raw.signalTitle || ''} ${raw.title || ''} ${summary} ${businessContext}`);
  const hasNamedPerson = /[A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3}/.test(text) || !!clean(raw.personName || raw.contactName || raw.executiveName || '');
  const hasRelevantTitle = /(ceo|chief|president|vice president|vp|director|head of|general manager|executive)/i.test(text);
  const hasDate = !!clean(raw.publicationDate || raw.publishedDate || raw.date || raw.event_date || '');
  const hasCredibleSource = !!sourceUrl || (Array.isArray(raw.sources) && raw.sources.some(s => clean(s?.url || s?.sourceUrl || '')));
  let adjustment = 0;
  if (!hasNamedPerson) adjustment -= 10;
  if (!hasRelevantTitle) adjustment -= 8;
  if (!hasDate) adjustment -= 5;
  if (!hasCredibleSource) adjustment -= 12;
  return adjustment;
}

function confidenceWithContextFloor(confidencePct = 0, raw = {}, type = '', summary = '', businessContext = '') {
  let score = Number(confidencePct || 0);
  if (hasUnclearBusinessContext(businessContext)) score = Math.max(55, score - 8);
  if (hasMeaningfulSignal(raw, type, summary, businessContext)) score = Math.max(score, hasUnclearBusinessContext(businessContext) ? 58 : 64);
  return Math.round(Math.max(0, Math.min(100, score)));
}

// Phase 2A / B3 — replaces the old normalizeSignalTypeFromEvidence(), which
// computed a content-derived classification via its own regex rules but only
// applied the correction when the AI's declared type was one of two generic
// fallback labels ('Business Activity' or a mismatched 'Hiring') — for any
// other specific-but-wrong declared label (the exact shape of the frozen
// Phase 1B mismatches on ranks 5, 8, 11, 14, 17) it silently discarded its
// own correctly-computed answer and returned the AI's original label
// unchanged. resolveCanonicalEventType() never consults the AI's declared
// type at all: it computes signal-intelligence.js's resolveEventType() (the
// same canonical, ALL_CAPS taxonomy) on the same evidence text, and that is
// the only classification used from here on for this signal's display
// label, carried via canonicalEventType on the returned object.
//
// Foundation-freeze correction: canonicalEventType does NOT drive the
// persisted event_fingerprint -- the Fingerprint Stability sprint removed
// it from the v2 identity key entirely (proven unstable across reruns; see
// resolveOpportunityEvents()'s "canonicalEventType is deliberately EXCLUDED"
// comment in signal-intelligence.js). canonicalEventType still feeds event
// CATEGORIZATION (signalEventCategory()'s event-like/ongoing split, which
// computeActionability() branches on) and the display label, both of which
// this same evidence text drives deterministically -- but it is not part of
// event identity/deduplication.
function resolveCanonicalEventType(raw = {}) {
  const text = clean(`${raw.concrete_trigger || raw.concreteTrigger || ''} ${raw.buying_moment || raw.buyingMoment || ''} ${raw.signalTitle || raw.title || ''} ${raw.whatChanged || raw.summary || raw.signalDetail || ''} ${raw.business_context || raw.businessContext || ''}`);
  const family = classifySignalFamily(text);
  const { primaryType } = resolveEventType(text, family);
  return { eventType: primaryType, label: displayLabelForEventType(primaryType) };
}

// Paid-beta signal-date-truth (Priority 1): canonical types that describe a
// discrete, date-stamped occurrence -- something that either has a scheduled
// date or already happened on a specific day -- as opposed to an ongoing
// business state or trend that has no single event date to speak of.
// PRODUCT_LAUNCH is included because the review's "event-like" list names
// "launch event" specifically; the location-opening cluster
// (NEW_LOCATION_OPENING/LOCATION_REOPENING/RENOVATION_COMPLETION/
// LOCATION_EVENT_UNSPECIFIED) is included because those are exactly the
// "ribbon cutting" ceremony class. Everything else (hiring, facility
// expansion, rebrand, leadership change, acquisition, partnership, and any
// generic BUSINESS_ACTIVITY_* family) is treated as an ongoing business
// change and is never required to carry an event date.
const EVENT_LIKE_TYPES = new Set([
  'EVENT_TRADE_SHOW', 'EVENT_CONFERENCE', 'EVENT_AWARD', 'EVENT_COMMUNITY', 'PRODUCT_LAUNCH',
  'NEW_LOCATION_OPENING', 'LOCATION_REOPENING', 'RENOVATION_COMPLETION', 'LOCATION_EVENT_UNSPECIFIED'
]);

function signalEventCategory(canonicalEventType = '') {
  return EVENT_LIKE_TYPES.has(canonicalEventType) ? 'event-like' : 'ongoing';
}

// Resolves the signal's own event date -- distinct from publicationDate
// (the source article's date) and from discoveredAt/dateFound (when House
// Accounts' own pipeline first saw it) -- using the same extractEventDate()
// parser signal-intelligence.js's resolveEvents() already relies on, so a
// date is only ever assigned when the evidence text actually describes when
// the event happened or will happen. Publication date is never substituted.
function resolveSignalEventDate(raw = {}, concreteTrigger = '', title = '', businessContext = '', eventCategory = 'ongoing') {
  const directField = clean(raw.event_date || raw.eventDate || '');
  let result = extractEventDate(directField);
  if (result.dateConfidence === 'unknown') {
    // QA final round, item 2: search every legitimate factual field the raw
    // signal carries -- not just businessContext, which buildBusinessContext()
    // may have replaced with a generic templated sentence when the AI didn't
    // supply an explicit one -- so an explicit date embedded in whatChanged,
    // whyItMattersForPromo/whyItMatters, summary, signalDetail, or the
    // source's own title/evidence text is never lost.
    const wideText = clean([
      concreteTrigger, title, businessContext, directField,
      raw.whatChanged, raw.whyItMattersForPromo, raw.whyItMatters, raw.summary,
      raw.signalDetail, raw.details, raw.sourceTitle, raw.evidence
    ].filter(Boolean).join(' '));
    result = extractEventDate(wideText);
  }
  if (result.dateConfidence === 'unknown' && eventCategory === 'event-like') {
    // Trade show / conference / award names very commonly embed only a bare
    // year ("Natural Products Expo West 2023") with no month, so
    // extractEventDate() (which requires at least a month) never assigns a
    // date. This is a deliberately narrow, event-like-only fallback: a bare
    // year found in the signal's own title/trigger text (never in the wider
    // business-context prose, to avoid matching an unrelated nearby year) is
    // treated as an approximate mid-year date -- but ONLY when that year is
    // strictly in the past. A bare mention of the current (or a future)
    // year carries no real month information ("2026 Annual Golf
    // Tournament" could be any month of 2026, including one still ahead of
    // today), and guessing a mid-year date for it can wrongly push a
    // same-year event outside the 45-day follow-up window into "stale" --
    // exactly the regression this guard prevents. A definitively past year
    // has no such ambiguity: no month within it can still be upcoming.
    const yearMatch = clean(`${concreteTrigger} ${title}`).match(/\b(20[0-9]{2})\b/);
    if (yearMatch) {
      const year = Number(yearMatch[1]);
      if (year < new Date().getUTCFullYear()) {
        result = { eventDate: `${year}-06-15`, dateConfidence: 'approximate', year };
      }
    }
  }
  return result;
}

// Conservative paid-beta actionability rules (Priority 1, reconciliation
// items 1 and 2). Event-like signals require a confidently parsed event
// date to be treated as a current priority at all:
//   - future date            -> upcoming, fully actionable
//   - up to 45 days in the past -> still actionable, but as a follow-up,
//                                   and any generated copy must use past
//                                   tense (never "is hosting")
//   - more than 45 days past -> excluded from current priorities entirely
//   - date unknown            -> may still exist as a lower-confidence
//                                   research detail, but is never eligible
//                                   to be shown as a priority and must never
//                                   be labeled "upcoming"
// Ongoing business-change signals have no single event date to require, but
// they DO require a conservative recency ceiling on the source/publication
// date (reconciliation item 2) -- otherwise an old hiring/expansion/rebrand
// article can surface as if it were current:
//   - published within the last 180 days -> priority eligible
//   - published more than 180 days ago    -> research detail only
//   - no trustworthy publication date      -> research detail only
// discoveredAt/first_seen_at (when House Accounts' own pipeline found the
// signal) is never substituted for the source's own publication date here.
// In every branch, excludeFromPriorities is exactly !isPriorityEligible --
// a single flag downstream code can rely on to keep a signal out of
// priorities/"Newly Detected"/the weekly digest WITHOUT deleting it: the
// caller (makeSignal()) persists every non-null signal regardless of this
// flag, and only uses it to filter what's actionable.
const FOLLOW_UP_WINDOW_DAYS = 45;
const ONGOING_RECENCY_CEILING_DAYS = 180;

// Deliberately stricter than parseSignalDate() (which allows a bare-year
// fallback for event-date extraction from free text): a publication
// timestamp is only "trustworthy" here when it carries at least a real
// month/day, not just a bare 4-digit year, since a bare year gives no way
// to tell a signal published 179 days ago from one published 900 days ago.
function parseTrustworthyPublicationDate(dateText = '') {
  const t = clean(dateText);
  if (!t || /^20\d{2}$/.test(t)) return null;
  const d = new Date(t);
  return isNaN(d.getTime()) ? null : d;
}

// QA round 2, item 5: label text is the single canonical source for the 5
// honest, user-facing actionability states -- Upcoming / Recent event /
// Ongoing business change / Date unavailable / No longer current. The
// dashboard's signalDateAndActionabilityLine() appends the actual date onto
// this label rather than inventing separate wording.
function computeActionability({ eventCategory = 'ongoing', eventDate = null, dateConfidence = 'unknown', publicationDate = '', now = new Date() } = {}) {
  if (eventCategory === 'event-like') {
    if (eventDate && dateConfidence !== 'unknown') {
      const parsed = parseSignalDate(eventDate);
      if (parsed) {
        // Foundation freeze, Phase 1C: calendar-day difference, not a
        // calendar-date-vs-wall-clock-instant mixture -- see
        // calendarDaysBetween()'s header comment (signal-intelligence.js)
        // for why the previous `Math.round((parsed - now) / 86400000)` form
        // could misclassify a same-day exact event depending on time of day.
        const diffDays = calendarDaysBetween(parsed, now);
        // QA round 3, item 1: "Upcoming" requires an explicit (exact-
        // confidence) future date. An approximate/inferred one (e.g. a bare
        // "Month Year" mention, or the past-year-only bare-year fallback in
        // resolveSignalEventDate()) is not a strong enough basis to assert
        // something is definitely still to come -- it falls through to
        // Date unavailable instead of a confident future claim.
        if (diffDays > 0) {
          if (dateConfidence === 'exact') {
            return { status: 'upcoming', tense: 'future', isPriorityEligible: true, excludeFromPriorities: false, usesPublicationDate: false, label: 'Upcoming' };
          }
        } else if (diffDays >= -FOLLOW_UP_WINDOW_DAYS) {
          return { status: 'recent-past', tense: 'past', isPriorityEligible: true, excludeFromPriorities: false, usesPublicationDate: false, label: 'Recent event' };
        } else {
          return { status: 'stale', tense: 'past', isPriorityEligible: false, excludeFromPriorities: true, usesPublicationDate: false, label: 'No longer current' };
        }
      }
    }
    // Undated Business Signal actionability correction: "Timing unclear" --
    // no date could be resolved at all -- is a different, less alarming
    // claim than "No longer current" (a real date IS known and it's simply
    // past the recency window, the 'stale' branch just above). Renamed so
    // this label never reads as a stale/historical claim it isn't; Priority
    // eligibility itself (isPriorityEligible: false) is unchanged -- a
    // freshly-discovered undated signal still never wins a Priority slot on
    // its own.
    return { status: 'unknown-date', tense: 'unknown', isPriorityEligible: false, excludeFromPriorities: true, usesPublicationDate: false, label: 'Timing unclear' };
  }
  const parsedPub = parseTrustworthyPublicationDate(publicationDate);
  if (!parsedPub) {
    return { status: 'ongoing-undated', tense: 'ongoing', isPriorityEligible: false, excludeFromPriorities: true, usesPublicationDate: true, label: 'Timing unclear' };
  }
  const ageDays = calendarDaysBetween(now, parsedPub);
  if (ageDays <= ONGOING_RECENCY_CEILING_DAYS) {
    return { status: 'ongoing', tense: 'ongoing', isPriorityEligible: true, excludeFromPriorities: false, usesPublicationDate: true, label: 'Ongoing business change' };
  }
  return { status: 'ongoing-stale', tense: 'ongoing', isPriorityEligible: false, excludeFromPriorities: true, usesPublicationDate: true, label: 'No longer current' };
}

// QA round 2, item 1: single canonical legacy-signal normalizer. A "legacy"
// signal is one persisted before actionabilityStatus/eventCategory existed
// (or with only a partial/untrustworthy version of them) -- most notably
// signals from before this whole signal-date-truth workstream, whose
// eventDate/event_date field may itself be the OLD bug's publication-date
// fallback rather than a real event date. This function is the ONLY place
// that re-derives actionability for such a signal; every reader (dashboard
// priorities feed, "Newly Detected", weekly digest eligibility, Prepare for
// Call) consumes its output rather than re-implementing any of this logic
// itself. It never mutates the stored row -- callers apply it to an
// in-memory copy at read time.
function hasTrustworthyActionabilityMetadata(payload = {}) {
  const status = payload.actionabilityStatus;
  return Boolean(
    status && typeof status === 'object' &&
    typeof status.status === 'string' && status.status &&
    typeof status.isPriorityEligible === 'boolean' &&
    payload.eventCategory
  );
}

// QA round 3, item 1: this is the single canonical read boundary every
// signal -- legacy, fresh, or partially normalized -- passes through before
// priority selection, "Newly Detected" counts, timeframe feeds, outreach
// tense, or digest eligibility ever see it. It NEVER trusts a stored
// canonicalEventType/eventCategory/actionabilityStatus directly; it always
// recomputes eventCategory and actionabilityStatus fresh from more
// primitive inputs (evidence text and, when present and not the old
// publication-date-fallback bug, the stored eventDate/eventDateConfidence).
// signalEventCategory()/computeActionability()/resolveCanonicalEventType()
// are pure functions of those inputs, so this is a genuine no-op for a
// signal that was already classified correctly, and a self-healing
// correction for one that wasn't (e.g. a classifier gap that has since been
// fixed, or any other internally inconsistent combination such as
// event-like content marked isPriorityEligible:true with no real date).
function classifyLegacySignalActionability(payload = {}) {
  const title = clean(payload.title || payload.signalTitle || '');
  const concreteTrigger = clean(payload.concreteTrigger || payload.concrete_trigger || '');
  const businessContext = clean(payload.businessContext || payload.companyContext || payload.signalDetail || payload.whatChanged || '');
  const canonicalEventType = resolveCanonicalEventType({
    concrete_trigger: concreteTrigger, signalTitle: title,
    whatChanged: businessContext, business_context: businessContext
  }).eventType;
  const eventCategory = signalEventCategory(canonicalEventType);
  // payload.publishedAt covers signals persisted through the weekly-scan
  // pipeline (resolveOpportunityEvents() in signal-intelligence.js), which
  // uses that field name instead of the dashboard path's publishedDate --
  // without it, every weekly-scan-sourced ongoing signal would be
  // misjudged as dateless regardless of its real, evidence-backed publish
  // date.
  const publicationDate = clean(payload.publicationDate || payload.publishedDate || payload.publishedAt || '');

  const storedEventField = payload.event_date || payload.eventDate || '';
  const storedConfidence = payload.eventDateConfidence || '';
  // A stored eventDate identical to the publication date is the fingerprint
  // of the old publication-date-fallback bug.
  const looksLikeOldBug = Boolean(storedEventField) && storedEventField === publicationDate;
  let eventDate = storedEventField;
  let dateConfidence = storedConfidence;
  let eventDateDisplay = clean(payload.eventDateDisplay || '');
  if (!dateConfidence) {
    // QA final round, item 2: pass the REAL payload as `raw` (not a minimal
    // { event_date } stub) so resolveSignalEventDate()'s widened field
    // search can actually reach whatChanged/whyItMattersForPromo/summary/
    // signalDetail/source evidence text on legacy rows too, not just
    // concreteTrigger/title/businessContext.
    const resolved = resolveSignalEventDate({ ...payload, event_date: looksLikeOldBug ? '' : eventDate }, concreteTrigger, title, businessContext, eventCategory);
    eventDate = resolved.eventDate || '';
    dateConfidence = resolved.dateConfidence;
    eventDateDisplay = resolved.displayEventDate || '';
  } else if (eventDate) {
    // R5 follow-up (Preview QA): "trust but verify" legacy reconciliation.
    // A stored eventDate with an already-set confidence is normally trusted
    // as-is, because re-parsing an already-resolved ISO date string would
    // risk silently upgrading a genuinely 'approximate' evidence-based date
    // to 'exact' merely because it is now ISO-formatted. But a stored value
    // can also be wrong in the opposite direction: exact-confidence, yet
    // actually the source's publication/listing date rather than the real
    // event date (confirmed production case: Avidia Bank's stored eventDate
    // was Eventbrite's June 22 listing date while the signal's own
    // description explicitly named June 23 as the ribbon-cutting date --
    // persisted by an earlier, pre-fix run of the SAME extractEventDate()
    // this file already trusts for fresh signals). This is the SAME defect
    // class the old looksLikeOldBug guard already detected via one narrow
    // signature (stored eventDate === publicationDate exactly) -- that
    // guard used to just discard the date to 'unknown' rather than recover
    // the real one; it's folded into this broader, evidence-based
    // reconciliation below so a recoverable explicit event date is used
    // instead of being thrown away.
    //
    // Re-run the corrected, publication-context-aware extractEventDate()
    // against the same grounded text every fresh signal is classified
    // from, and override the stored value ONLY when both:
    //   (a) the text names a different, explicit (non-publication-context)
    //       event date, AND
    //   (b) the stored value is independently explainable as a
    //       publication/listing date -- either it equals the signal's own
    //       publicationDate field, or the text itself states that exact
    //       date in publication-context language ("posted", "dated", etc).
    // A vague/ambiguous disagreement (no explicit differing date, or a
    // differing date with no evidence the STORED one was the wrong kind)
    // never overrides the stored value -- conservative and deterministic,
    // and never invents precision beyond what the text already states. If
    // reconciliation finds nothing better, the old looksLikeOldBug
    // signature alone is still enough to distrust an unrecoverable stored
    // date entirely, matching prior behavior.
    const wideText = clean([
      concreteTrigger, title, businessContext,
      payload.whatChanged, payload.whyItMattersForPromo, payload.whyItMatters, payload.summary,
      payload.signalDetail, payload.details, payload.sourceTitle, payload.evidence
    ].filter(Boolean).join(' '));
    const textDate = extractEventDate(wideText);
    const storedLooksLikePublicationDate = looksLikeOldBug || findPublicationContextDate(wideText) === eventDate;
    if (storedLooksLikePublicationDate && textDate.eventDate && textDate.dateConfidence === 'exact' && textDate.eventDate !== eventDate) {
      eventDate = textDate.eventDate;
      dateConfidence = 'exact';
      eventDateDisplay = textDate.displayEventDate || '';
    } else if (looksLikeOldBug) {
      eventDate = '';
      dateConfidence = 'unknown';
      eventDateDisplay = '';
    }
  }
  const actionabilityStatus = computeActionability({ eventCategory, eventDate, dateConfidence, publicationDate });
  const result = {
    eventCategory,
    actionabilityStatus,
    eventDate: eventDate || '',
    eventDateDisplay: eventDateDisplay || '',
    eventDateConfidence: dateConfidence,
    isUpcoming: actionabilityStatus.status === 'upcoming',
    // QA final round, item 1: re-derive the SPECIFIC classification (e.g.
    // RENOVATION_COMPLETION vs ACQUISITION) from the evidence text every time
    // a legacy/already-persisted row is read, not just the coarse event-like
    // vs ongoing bucket -- otherwise a classification-regex fix (like the
    // acquisition-language tightening in resolveEventType()) never reaches
    // rows persisted before the fix shipped.
    canonicalEventType,
    opportunityType: canonicalEventType
  };
  // Final bounded Beta trust correction: a row with NO canonicalEventType
  // at all on the raw stored payload never went through canonical
  // classification at persist time (confirmed production case: rows
  // persisted by api/research-account.js before this round, whose
  // opportunityForSignal()/detectDepartment()/contactForSignal() computed
  // their own independent seller copy with no canonicalEventType field at
  // all). Its accompanying seller-facing fields (reasonToReachOut/whyNow/
  // opportunityExplanation/opportunityCategory/affectedDepartment/
  // suggestedContact/suggestedProducts/conversationStarter) cannot be
  // trusted to agree with the freshly-resolved canonicalEventType just
  // computed above, so they are regenerated here -- via the SAME shared,
  // canonicalTemplateFamily()-gated table api/research-account.js's fixed
  // helpers now use -- rather than left stale. Deliberately narrow: a row
  // that already carries a real canonicalEventType was persisted by an
  // already-fixed endpoint, so its own richer, grounded copy (real
  // department/historical-fact suffixes, a model's own credible
  // commercialPlay, etc.) is trusted as-is and never flattened to this
  // generic per-family fallback. No schema migration/backfill -- this is a
  // pure, bounded, read-time-only correction, applied once per hydration,
  // exactly like the canonicalEventType re-derivation above.
  if (!payload.canonicalEventType) {
    const family = canonicalTemplateFamily(displayLabelForEventType(canonicalEventType));
    const sellerCopy = sellerCopyForTemplateFamily(family);
    result.reasonToReachOut = sellerCopy.reasonToReachOut;
    result.whyNow = sellerCopy.whyNow;
    result.opportunityExplanation = sellerCopy.whyNow;
    result.opportunityCategory = sellerCopy.category;
    result.promoOpportunity = sellerCopy.name;
    result.affectedDepartment = sellerCopy.department;
    result.suggestedContact = sellerCopy.contact;
    result.conversationStarter = sellerCopy.conversationStarter;
    result.suggestedProducts = sellerCopy.products;
    // Final bounded Beta trust correction (Round C): recommendedBuyingTeam/
    // likelyBuyers are deterministic, family-derived fields (same
    // sellerCopy.department the affectedDepartment self-heal above already
    // trusts) -- but groundedDepartmentForOpportunity() (dashboard/
    // index.html, drives Prepare for Call's department grounding) checks
    // opp.recommendedBuyingTeam/opp.likelyBuyers BEFORE opp.affectedDepartment,
    // so leaving a stale, pre-Round-B array here (e.g. a Conference/Summit
    // row's team frozen as ["HR / People"] by the old independent
    // classifier) would keep overriding the now-correctly-healed
    // affectedDepartment and reproduce the exact conflicting-interpretation
    // defect this correction targets (confirmed production case: Cianbro's
    // Maine CTE Business Summit signal showing an Events-oriented headline
    // everywhere except a stale "HR / Employee Onboarding" buying team).
    result.recommendedBuyingTeam = [sellerCopy.department];
    result.likelyBuyers = [sellerCopy.department];
  }
  // Final bounded Beta trust correction (Round C): identityConfidence is
  // stamped ONLY at persist time (verifyCandidateCompanyGrounding(), run
  // once by research-batch.js/research-account.js) and, unlike
  // canonicalEventType above, was never re-verified at read time -- so a row
  // persisted under an OLDER, looser version of that grounding logic (e.g.
  // the pre-local-clause-tightening isStandaloneSingleTokenMention(), which
  // promoted a bare roster/breadcrumb single-token mention to 'unconfirmed'
  // with no same-sentence claim required) keeps rendering as an actionable
  // Business Signal forever, even after the grounding rule that produced it
  // is fixed (confirmed production case: a Cianbro "ABC Convention > Past
  // Events > ... > Schedule" roster listing, persisted 'unconfirmed' by the
  // pre-fix rule, still opening Prepare for Call and Use This Signal).
  // Re-verifies ONLY when doing so cannot manufacture a false regression:
  //   - undefined/'unconfirmed' only -- 'confirmed' and 'rejected' are left
  //     untouched. A stored 'confirmed' grade may depend on the account's
  //     own website/location (verifyCandidateCompanyGrounding()'s domain/
  //     location corroborators), neither of which is available here (this
  //     function receives only the signal payload, never the account
  //     record) -- recomputing without that context could wrongly demote a
  //     legitimately confirmed signal. This is not a real gap for
  //     'unconfirmed' rows specifically: if domain/location corroboration
  //     had applied, the row would already have been stored 'confirmed' at
  //     persist time (that computation DID have full account context), so a
  //     currently-'unconfirmed' row is proof those paths already found
  //     nothing -- recomputing without them cannot introduce a new false
  //     negative, only correctly re-apply an improved entity-match/
  //     single-token-fallback rule.
  //   - only when enough raw evidence survives to recompute at all
  //     (sourceUrl + companyName + some title/snippet text) -- a row with
  //     genuinely nothing to re-verify from is left exactly as stored,
  //     preserving the deliberate "undefined stays undefined, a true
  //     legacy row, grandfathered" behavior get-dashboard.js's
  //     signalToOpportunity() already documents.
  //   - only DOWNGRADES are applied (recompute grade !== stored grade).
  //     verifyCandidateCompanyGrounding() called with just {name} (no
  //     location/website) can never grant MORE trust than the original,
  //     fully-contexted computation already did, so any discrepancy here is
  //     a correction the original computation would have made too, not a
  //     new false positive.
  const companyName = clean(payload.companyName || payload.accountName || '');
  const evidenceUrl = clean(payload.sourceUrl || payload.source_url || '');
  const evidenceTitle = clean(payload.rawTitle || title || payload.headline || '');
  const evidenceSnippet = clean(payload.rawSnippet || businessContext || '');
  if ((payload.identityConfidence === undefined || payload.identityConfidence === 'unconfirmed')
    && companyName && evidenceUrl && (evidenceTitle || evidenceSnippet)) {
    const regrounded = verifyCandidateCompanyGrounding({ title: evidenceTitle, snippet: evidenceSnippet, url: evidenceUrl }, { name: companyName });
    if (regrounded.identityConfidence && regrounded.identityConfidence !== payload.identityConfidence) {
      result.identityConfidence = regrounded.identityConfidence;
    }
  }
  return result;
}

// product/commercial-opportunity-intelligence: commercialPlayNarrative is
// the model's ONE commercial-interpretation thought (see
// normalizeCommercialIntelligence() in signal-intelligence.js) and is now
// the preferred source for this legacy compatibility field. The model is no
// longer asked to separately produce why_this_matters/whyItMattersForPromo
// as an independent target -- that would be two independent paraphrases of
// the same idea. The raw.why_this_matters/etc. reads below remain only as a
// fallback for older raw payloads (existing tests, any not-yet-updated
// caller) that still populate them directly; new prompt output never sets
// them. When neither is present, the existing deterministic salesReadyWhy()
// template still runs unchanged -- this legacy field is never left empty
// merely because the model declined to produce a commercial play.
function meaningfulWhyThisMatters(raw = {}, type = '', trigger = '', context = '', buyingMoment = '', ground = {}, commercialPlayNarrative = '') {
  const supplied = compact(commercialPlayNarrative || raw.why_this_matters || raw.whyItMattersForPromo || raw.whyReachOut || raw.whyItMatters || raw.why || '', 300);
  const norm = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const repeated = supplied && [trigger, context, raw.signalTitle, raw.title].some(v => norm(v) && (norm(supplied) === norm(v) || norm(supplied).includes(norm(v)) && norm(supplied).length <= norm(v).length + 12));
  return supplied && !repeated ? supplied : compact(salesReadyWhy(trigger, context, buyingMoment, type, ground), 300);
}

// Paid-beta grounded outreach (Priority 2): one real, specific historical
// order fact for this account, when the upload actually has one -- never
// invented. Consumed by the opener/why fallback templates so they can
// reference real order history instead of staying generic.
function oneHistoricalOrderFact(account = {}) {
  const orderCount = Number(account.orderCount || 0);
  const categories = Array.isArray(account.categories) ? account.categories.filter(Boolean) : [];
  if (categories.length && orderCount) {
    return `you've ordered ${categories[0]} for them before (${orderCount} order${orderCount === 1 ? '' : 's'} on file)`;
  }
  if (categories.length) return `you've ordered ${categories[0]} for them before`;
  if (orderCount) return `you have ${orderCount} order${orderCount === 1 ? '' : 's'} on file with them`;
  return '';
}

// Global Business Trigger Intelligence sprint, founder correction round
// (silent signal-loss diagnostics): every `return null` below now first
// stamps `raw.__rejectionReason` with a concise, machine-readable class
// before discarding -- `raw` is the SAME object reference the caller
// (madeSignalsRaw's map(), api/research-batch.js) already holds, so the
// caller can log a real reason instead of a bare null. Reproduced
// production case this closes: IDEXX Laboratories and Stonyfield Organic
// each had a real raw model signal (rawSignals: 1) that silently became
// mappedSignals: 0 with zero trace in the logs of which of this function's
// three discard points fired, or why -- undiagnosable without a full
// Vercel log archaeology exercise. This is diagnostic hardening only: no
// discard CONDITION below changed, only that it is now explained.
function makeSignal(raw = {}, account = {}, options = {}) {
  const accountName = clean(raw.accountName || raw.account || raw.company || raw.company_name || raw.companyName || '');
  if (!accountName) { raw.__rejectionReason = 'missing-account-name'; return null; }
  const sourceUrl = clean(raw.sourceUrl || raw.url || raw.sources?.[0]?.url || '');
  const rawConfidencePct = adjustedConfidence(raw, sourceUrl, raw.sourceType || raw.sourceName || '');
  // Phase 2A / B3: the canonical classification is computed once, here, from
  // the evidence text alone. raw.signal_type/raw.signalType/raw.opportunityType
  // (whatever the AI itself declared) are never consulted for this — an
  // independent AI-declared classification can no longer override it.
  const canonicalType = resolveCanonicalEventType(raw);
  const type = canonicalType.label;
  const concreteTrigger = buildConcreteTrigger(raw, type, accountName);
  const buyingMoment = inferBuyingMoment(raw, type, concreteTrigger, raw.business_context || raw.businessContext || '');
  const title = compact(concreteTrigger || raw.signalTitle || raw.headline || raw.title || `${accountName} business activity`, 150);
  const summary = compact(raw.whatChanged || raw.shortSummary || raw.summary || raw.signalDetail || raw.details || title, 240);
  const businessContext = buildBusinessContext(raw, type, summary, accountName);
  if (options.enableProspectQuality) {
    const killReason = prospectKillRule(raw, type, summary, businessContext);
    if (killReason) { raw.__rejectionReason = `prospect-kill-rule:${killReason}`; return null; }
  }
  const floorConfidencePct = confidenceWithContextFloor(rawConfidencePct, raw, type, summary, businessContext);
  const abd = options.enableProspectQuality ? abdAdjustedConfidence(floorConfidencePct, raw, type, summary, businessContext) : { score: floorConfidencePct, abd: null };
  const leadershipAdjustment = leadershipVerificationAdjustment(raw, type, summary, businessContext, sourceUrl);
  const confidencePct = Math.max(0, Math.min(100, abd.score + leadershipAdjustment));
  if (confidencePct < 55 && !hasMeaningfulSignal(raw, type, summary, businessContext)) { raw.__rejectionReason = `low-confidence:${confidencePct}`; return null; } // discard only junk, duplicates, or truly low-confidence signals.

  // Paid-beta signal-date truth (Priority 1). eventDate is resolved ONLY from
  // parseable evidence text (via extractEventDate()) -- it never falls back
  // to the source's publication date merely because the true event date is
  // absent, and publicationDate/discoveredAt stay separate fields throughout.
  const eventCategory = signalEventCategory(canonicalType.eventType);
  const { eventDate: resolvedEventDate, dateConfidence: eventDateConfidence, displayEventDate: resolvedEventDateDisplay } = resolveSignalEventDate(raw, concreteTrigger, title, businessContext, eventCategory);
  const publicationDate = clean(raw.publicationDate || raw.publishedDate || raw.date || '');
  const actionabilityStatus = computeActionability({ eventCategory, eventDate: resolvedEventDate, dateConfidence: eventDateConfidence, publicationDate });
  // Reconciliation item 1: a stale or undated event-like signal, or an
  // ongoing signal whose source is older than the recency ceiling (or has
  // no trustworthy publication date), is NOT discarded here. A valid,
  // sourced signal is never deleted solely because it's no longer
  // actionable -- it is still returned (and persisted) below, carrying
  // actionabilityStatus.excludeFromPriorities so the priorities feed,
  // "Newly Detected" counts, and the weekly digest can filter it out while
  // Research Details/account history keeps it visible, clearly labeled.
  // The unconditional discards above (missing account name, prospect kill
  // rule, low confidence with no meaningful signal) are unrelated to date
  // freshness and are unchanged.

  // Recommended department/contact role is computed before the opener/why
  // text below so both can reference it (Priority 2: grounded outreach).
  const recommendedBuyingTeam = inferRecommendedBuyingTeam(type, businessContext, `${summary} ${buyingMoment} ${concreteTrigger}`, raw);
  const historicalFact = oneHistoricalOrderFact(account);
  // product/commercial-opportunity-intelligence, QA correction round 2: a
  // narrow, bounded date-proximity check (NOT fuzzy text matching) against
  // this account's own uploaded purchases -- computed only for a genuinely
  // recent-past event, and used only to decide whether the DETERMINISTIC
  // fallback templates below may reference an actual supplied item. The
  // live model reasons about this directly from the same paired purchase
  // data in its own prompt context (see COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT).
  // QA correction round 4 (false-positive finding): eventContextText lets
  // findLikelyRelatedPurchase() require more than date proximity for its
  // 'confident' tier -- see that function's header comment.
  const relatedPurchase = actionabilityStatus.status === 'recent-past'
    ? findLikelyRelatedPurchase(account.purchases, resolvedEventDate, `${concreteTrigger} ${title}`)
    : null;
  const ground = { accountName, actionability: actionabilityStatus, recommendedBuyingTeam, historicalFact, relatedPurchase };

  // product/commercial-opportunity-intelligence: the one shared normalizer,
  // computed once here so both the legacy why-this-matters compatibility
  // value (below) and the new commercialPlay/activationIdeas/expansionPotential
  // fields (in the returned object) derive from the exact same parsed thought.
  const commercialIntelligence = normalizeCommercialIntelligence(raw);
  const why = meaningfulWhyThisMatters(raw, type, concreteTrigger, businessContext, buyingMoment, ground, commercialIntelligence.commercialPlay?.narrative || '');
  const opener = compact(raw.suggested_opener || raw.suggestedOpener || raw.conversationStarter || raw.likelyConversation || salesReadyOpener(concreteTrigger, businessContext, buyingMoment, type, ground, commercialIntelligence.activationIdeas), 280);
  const buyers = safeArray(raw.likelyBuyers || raw.suggestedContacts || raw.suggestedContact || raw.contactRole, 4);
  const products = safeArray(raw.promo_categories || raw.likelyProducts || raw.promoCategories || raw.commonPromoCategories || raw.likelyProductCategories || promoCategoriesForMoment(buyingMoment, type, businessContext), 6);
  const conversations = safeArray(raw.likelyConversations || raw.conversationThemes || raw.likelyConversation || raw.conversationAngle, 5);
  const uploadedContacts = selectUploadedContactsForTeam(account.contacts || raw.uploadedContacts || [], recommendedBuyingTeam, 2);
  const publicContacts = normalizePotentialContacts(raw.potential_contacts || raw.potentialContacts || raw.contacts || raw.recommendedContacts || raw.suggestedPeople, 2);
  const potentialContacts = mergePotentialContacts(uploadedContacts, publicContacts, 2);
  const suggestedContactDetails = buildSuggestedContact(potentialContacts, recommendedBuyingTeam, raw);
  const whyTheseContacts = compact(raw.whyTheseContacts || raw.contactRationale || buildWhyTheseContacts(potentialContacts, recommendedBuyingTeam, type, businessContext), 220);
  const sources = Array.isArray(raw.sources) ? raw.sources.map(s => ({ name: clean(s.name || s.sourceName || sourceDomain(s.url || '')), url: clean(s.url || s.sourceUrl || '') })).filter(s => s.url || s.name).slice(0, 4) : [];
  if (sourceUrl && !sources.some(s => s.url === sourceUrl)) sources.unshift({ name: clean(raw.sourceName || sourceDomain(sourceUrl) || 'Public source'), url: sourceUrl });
  return {
    accountName,
    isReal: true,
    signalLayerType: 'Business Activity Signal',
    type,
    signalType: type,
    signal_type: type,
    // Phase 2A / B3: canonicalEventType is the single source of truth carried
    // through to resolveOpportunityEvents()/resolveEvents() at persistence
    // time (api/signal-intelligence.js), which reuses it rather than
    // recomputing its own classification — this is what makes event_fingerprint
    // and signal_type/opportunityType guaranteed-consistent rather than
    // independently-derived. opportunityType is now a direct alias of the
    // canonical enum value, not a mechanical uppercasing of a display label.
    canonicalEventType: canonicalType.eventType,
    concreteTrigger,
    concrete_trigger: concreteTrigger,
    buyingMoment,
    buying_moment: buyingMoment,
    // Priority 1: eventDate is only ever set from resolveSignalEventDate()'s
    // parse of the actual evidence text -- never from publicationDate/date
    // merely because a true event date wasn't found. eventCategory and
    // actionabilityStatus (upcoming / recent-past / stale / unknown-date /
    // ongoing) are the fields the dashboard must consult before ever
    // printing "Upcoming" or excluding/downranking a signal.
    eventDate: resolvedEventDate || '',
    event_date: resolvedEventDate || '',
    // QA final round, item 2: preserves a human-readable date RANGE (e.g.
    // "September 18-20, 2026") when the source text named one -- eventDate
    // itself stays a single ISO anchor (the range's first day) for all
    // upcoming/recent/stale math, but the dashboard should render the full
    // range the source actually described, not just its first day.
    eventDateDisplay: resolvedEventDateDisplay || '',
    eventDateConfidence,
    eventCategory,
    actionabilityStatus,
    isUpcoming: actionabilityStatus.status === 'upcoming',
    location: clean(raw.location || raw.eventLocation || raw.cityState || ''),
    opportunityType: canonicalType.eventType,
    title,
    signalDetail: summary,
    shortSummary: summary,
    signalSnippet: summary,
    whatChanged: summary,
    businessContext,
    companyContext: businessContext,
    evidence: `${sources[0]?.name || sourceDomain(sourceUrl) || clean(raw.sourceName || 'public source')}: ${summary}`,
    sourceUrl: sourceUrl || sources[0]?.url || '',
    source_url: sourceUrl || sources[0]?.url || '',
    source_name: clean(raw.source_name || raw.sourceName || sourceDomain(sourceUrl) || sources[0]?.name || ''),
    sourceType: clean(raw.sourceType || raw.sourceName || sourceDomain(sourceUrl) || sources[0]?.name || 'Public source'),
    sourceAuthority: clean(raw.sourceType || raw.sourceName || sourceDomain(sourceUrl) || sources[0]?.name || 'Public source'),
    cleanSourceName: clean(raw.sourceName || sourceDomain(sourceUrl) || sources[0]?.name || ''),
    sources,
    publishedDate: publicationDate,
    publicationDate,
    dateFound: new Date().toISOString(),
    detectedAt: new Date().toISOString(),
    confidence: confidencePct / 100,
    confidenceScore: confidencePct,
    confidenceLevel: confidenceLabel(confidencePct),
    priority: confidencePct >= 80 ? 'High' : confidencePct >= 60 ? 'Medium' : 'Low',
    abdScores: abd.abd || undefined,
    actionability_score: abd.abd?.actionability,
    budget_score: abd.abd?.budgetLikelihood,
    deadline_score: abd.abd?.deadlineUrgency,
    why_now_score: confidencePct,
    reasonToReachOut: why,
    whyNow: why,
    whyItMattersForPromo: why,
    // product/commercial-opportunity-intelligence: the new commercial-
    // interpretation layer. commercialPlay may be null and activationIdeas
    // may be [] -- that is a valid, expected outcome for a signal with real
    // evidence but no credible commercial play, never treated as missing
    // data. See normalizeCommercialIntelligence() in signal-intelligence.js.
    commercialPlay: commercialIntelligence.commercialPlay,
    activationIdeas: commercialIntelligence.activationIdeas,
    expansionPotential: commercialIntelligence.expansionPotential,
    conversationStarter: opener,
    suggestedOpener: opener,
    recommendedBuyingTeam,
    recommended_buying_team: recommendedBuyingTeam,
    buyingTeam: recommendedBuyingTeam,
    potentialContacts,
    potential_contacts: potentialContacts,
    suggestedContactDetails,
    suggested_contact_details: suggestedContactDetails,
    uploadedContacts: normalizeUploadedContacts(account.contacts || []),
    whyTheseContacts,
    why_these_contacts: whyTheseContacts,
    suggestedContact: potentialContacts[0]?.name || recommendedBuyingTeam[0] || buyers[0] || clean(raw.suggestedContact || raw.contactRole || 'Relevant department lead'),
    likelyBuyers: recommendedBuyingTeam.length ? recommendedBuyingTeam : (buyers.length ? buyers : [clean(raw.suggestedContact || 'Relevant department lead')]),
    affectedDepartment: clean(raw.likelyDepartment || raw.department || recommendedBuyingTeam[0] || buyers[0] || ''),
    likelyConversations: conversations.length ? conversations : [compact(raw.likelyConversation || raw.conversationAngle || why, 90)].filter(Boolean),
    likelyProducts: products,
    promo_categories: products,
    commonPromoCategories: products,
    opportunityCategory: compact(raw.opportunityCategory || conversations[0] || type, 90),
    opportunityExplanation: compact(raw.whyItMattersForPromo || raw.whyItMatters || why, 280),
    valueSource: 'AI Opportunity Discovery',
    aiQualified: true,
    source: 'targeted-search-ai'
  };
}

function signalKeywordKey(text = '') {
  return clean(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w.length > 3 && !['company','business','activity','public','signal','recent','creates','reason','promo'].includes(w)).slice(0, 8).join(' ');
}

function isFallbackSignal(sig = {}) {
  return !!(sig.isFallbackOpportunity || /predictable timing/i.test(`${sig.signalType || ''} ${sig.signal_type || ''} ${sig.type || ''} ${sig.concreteTrigger || sig.concrete_trigger || ''}`));
}

function signalDateText(sig = {}) {
  return clean(sig.publishedDate || sig.publicationDate || sig.eventDate || sig.event_date || sig.date || sig.dateFound || '');
}

function opportunityTypeBoost(sig = {}) {
  const text = `${sig.signalType || sig.signal_type || sig.type || ''} ${sig.buyingMoment || sig.buying_moment || ''} ${sig.concreteTrigger || sig.concrete_trigger || ''} ${sig.title || ''}`.toLowerCase();
  if (/expansion|facility|opening|new location|ribbon cutting|distribution center/.test(text)) return 20;
  if (/product launch|launch|released|sparkpnt|new product/.test(text)) return 18;
  if (/trade show|conference|expo|event|sponsor|sponsorship/.test(text)) return 17;
  if (/contract|partnership|acquisition|funding|rebrand/.test(text)) return 15;
  if (/hiring|recruit|onboarding|headcount/.test(text)) return 12;
  if (/award|recognition|milestone|anniversary/.test(text)) return 9;
  return 0;
}

function specificityBoost(sig = {}) {
  const text = `${sig.concreteTrigger || sig.concrete_trigger || ''} ${sig.title || ''} ${sig.businessContext || sig.business_context || sig.whatChanged || ''}`.toLowerCase();
  let score = 0;
  if (/(20\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4])/.test(text)) score += 6;
  if (/facility|launch|opening|event|conference|contract|hiring|award|sponsor|trade show|product/.test(text)) score += 6;
  if ((sig.sourceUrl || sig.source_url || '').trim()) score += 4;
  if ((sig.sources || []).length > 1) score += 3;
  return score;
}

function bestSignalScore(sig = {}) {
  if (!sig) return -999999;
  if (isFallbackSignal(sig)) return -10000 + Number(sig.confidenceScore || 0);
  const confidence = Number(sig.confidenceScore || sig.why_now_score || 0);
  const fresh = freshnessScore(signalDateText(sig));
  const abd = sig.abdScores || {};
  const actionability = Number(sig.actionability_score || abd.actionability || 0);
  const budget = Number(sig.budget_score || abd.budgetLikelihood || 0);
  const deadline = Number(sig.deadline_score || abd.deadlineUrgency || 0);
  const abdBlend = [actionability, budget, deadline].filter(Boolean).reduce((a,b)=>a+b,0) / Math.max(1, [actionability, budget, deadline].filter(Boolean).length);
  return confidence + (fresh * 0.35) + (abdBlend * 0.15) + opportunityTypeBoost(sig) + specificityBoost(sig);
}

function compareBestSignals(a = {}, b = {}) {
  const af = isFallbackSignal(a) ? 1 : 0;
  const bf = isFallbackSignal(b) ? 1 : 0;
  if (af !== bf) return af - bf;
  const delta = bestSignalScore(b) - bestSignalScore(a);
  if (Math.abs(delta) > 0.001) return delta;
  return Number(b.confidenceScore || 0) - Number(a.confidenceScore || 0);
}

function dedupeSignals(signals = []) {
  const map = new Map();
  for (const sig of signals) {
    if (!sig || !sig.accountName) continue;
    const domain = sourceDomain(sig.sourceUrl || '');
    const topic = signalKeywordKey(`${sig.signalType || ''} ${sig.signalDetail || sig.title || ''}`);
    const key = `${sig.accountName.toLowerCase()}|${sig.signalType}|${topic || domain}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, sig);
      continue;
    }
    const mergedSources = [...(existing.sources || []), ...(sig.sources || [])];
    if (sig.sourceUrl && !mergedSources.some(s => s.url === sig.sourceUrl)) mergedSources.push({ name: sig.cleanSourceName || sourceDomain(sig.sourceUrl), url: sig.sourceUrl });
    const better = compareBestSignals(sig, existing) < 0 ? sig : existing;
    const mergedConfidence = Math.min(100, Math.max(Number(existing.confidenceScore || 0), Number(sig.confidenceScore || 0)) + (mergedSources.length > 1 ? 4 : 0));
    map.set(key, {
      ...better,
      sources: mergedSources.slice(0, 5),
      confidenceScore: mergedConfidence,
      confidenceLevel: confidenceLabel(mergedConfidence)
    });
  }
  return [...map.values()].sort(compareBestSignals);
}

// ---------------------------------------------------------------------------
// Sprint 1 (signal-to-account evidence grounding). Reproduced production
// failure: a Gallagher research request returned an opportunity whose
// underlying evidence was actually about Avidia Bank. Root cause was two
// independent gaps in the accountCandidate lookup this feeds:
//   1. The lookup's `mapped.eventFingerprint` branch never fires --
//      makeSignal()'s return object has no eventFingerprint field (it is
//      only computed later, per-signal, by normalizeOpportunity() ->
//      eventFingerprint() -- see that call below). Resolution has always
//      been 100% sourceUrl-based in production; that OR branch was dead.
//   2. Even a correct sourceUrl match only proves the MODEL cited a page
//      this run actually discovered for this account -- it never confirmed
//      that page's evidence is actually ABOUT this account. A multi-company
//      source page (e.g. a roundup or a firm's own multi-branch news page)
//      can carry a real, correctly-discovered sourceUrl while the model
//      extracts a different company's event from it.
//
// The fix below closes both gaps with one small, reused mechanism instead
// of a new resolution subsystem:
//   - requireResolvedCandidate() makes sourceUrl resolution a hard
//     requirement (a signal whose sourceUrl matches no candidate this run
//     actually discovered for the account is rejected, not silently
//     defaulted to `{}`); the dead eventFingerprint branch is removed
//     rather than kept as inert-but-misleading code.
//   - verifyCandidateCompanyGrounding() then confirms company identity
//     using ONLY that candidate's query-scoped title+snippet (Serper's own
//     relevance-scoped excerpt for a quoted-company-name search) -- never
//     Firecrawl's full pageContent, which is scraped regardless of
//     relevance and is exactly where the reproduced Avidia contamination
//     lived. It reuses entityMatch() (signal-intelligence.js) unchanged for
//     the primary check (full company name, or its punctuation/suffix-
//     normalized form, present in the source) plus a narrow fallback for
//     legitimate shortened references (e.g. "Gallagher" for "Arthur J.
//     Gallagher & Co.") that entityMatch's full-phrase check alone would
//     miss -- bounded to a short list of generic business-entity words so
//     it cannot fire on a bare "bank"/"group"/"insurance" style word alone.
//
// Explicit scope: this proves the accepted signal's source candidate was
// one House Accounts actually discovered for the requested account, and
// that candidate's query-scoped evidence credibly identifies that company.
// It does NOT prove event-local provenance -- a candidate whose title and
// snippet genuinely identify the right company, but whose separately
// fetched pageContent also contains an unrelated company's story elsewhere
// on the same page, remains a residual gap (see
// scripts/test-signal-account-evidence-grounding.js's mixed-page-scope
// case). Closing that would require a fuzzy event-local excerpt/fingerprint
// primitive this repo does not have and this sprint does not build.
//
// verifyCandidateCompanyGrounding() itself (along with the generic-word
// exclusion list and distinctive-token fallback it's built on) now lives in
// signal-intelligence.js, next to entityMatch() -- api/research-account.js's
// single-account pipeline reuses the exact same primitive rather than a
// second, independently-drifting copy. Only candidate RESOLUTION stays
// endpoint-specific below, since this endpoint's candidates span multiple
// accounts per request (api/research-account.js's do not, so it needs no
// equivalent accountName filter).

// Requires the signal's sourceUrl to resolve to a candidate this run
// actually discovered for the requested account -- replaces the previous
// `sourceUrl OR eventFingerprint` lookup (whose eventFingerprint branch was
// dead; see comment above) with a single, mandatory check instead of an
// optional one that silently fell back to `{}` on no match.
function requireResolvedCandidate(candidates, mapped, account) {
  if (!mapped.sourceUrl) return null;
  return candidates.find(c => c.accountName === account.name && c.url === mapped.sourceUrl) || null;
}

// ---------------------------------------------------------------------------
// Phase 2A implementation-review — server-owned research-run idempotency.
// Gated entirely on uploadId: a request with NO uploadId (checked below)
// never reaches any of this. api/weekly-scan.js's own call to this endpoint
// (mode:'weekly-monitoring') sends no uploadId/auth header at all and is
// completely unaffected -- it already has its own concurrency guard via
// ha_weekly_runs. Same for prospect_script.js's prospecting flow.
//
// ROUND 4 correction: a request that DOES send uploadId is no longer
// allowed to opt out of tracking by simply omitting attemptId. Every
// upload-bound caller -- the automatic batch call, every per-account
// fallback call, and the standalone single-account "Research Account"
// button -- now claims a real run/attempt first (see
// dashboard/index.html's claimAutomaticResearchRun()/researchAccountByName())
// and this endpoint rejects (400) any uploadId-bound request missing
// researchRunId/attemptId, rather than silently proceeding untracked.
//
// This endpoint still writes NOTHING to ha_signals/ha_accounts itself
// (unchanged invariant) -- the one narrow exception is bookkeeping rows in
// ha_research_runs, added specifically so a second tab or a page reload
// cannot launch an untracked, duplicate research execution against the same
// upload. See supabase-schema-migration-5-research-run-idempotency.sql.
// ---------------------------------------------------------------------------
function rbEnv() {
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const url = String(rawUrl).trim().replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  return { url, key };
}
async function rbSupabase(path, options = {}) {
  const { url, key } = rbEnv();
  const resp = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: options.prefer || 'return=representation', ...(options.headers || {}) }
  });
  const text = await resp.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!resp.ok) {
    const msg = typeof data === 'string' ? data : (data?.message || data?.hint || JSON.stringify(data));
    const httpErr = new Error(`Supabase ${resp.status}: ${msg}`);
    httpErr.status = resp.status;
    // Postgres's sqlstate (e.g. '42501', '55P03'), when the response body is
    // a PostgREST-shaped RPC error. Lets callers branch on the actual
    // database error code rather than regex-matching a human message.
    httpErr.code = (data && typeof data === 'object') ? data.code : undefined;
    throw httpErr;
  }
  return data;
}

// Phase 2A implementation-review ROUND 2, item 2 — resolves identity for a
// request bound to a persisted upload (uploadId present). This is
// deliberately strict and has NO lead/email fallback of any kind:
//   - a valid Supabase auth Bearer token is required;
//   - the resolved ha_users row must actually own uploadId (verified against
//     ha_uploads.user_id, mirroring claim_ha_research_run()'s own ownership
//     check -- see supabase-schema-migration-5-research-run-idempotency.sql
//     §7);
//   - a nonexistent uploadId is treated identically to a wrong-owner
//     uploadId (reason: 'not-owner' either way) so this endpoint does not
//     leak whether an upload id exists, matching the RPC's own behavior.
// The previous round's resolveUserForResearchRun() fell back to a
// client-supplied lead.email when no auth token was present. That fallback
// is REMOVED, not narrowed: this function's only caller is the uploadId-
// bound branch of handler() below, which claims/mutates a persisted
// ha_research_runs row and (via the account snapshot RPC, elsewhere)
// eventually a persisted customer upload -- exactly the case the review
// flagged as unsafe for a client-supplied email to authenticate ("a spoofed
// lead email with another user's upload" must not be able to claim or read
// that user's research run). The pre-existing, unauthenticated prospecting
// flow (mode: 'prospect-intelligence' / warm-account with no uploadId) never
// calls this function at all -- see the `if (targetUploadId)` gate in
// handler() -- and is completely unaffected.
async function resolveAuthenticatedUploadOwner(req, uploadId) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return { user: null, reason: 'no-token' };
  let authUserId = '';
  try {
    const { url, key } = rbEnv();
    const authResp = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (!authResp.ok) return { user: null, reason: 'invalid-token' };
    const authUser = await authResp.json();
    authUserId = authUser?.id || '';
  } catch {
    return { user: null, reason: 'invalid-token' };
  }
  if (!authUserId) return { user: null, reason: 'invalid-token' };
  // Duplicate-company-research-control round: organization_id added to this
  // SELECT (previously id,email only) so callers can resolve org-vs-solo
  // scope for the duplicate-company check without a second round trip. This
  // is the exact same ha_users table and column api/save-upload.js's
  // getUsageContext()/orgUsers() and api/settings.js already read for the
  // identical purpose (cross-upload, org-scoped company identity) -- no new
  // table, no new authorization surface, the row itself is already fully
  // verified (real auth token, matched to a real ha_users row) before this
  // column is ever read.
  const userRows = await rbSupabase(`ha_users?auth_user_id=eq.${encodeURIComponent(authUserId)}&select=id,email,organization_id&limit=1`);
  const user = Array.isArray(userRows) ? userRows[0] : null;
  if (!user?.id) return { user: null, reason: 'invalid-token' };
  const uploadRows = await rbSupabase(`ha_uploads?id=eq.${encodeURIComponent(uploadId)}&select=id,user_id&limit=1`);
  const upload = Array.isArray(uploadRows) ? uploadRows[0] : null;
  if (!upload || upload.user_id !== user.id) return { user: null, reason: 'not-owner' };
  return { user, reason: null };
}

// Security correction sprint (pre-Beta): closes the previously-unauthenticated
// no-uploadId path (the "anonymous prospecting" branch -- mode:
// 'prospect-intelligence' / 'warm-account' / default 'ranked' -- which used to
// run full paid-provider research for ANY caller). Verifies only that the
// caller carries a valid Supabase Bearer token identifying a real ha_users
// row -- no upload-ownership check, since there is no uploadId here. Does not
// change RESEARCH_BATCH_MAX_ACCOUNTS or any other existing per-request cap,
// and does not touch the uploadId-bound path (resolveAuthenticatedUploadOwner)
// or the weekly-monitoring CRON_SECRET path above, both already authenticated.
async function resolveAuthenticatedCaller(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const { url, key } = rbEnv();
    const authResp = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
    if (!authResp.ok) return null;
    const authUser = await authResp.json();
    if (!authUser?.id) return null;
    const userRows = await rbSupabase(`ha_users?auth_user_id=eq.${encodeURIComponent(authUser.id)}&select=id,email&limit=1`);
    const user = Array.isArray(userRows) ? userRows[0] : null;
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

// Duplicate-company research control (beta round). Cost/spend protection
// only -- never merges, shares, or exposes account records across uploads or
// organizations; only ever tells the caller "a matching company is already
// being actively researched elsewhere in your scope," using the caller's OWN
// account name back to them.
//
// Scope: organization-wide when the resolved user belongs to one, else
// solo-user-only. Reuses the exact scoping pattern api/save-upload.js's
// getUsageContext()/orgUsers() already uses for the (also cross-upload,
// also org-scoped) free-plan company-count check -- not reinvented here.
// The user_id filter below is applied AT the query (PostgREST
// user_id=in.(...)), never after fetching -- this scope resolution can never
// see, let alone return, another organization's rows.
async function resolveDuplicateCheckScopeUserIds(userId, organizationId) {
  if (!organizationId) return [userId];
  try {
    const rows = await rbSupabase(`ha_users?organization_id=eq.${encodeURIComponent(organizationId)}&select=id`);
    const ids = (Array.isArray(rows) ? rows : []).map(u => u.id).filter(Boolean);
    return ids.length ? ids : [userId];
  } catch (err) {
    // Fail open at scope resolution too -- see findActiveDuplicateCompanyCollisions()'s
    // own fail-open contract just below. A failure here must never block
    // research; falling back to solo scope is the safe, conservative default
    // (it can only under-protect, never expose another org's data).
    console.warn('[research-batch] duplicate-company scope resolution failed; falling back to solo scope', { message: err && err.message });
    return [userId];
  }
}

// Target-granularity correction round: sanitizes a client-supplied list of
// account names (or already-normalized keys -- it makes no difference, this
// re-normalizes unconditionally) into the exact set of normalized company
// keys a claimed run should be considered "actively targeting". Never trusts
// client-supplied normalized values directly -- every entry is re-derived via
// the shared normalizeCompanyName() server-side. Non-string entries are
// dropped, empties are dropped, duplicates are collapsed, and the result is
// capped at a reasonable count so a malformed/oversized payload cannot bloat
// result_summary.
const TARGET_COMPANY_KEYS_MAX_COUNT = 500;
function sanitizeTargetCompanyKeys(names) {
  if (!Array.isArray(names)) return [];
  const keys = new Set();
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    if (raw.length > 300) continue; // defensive length bound -- no real company name is this long
    const key = normalizeCompanyName(raw);
    if (!key) continue;
    keys.add(key);
    if (keys.size >= TARGET_COMPANY_KEYS_MAX_COUNT) break;
  }
  return [...keys];
}

// Target-granularity correction round: writes the exact normalized
// company-key set a claimed attempt is actively targeting into that row's
// own result_summary (an existing jsonb column -- no migration). Always
// writes a COMPLETE replacement object (never merges with whatever was
// there before), which is what guarantees a reclaimed/new attempt never
// inherits a stale target set left over from a prior attempt on the same
// row. Guarded by user_id + upload_id + research_run_id + attempt_id +
// status='running', so this can only ever affect the exact attempt that is
// still the current, live owner of the row -- a superseded attempt's write
// silently matches zero rows. Fails open: a failure here is logged (bounded,
// non-sensitive context only) and swallowed -- it must never block the
// claim/dispatch it was called from, and callers must never fall back to
// inferring targets from every account in the upload.
async function persistRunTargetCompanyKeys({ userId, uploadId, researchRunId, attemptId, targetCompanyKeys }) {
  try {
    await rbSupabase(
      `ha_research_runs?user_id=eq.${encodeURIComponent(userId)}&upload_id=eq.${encodeURIComponent(uploadId)}&research_run_id=eq.${encodeURIComponent(researchRunId)}&attempt_id=eq.${encodeURIComponent(attemptId)}&status=eq.running`,
      {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: JSON.stringify({
          result_summary: {
            target_company_keys: targetCompanyKeys,
            target_account_count: targetCompanyKeys.length,
            target_scope_version: 1
          }
        })
      }
    );
    return true;
  } catch (err) {
    console.warn('[research-batch] failed to persist target-company metadata for a claimed run; failing open (this run will report no collisions to other uploads until its targets are successfully recorded)', {
      uploadId, researchRunId, message: err && err.message
    });
    return false;
  }
}

// Returns a Set of normalized company keys (normalizeCompanyName() output)
// currently targeted by an ACTIVE (status='running', lease not expired)
// research run belonging to a DIFFERENT upload within the resolved scope.
//
// Target-granularity correction round: this now reads the EXACT company
// keys that run's own claim/dispatch recorded into its result_summary
// (result_summary.target_company_keys -- see persistRunTargetCompanyKeys()
// above), never "every account belonging to that run's upload". An upload
// with an active run for ONE account no longer causes every other account in
// that same upload to be treated as actively researched -- that was the
// confirmed overblocking defect this round corrects. A row with missing or
// malformed target metadata (e.g. its claim-time write failed, or it predates
// this round) contributes NO collisions and is simply skipped -- it is never
// used as a signal to fall back to querying that upload's full account list.
//
// Never includes the current upload's own run (excluded at the query
// itself, by upload_id). Never inspects a user/org outside the resolved
// scope handed to it. Fails open: any error here returns an empty Set (i.e.
// "no known collisions") rather than throwing -- callers must never let a
// failure in this check block or fail real research.
async function findActiveDuplicateCompanyCollisions({ userId, organizationId, uploadId }) {
  try {
    const scopeUserIds = await resolveDuplicateCheckScopeUserIds(userId, organizationId);
    const userFilter = `in.(${scopeUserIds.map(encodeURIComponent).join(',')})`;
    const nowIso = new Date().toISOString();
    const otherRuns = await rbSupabase(
      `ha_research_runs?user_id=${userFilter}&upload_id=neq.${encodeURIComponent(uploadId)}&status=eq.running&lease_expires_at=gt.${encodeURIComponent(nowIso)}&select=upload_id,result_summary`
    );
    const collisions = new Set();
    for (const run of (Array.isArray(otherRuns) ? otherRuns : [])) {
      const keys = run && run.result_summary && Array.isArray(run.result_summary.target_company_keys)
        ? run.result_summary.target_company_keys
        : null;
      if (!keys) continue; // missing/malformed target metadata -- ignore this run, never infer from its upload's full account list
      for (const key of keys) {
        if (typeof key === 'string' && key) collisions.add(key);
      }
    }
    return collisions;
  } catch (err) {
    console.warn('[research-batch] duplicate-company collision check failed; failing open (no collisions reported, research proceeds normally)', {
      uploadId,
      message: err && err.message
    });
    return new Set();
  }
}

// Phase 2A implementation-review ROUND 2, items 3/4 — calls the atomic
// claim_ha_research_run() RPC (see
// supabase-schema-migration-5-research-run-idempotency.sql §7) and
// translates its {outcome, run} result (or a raised ownership/conflict
// exception) into a shape handler() can act on directly. This is the ONLY
// place a row is ever inserted or reclaimed in ha_research_runs -- neither
// the actual research call nor the fallback-loop's per-account calls claim
// anything themselves anymore (round 1's design had each of up to 4
// concurrent fallback-loop requests independently call claimResearchRun()
// with the SAME shared run id, which would have made 3 of the 4 immediately
// short-circuit as "already running" -- a real bug found during round-2
// review, fixed by claiming exactly once per logical
// researchTopAccounts() pass, before any of the actual research requests are
// made).
async function claimResearchRunAtomic({ userId, uploadId, researchRunId, leaseSeconds = 300 }) {
  try {
    const result = await rbSupabase('rpc/claim_ha_research_run', {
      method: 'POST',
      body: JSON.stringify({ p_user_id: userId, p_upload_id: uploadId, p_research_run_id: researchRunId, p_lease_seconds: leaseSeconds })
    });
    return { ok: true, outcome: result?.outcome, run: result?.run || {} };
  } catch (err) {
    if (err.code === '55P03') {
      return { ok: false, status: 409, body: { error: 'A different research run is already in progress for this upload.' } };
    }
    if (err.code === '42501') {
      // Should not normally happen -- handler() already verified ownership
      // via resolveAuthenticatedUploadOwner() before calling this. Kept as
      // defense in depth against a future application-code bug.
      return { ok: false, status: 403, body: { error: 'You do not have access to this upload.' } };
    }
    throw err;
  }
}

// Phase 2A implementation-review ROUND 2, item 4 — completion/failure is
// guarded by attempt_id: the PATCH only matches (and only takes effect on)
// the row that is STILL owned by this exact attempt. If a different, later
// attempt already reclaimed this run (the original attempt's Vercel
// invocation was killed before it could call this), the WHERE clause below
// matches zero rows, PostgREST returns an empty array, and `applied` comes
// back false -- the late result is silently discarded rather than
// overwriting the replacement attempt's state. See
// supabase-schema-migration-5-research-run-idempotency.sql §5 and
// scripts/test-research-run-idempotency.js's "old worker completes after
// lease takeover" case.
async function completeResearchRunAttempt({ uploadId, researchRunId, attemptId, resultSummary }) {
  const updated = await rbSupabase(
    `ha_research_runs?upload_id=eq.${encodeURIComponent(uploadId)}&research_run_id=eq.${encodeURIComponent(researchRunId)}&attempt_id=eq.${encodeURIComponent(attemptId)}`,
    { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString(), result_summary: resultSummary || {} }) }
  );
  return { applied: Array.isArray(updated) && updated.length > 0 };
}
async function failResearchRunAttempt({ uploadId, researchRunId, attemptId, errorMessage }) {
  const updated = await rbSupabase(
    `ha_research_runs?upload_id=eq.${encodeURIComponent(uploadId)}&research_run_id=eq.${encodeURIComponent(researchRunId)}&attempt_id=eq.${encodeURIComponent(attemptId)}`,
    { method: 'PATCH', prefer: 'return=representation', body: JSON.stringify({ status: 'failed', completed_at: new Date().toISOString(), error_message: clean(errorMessage).slice(0, 2000) }) }
  );
  return { applied: Array.isArray(updated) && updated.length > 0 };
}

// Phase 2A implementation-review ROUND 3, items 1/2 — atomic lease renewal
// AND attempt-ownership verification via heartbeat_ha_research_run() (see
// supabase-schema-migration-5-research-run-idempotency.sql §7a). This one
// function serves two purposes used at different points below:
//   - as a GATE, called once at the very top of the actual research work,
//     BEFORE any OpenAI/Serper/Firecrawl call -- a stale/replaced attempt
//     fails here and the request is rejected with 409 before any provider
//     cost is incurred (item 2).
//   - as a periodic RENEWAL, called on an interval for the duration of a
//     single long-running batch request (item 1 -- the real Phase 1B
//     fallback execution ran ~12 minutes, well past a 300s lease).
// leaseSeconds is clamped here in JS (defense in depth) in addition to the
// RPC's own authoritative clamp -- a client cannot obtain an oversized
// lease by requesting one; MAX/MIN below match the RPC's [60, 900] bounds
// exactly so a legitimate request is never silently truncated below what it
// asked for within that range.
const HEARTBEAT_MIN_LEASE_SECONDS = 60;
const HEARTBEAT_MAX_LEASE_SECONDS = 900;
const HEARTBEAT_DEFAULT_LEASE_SECONDS = 300;
function clampLeaseSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return HEARTBEAT_DEFAULT_LEASE_SECONDS;
  return Math.max(HEARTBEAT_MIN_LEASE_SECONDS, Math.min(n, HEARTBEAT_MAX_LEASE_SECONDS));
}
async function heartbeatResearchRunAtomic({ userId, uploadId, researchRunId, attemptId, leaseSeconds }) {
  const result = await rbSupabase('rpc/heartbeat_ha_research_run', {
    method: 'POST',
    body: JSON.stringify({ p_user_id: userId, p_upload_id: uploadId, p_research_run_id: researchRunId, p_attempt_id: attemptId, p_lease_seconds: clampLeaseSeconds(leaseSeconds) })
  });
  return result || { ok: false, reason: 'unknown' };
}

// Starts a self-rescheduling (not overlapping) heartbeat loop for the
// duration of one long-running provider-work request, so a legitimate
// 12-20 minute fallback execution keeps renewing its own lease instead of
// losing ownership purely because of elapsed time. Uses setTimeout chaining
// rather than setInterval so a slow heartbeat call can never overlap with
// the next tick. Returns a stop() function that MUST be called from a
// finally block once the request's real work is done (success or error) --
// callers never leave a dangling timer past the response.
function startHeartbeatRenewalLoop({ userId, uploadId, researchRunId, attemptId }, intervalMs = 45000) {
  let stopped = false;
  let timer = null;
  async function tick() {
    if (stopped) return;
    try {
      const result = await heartbeatResearchRunAtomic({ userId, uploadId, researchRunId, attemptId, leaseSeconds: HEARTBEAT_DEFAULT_LEASE_SECONDS });
      if (!result.ok) {
        // This attempt has been superseded (reclaimed after an earlier
        // heartbeat/renewal gap, or the run was otherwise terminated).
        // Nothing further to do here -- the eventual complete/fail report
        // for THIS attempt will itself no-op (attempt_id-guarded), and the
        // in-flight provider work is allowed to finish naturally rather
        // than being forcibly aborted mid-call.
        console.warn('[research-batch] heartbeat renewal found this attempt is no longer current; will not retry', { uploadId, researchRunId });
        stopped = true;
        return;
      }
    } catch (err) {
      console.warn('[research-batch] heartbeat renewal tick failed (will retry on the next interval)', { message: err.message });
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }
  timer = setTimeout(tick, intervalMs);
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

// Phase 2A worker-readiness: the synthesis prompt template, extracted
// verbatim (same file, same static text) from what used to be an inline
// template literal in handler(). Pure function of its two inputs
// (safeAccounts, candidates) plus the module-scope accountPromptContext()
// and the imported COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT -- exported
// below so api/lib/research-pipeline.js's runResearchPipeline() can build
// the exact same prompt a future worker needs, in-process.
function buildSynthesisPrompt(safeAccounts, candidates) {
  return `You are House Accounts' Prospect Buying Moment Extraction Engine.

Act like a senior account researcher doing prospect research for a sales rep. Your job is NOT to summarize companies. Your job is to extract buying moments that answer:

"Why should I contact this company today?"

Use ONLY the supplied account context, uploaded contacts, search snippets, URLs, and clean page content. Do not invent.

A buying moment is a concrete event that creates a real, identifiable human moment for a specific audience (employees, customers, recruits, investors, partners, or another concrete group the evidence supports) -- not merely an event that could theoretically justify a merchandise conversation. Examples of the kinds of events worth surfacing:
- facility expansion, new location, ribbon cutting, new distribution center, manufacturing expansion
- trade show, exhibitor participation, booth, conference, summit, open house, customer event, dealer meeting, webinar
- product launch, rebrand, merger, acquisition, partnership, contract win
- hiring with HR, marketing, event, employee experience, field marketing, recruiting, or onboarding context
- community event, sponsorship, corporate philanthropy
- safety milestone, company anniversary, major award actively promoted by the company

Return the strongest 0 to 4 distinct buying moments per account. Do not stop after the first strong signal when additional independently actionable opportunities are supported by different evidence or a meaningfully different event. Do not require perfect context. If a meaningful signal exists but the underlying driver is unclear, keep the signal, state the uncertainty clearly, and assign lower confidence.
Prefer a low or medium live buying moment over a generic Predictable Timing fallback when there is a real recent source with a reasonable commercial-activation angle.
Whether to RETURN a buying moment at all (governed by the criteria on this line and "Reject" below) and whether you have a credible commercial ACTIVATION for it (commercial_play/activation_ideas/expansion_potential, see below) are separate judgments -- a real, current, sourced, material event about the account (an acquisition, leadership change, facility opening, funding event, product launch, sponsorship, etc.) should still be returned even when you conclude no credible activation exists yet. In that case return the factual fields and leave commercial_play/activation_ideas/expansion_potential empty or omitted -- never drop the whole buying moment merely because you couldn't responsibly infer a program around it.

Reject:
- generic company descriptions, mission/history/culture copy
- generic careers page existence unless evidence shows meaningful hiring or a recruiting push
- old or irrelevant awards unless active/currently promoted or tied to a clear sales angle
- vague community or sustainability copy unless tied to a concrete event, certification, deadline, award, partnership, facility, campaign, or active program
- clearly negative/irrelevant signals: layoffs, downsizing, restructuring, bankruptcy, plant closures, investigations, recalls, scandals. Operational friction such as lawsuits, town disputes, power outages, or facility issues may only be accepted when the angle is respectful internal morale, retention, plant pride, or employee support

Preserve concrete triggers. Do not generalize specific events. Examples:
- Bad: "Expansion". Better: "New Facility Inauguration in Virginia".
- Bad: "Community engagement". Better: "Hosting FTC Scrimmage at company headquarters".
- Bad: "Hiring". Better: "Hiring Field Marketing Manager responsible for trade shows".

For each accepted signal:
1. concrete_trigger: specific event phrased as a short label.
2. buying_moment: the category of buying moment.
3. business_context: what happened and why it likely happened. Keep this factual -- what happened, when, according to what evidence. This is not the place for commercial interpretation; see below for that.
4. ${COMMERCIAL_INTELLIGENCE_PROMPT_FRAGMENT}
5. suggested_opener: the discovery question described above (this is the field name; the intent is a discovery question, not opener copy).
6. recommended_buying_team: 1 to 3 departments inferred from the signal and context.
7. potential_contacts: max 2 people only if supported by public evidence or uploaded contacts.
8. ABD scores: actionability_score, budget_score, deadline_score.

Recommended Buying Team examples:
- Hiring expansion → HR / People, Talent Acquisition
- Product launch → Marketing, Product Marketing
- Community event → Marketing, Community Relations
- Manufacturing expansion → Operations, HR / People
- Trade show → Marketing, Events, Sales

Potential Contacts rules:
- Use uploaded knownContacts if they align with the recommended buying team.
- Use public contacts only when the source supports the person and title.
- If a user supplied a contact name, verify and prefer that person when supported.
- Never invent names, titles, emails, phones, LinkedIn URLs, or contact pages.
- Include public contact fields only when they appear in the supplied evidence.
- Omit potential_contacts if no reliable person is found.

Leadership and contact-change rules:
- Accept executive appointments, promotions, known-contact role changes, and known-contact company changes only when the person, company, and new role are supported by a credible public source.
- Preserve the person's name, exact new title, company, and announcement date when available.
- Do not treat leadership changes as automatically high priority. They must compete with every other opportunity using the existing ABD / Why Now logic.
- Penalize stale, weakly sourced, or role-only mentions, and reject undated directory listings that do not establish a recent change.

Score concrete, high-intent buying moments higher:
Highest value signals generally include facility expansion/new location, rebrand/merger, trade show exhibitor participation, major product launch, contract win/partnership, major award actively promoted, safety milestone, and company anniversary. A verified recent HR or Marketing executive change may also rank strongly when it creates a clear, timely promotional-products conversation.
Lower value: generic sustainability copy, generic hiring without context, old awards, vague community posts, minor funding/grants, generic blog content, or stale leadership listings.

Return strict JSON only with shape:
{"signals":[{"company_name":"","accountName":"","signal_type":"Hiring|Expansion|Trade Show / Event|Award / Recognition|Leadership Change|Product Launch|Acquisition / Funding|Partnership / Contract|Community / CSR|Rebrand","signalType":"","concrete_trigger":"","buying_moment":"","signalTitle":"","whatChanged":"","event_date":"","location":"","source_url":"","source_name":"","business_context":"","businessContext":"","commercial_play":{"concept":"(optional)","narrative":""},"commercialPlay":{"concept":"(optional)","narrative":""},"activation_ideas":[""],"activationIdeas":[""],"expansion_potential":{"narrative":"","tags":["(0-3 from the fixed list)"]},"expansionPotential":{"narrative":"","tags":["(0-3 from the fixed list)"]},"recommended_buying_team":[""],"recommendedBuyingTeam":[""],"potential_contacts":[{"name":"","title":"","reason":"","sourceUrl":"","linkedin":"","email":"","direct_phone":"","company_phone":"","contact_page":"","confidence":"High|Medium|Low","sources_used":[{"name":"","url":""}]}],"potentialContacts":[{"name":"","title":"","reason":"","sourceUrl":"","linkedin":"","email":"","directPhone":"","companyPhone":"","contactPage":"","confidence":"High|Medium|Low","sourcesUsed":[{"name":"","url":""}]}],"why_these_contacts":"","whyTheseContacts":"","promo_categories":[""],"likelyProducts":[""],"suggested_opener":"","suggestedOpener":"","actionability_score":0,"budget_score":0,"deadline_score":0,"why_now_score":0,"confidence":0,"sourceName":"","sourceUrl":"","sources":[{"name":"","url":""}],"publicationDate":""}]}

commercial_play, activation_ideas, and expansion_potential are all optional -- omit any of them entirely (or use null) for a signal where the evidence does not support a credible commercial interpretation, rather than filling them with generic content.

Accounts:
${JSON.stringify(accountPromptContext(safeAccounts), null, 2)}

Candidate snippets and clean page content:
${JSON.stringify(candidates.slice(0, 180).map(c => ({accountName:c.accountName, title:c.title, snippet:c.snippet, pageContent:c.pageContent || '', url:c.url, sourceType:c.sourceType, provider:c.provider, date:c.date, query:c.query, signalFamily:c.signalFamily, signalSubtype:c.signalSubtype, sources:c.sources})), null, 2)}`;
}

// Phase 2A worker-readiness: the parse/map/validate/grounding/event-
// resolution tail, extracted verbatim (same file, parameters bound to the
// exact names the body already used as closure variables -- no internal
// line was rewritten) from what used to be inline in handler() between the
// OpenAI response being parsed and the final signals array being computed.
// Characterized by scripts/test-weekly-monitoring-characterization.js
// BEFORE this extraction (all 30 assertions there passed against the
// pre-extraction inline code; the same file is re-run against this
// function unchanged, proving equivalence -- see the Phase 2A report).
// Kept in this file (not moved to api/lib/research-pipeline.js) for the
// same reason Phase 1's export-in-place choice was made: it depends on
// module-scope helpers (makeSignal, requireResolvedCandidate,
// normalizeOpportunity, validateOpportunity, verifyCandidateCompanyGrounding,
// dedupeSignals, dedupeOpportunities, resolveOpportunityEvents, clean,
// shortHash, DEBUG_INSTRUMENTATION) that are themselves not extracted --
// moving this function alone to another file without those would require
// either duplicating them or creating a circular import between this file
// and api/lib/research-pipeline.js (see that module's own header comment
// for why that was avoided in Phase 1). Exported below (existing named-
// export block) so api/lib/research-pipeline.js's runResearchPipeline()
// can call it in-process, same import pattern as
// discoverCandidatesForAccounts/callOpenAIJson/mapLimit already use.
function mapSignalsFromModelOutput({ parsed, mode, startedAt, providerMode, candidates, safeAccounts, derivedIdentityByAccount, runId }) {
  const rawSignals = Array.isArray(parsed?.signals) ? parsed.signals : [];
  if (mode === 'prospect-intelligence' || mode === 'warm-account') {
    prospectDebugLog('LLM opportunity parser complete', {
      // Benchmark diagnostic (scale/research-runtime-benchmark): the gap
      // between this and 'OpenAI synthesis starting' above is the OpenAI
      // network call itself plus the (synchronous, cheap) parseJsonLoose()
      // call -- effectively isolating OpenAI's own latency for this request.
      elapsedMs: Date.now() - startedAt,
      providerMode,
      candidateCountPassedToParser: candidates.length,
      rawSignalsReturned: rawSignals.length,
      rawSignalsByAccount: safeAccounts.map(a => ({
        company: a.name,
        rawSignals: rawSignals.filter(s => clean(s.accountName || s.account || s.company || s.company_name || s.companyName || '').toLowerCase().includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(clean(s.accountName || s.account || s.company || s.company_name || s.companyName || '').toLowerCase())).length
      }))
    });
  }
  const validAccountNames = new Set(safeAccounts.map(a => a.name.toLowerCase()));
  const accountLookup = new Map(safeAccounts.map(a => [a.name.toLowerCase(), a.name]));
  const fixedSignals = rawSignals.map(s => {
    const name = clean(s.accountName || s.account || s.company || s.company_name || s.companyName || '');
    const exact = accountLookup.get(name.toLowerCase());
    if (exact) return { ...s, accountName: exact };
    // Fuzzy map if the model adds parentheticals or suffixes.
    const lower = name.toLowerCase();
    const found = safeAccounts.find(a => lower.includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(lower));
    return found ? { ...s, accountName: found.name } : s;
  });

  const madeSignalsRaw = fixedSignals.map(s => {
    const rawSignalAccountName = clean(s.accountName || s.account || s.company || s.company_name || s.companyName || '');
    const account = safeAccounts.find(a => a.name.toLowerCase() === rawSignalAccountName.toLowerCase()) || {};
    // Global Business Trigger Intelligence sprint, founder correction round
    // (silent signal-loss diagnostics): fixedSignals' own fuzzy substring
    // correction above only fires when one name is a substring of the
    // other -- a raw AI accountName that is neither (a paraphrase, an
    // abbreviation the model invented) falls through both that pass AND
    // this exact-match lookup, leaving `account` the empty-object fallback
    // for the rest of this signal's pipeline. Logged here, at the exact
    // point of failure, rather than only surfacing later as an unexplained
    // gap between rawSignals and mappedSignals counts.
    if (!account.name) {
      console.warn('[Signal Intelligence] raw signal discarded: accountName did not resolve to any requested account', { rawAccountName: rawSignalAccountName, title: s.signalTitle || s.title || s.concrete_trigger || '' });
      return null;
    }
    const accountMode = clean(account.intelligenceMode).toLowerCase();
    const mapped = makeSignal(s, account, { enableProspectQuality: mode === 'prospect-intelligence' || mode === 'warm-account' || accountMode === 'warm' || accountMode === 'mixed' });
    if (!mapped) {
      console.warn('[Signal Intelligence] raw signal discarded by makeSignal()', { company: account.name, reason: s.__rejectionReason || 'unknown', title: s.signalTitle || s.title || s.concrete_trigger || '' });
      return null;
    }
    const accountCandidate = requireResolvedCandidate(candidates, mapped, account);
    let normalized = normalizeOpportunity(mapped, account, accountCandidate || {});
    const validation = validateOpportunity(normalized);
    const groundingReasons = [];
    let grounding = null;
    if (!accountCandidate) {
      groundingReasons.push('source not matched to a discovered candidate');
    } else {
      // Identity-bootstrap sprint: pass an AUGMENTED COPY of the account
      // into the existing, unmodified grounding machinery -- never weaken
      // verifyCandidateCompanyGrounding() itself, just give it the same
      // location input an uploaded account would have had. Uploaded
      // location always wins (account.location is checked first);
      // derived identity only fills a genuine gap. Non-circularity: the
      // exact candidate the identity was derived FROM is excluded from
      // ever being evaluated WITH that same derived location -- it
      // already grounds independently on its own merits (name + domain),
      // so this guard costs nothing real while keeping the ordering
      // honest. account/safeAccounts themselves are never mutated.
      const derivedIdentity = derivedIdentityByAccount.get(account.name);
      const candidateIsIdentitySource = Boolean(derivedIdentity?.sourceUrl) && accountCandidate.url === derivedIdentity.sourceUrl;
      const groundingAccount = (!account.location && derivedIdentity?.location && !candidateIsIdentitySource)
        ? { ...account, location: derivedIdentity.location }
        : account;
      grounding = verifyCandidateCompanyGrounding(accountCandidate, groundingAccount);
      // Trust correction (entity-disambiguation): 'rejected' is the only
      // hard-discard outcome now -- 'unconfirmed' still fails validation's
      // old boolean expectation (grounding.grounded) but is a real,
      // recall-preserving result that must reach persistence, just flagged.
      // See normalizeOpportunity() below for identityConfidence stamping.
      if (grounding.identityConfidence === 'rejected') {
        groundingReasons.push(`company identity not confirmed in source evidence (${grounding.reasons.join('; ') || 'no corroborating evidence'})`);
      }
    }
    if (!validation.valid || groundingReasons.length) {
      console.warn('[Signal Intelligence] opportunity rejected', { company: account.name, reasons: [...validation.reasons, ...groundingReasons], title: normalized.signalTitle });
      return null;
    }
    // Trust correction: stamp the tri-state identity verdict onto the
    // persisted opportunity so dashboard-side primary/Verified-Opportunity
    // gating (accountOpportunityCluster()/renderVerifiedOpportunitySection())
    // can enforce confirmed > unconfirmed as a trust gate BEFORE any ranking
    // runs -- never inferred at render time from unrelated fields. (A
    // missing accountCandidate already hard-rejects above via
    // groundingReasons, so `grounding` is always set by the time this line
    // runs; the fallback exists only so this can never silently default to
    // a truthy/confirmed value if that invariant ever changes.)
    //
    // Monitoring Identity V1: also stamp the underlying corroborator
    // reasons, not just the identityConfidence label -- classifyMonitoring
    // SignalEligibility() (api/lib/monitoring-identity.js) needs the ACTUAL
    // corroborator (domain match vs. a location/publisher-geo/self-domain-
    // inference match) to tell strong from weak evidence; identityConfidence
    // alone conflates all six of today's corroborators as equivalent.
    normalized = {
      ...normalized,
      identityConfidence: grounding ? grounding.identityConfidence : 'unconfirmed',
      identityCorroboratorReasons: grounding ? grounding.reasons : []
    };
    return normalized;
  });
  const mappedSignals = madeSignalsRaw.filter(Boolean);
  const validMappedSignals = mappedSignals.filter(s => validAccountNames.has(String(s.accountName || '').toLowerCase()));
  // Global Business Trigger Intelligence sprint, founder correction round
  // (silent signal-loss diagnostics): defense-in-depth logging -- the
  // account-resolution check added above (madeSignalsRaw's map()) should
  // make this filter a no-op in practice, but it is the last point a
  // mapped signal could still be silently dropped before persistence, so
  // it gets the same treatment rather than staying a bare count.
  if (validMappedSignals.length !== mappedSignals.length) {
    const droppedForInvalidAccountName = mappedSignals.filter(s => !validAccountNames.has(String(s.accountName || '').toLowerCase()));
    console.warn('[Signal Intelligence] mapped signal(s) discarded: accountName not among requested accounts at final filter', droppedForInvalidAccountName.map(s => ({ accountName: s.accountName, title: s.signalTitle || '' })));
  }
  // Temporal-integrity round: dedupeSignals()/dedupeOpportunities() above
  // are cheap first-pass collapses (same-account+type+topic-keywords, then
  // a legacy per-title fingerprint) that reduce the candidate count, but
  // neither considers canonical event type + location/date agreement --
  // two write-ups of the SAME real event with slightly different phrasing
  // could survive both and appear as two separate opportunities (confirmed
  // production case: duplicate Avidia Bank Westborough branch write-ups,
  // one becoming the primary opportunity and the other an Additional
  // Opportunity). resolveOpportunityEvents() is the SAME canonical
  // event-resolution engine api/weekly-scan.js and api/save-upload.js
  // already run immediately before persistence (see its own header
  // comment in signal-intelligence.js) -- running it here too, on the live
  // response, is what makes live dashboard output and persisted/digest
  // output use one shared identity system instead of two independently
  // -derived ones. It operates on the same normalizeOpportunity()-shaped
  // objects already produced above (headline/whatChanged/sourceUrl/
  // canonicalEventType are already present), so no field adaptation is
  // needed, and it never introduces fuzzy company matching -- grouping is
  // still normalizeCompany()-exact, per account, unchanged.
  const signals = resolveOpportunityEvents(dedupeOpportunities(dedupeSignals(validMappedSignals))).slice(0, 80);
  // Phase 2A / Correction 1 instrumentation — records the pipeline stage
  // counts requested for forensic classification of any future
  // accepted-vs-persisted discrepancy: raw model signals (what the AI
  // returned before any of this endpoint's own filtering), signals that
  // survived makeSignal()'s per-signal validation, signals confirmed
  // against a real requested account name, and the final accepted/deduped
  // count returned to the caller. Correlated by researchRunId so a single
  // logical research pass can be traced end-to-end alongside the
  // save-upload.instrumentation line this endpoint's caller is expected to
  // log against the same runId.
  console.log('[research-batch.instrumentation]', JSON.stringify({
    ts: new Date().toISOString(),
    runId,
    mode,
    accountsRequested: safeAccounts.length,
    rawModelSignals: rawSignals.length,
    mappedSignals: mappedSignals.length,
    validMappedSignals: validMappedSignals.length,
    acceptedSignals: signals.length,
    // Hashed by default -- an event_fingerprint embeds a normalized
    // company name (see eventFingerprint()/resolveEvents() in
    // signal-intelligence.js), so logging it verbatim would be logging a
    // customer/account identifier. The hash is still stable and joinable
    // against api/save-upload.js's own hashed instrumentation for the
    // same run, without needing the raw value in normal logs.
    acceptedEventFingerprintHashes: signals.map(s => s.eventFingerprint).filter(Boolean).map(shortHash),
    ...(DEBUG_INSTRUMENTATION ? { acceptedEventFingerprints: signals.map(s => s.eventFingerprint).filter(Boolean) } : {})
  }));
  return { signals, rawSignals, mappedSignals, validMappedSignals };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const startedAt = Date.now();
  const body = req.body || {};
  const targetUploadId = clean(body.uploadId || '');
  const requestMode = clean(body.mode || '');

  // Security hotfix (weekly-monitoring internal-caller authorization): the
  // weekly scan cron (api/weekly-scan.js) calls this endpoint with
  // mode:'weekly-monitoring' and NO uploadId, which meant it never reached
  // the resolveAuthenticatedUploadOwner() check below and ran fully
  // unauthenticated -- letting anyone POST mode:'weekly-monitoring' and
  // trigger paid provider research for arbitrary caller-supplied accounts.
  // This check is deliberately the very first thing the handler does for
  // this mode, before uploadId resolution, before researchRunAction
  // handling, before the OPENAI_API_KEY check, and before any account-array
  // processing -- and it applies whether or not a uploadId is also present,
  // so it cannot be bypassed by combining mode:'weekly-monitoring' with a
  // real or fake uploadId. The secret is accepted only via the
  // Authorization: Bearer header (never body, query string, or cookies) and
  // is never logged or echoed back. Every other mode (prospect-intelligence,
  // warm-account, ranked/default) is unaffected by this check.
  if (requestMode === 'weekly-monitoring') {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return res.status(503).json({ error: 'Service unavailable: not configured.' });
    const authHeader = req.headers.authorization || '';
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
    const providedSecret = bearerMatch ? bearerMatch[1] : '';
    if (!providedSecret || !safeSecretEqual(providedSecret, cronSecret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Phase 2A implementation-review ROUND 2, item 2: ANY request bound to a
  // persisted upload (uploadId present) -- whether it is a run-control
  // action (claim/complete/fail, below) or an actual research call -- must
  // resolve to an authenticated ha_users record that verifiably owns that
  // upload. There is no lead/email fallback: see
  // resolveAuthenticatedUploadOwner() above.
  let uploadOwner = null;
  if (targetUploadId) {
    const resolved = await resolveAuthenticatedUploadOwner(req, targetUploadId);
    if (!resolved.user) {
      const status = resolved.reason === 'not-owner' ? 403 : 401;
      const error = resolved.reason === 'not-owner'
        ? 'You do not have access to this upload.'
        : 'Login required to research an uploaded account list.';
      return res.status(status).json({ error });
    }
    uploadOwner = resolved.user;
  } else if (requestMode !== 'weekly-monitoring') {
    // Security correction sprint (pre-Beta): the remaining no-uploadId
    // branch (the former "anonymous prospecting" flow, e.g.
    // prospect_script.js / prospects/index.html) previously ran unlimited,
    // unauthenticated paid-provider research. It is now closed the same
    // way as every other externally callable path: require a valid
    // Supabase Bearer token identifying a real House Accounts user. The
    // weekly-monitoring cron path is exempt here because it already passed
    // the CRON_SECRET check above.
    const caller = await resolveAuthenticatedCaller(req);
    if (!caller) {
      return res.status(401).json({ error: 'Login required to research accounts.' });
    }
  }

  // Run-control actions never call OpenAI or any search provider -- they
  // only read/write ha_research_runs via claim_ha_research_run() or an
  // attempt_id-guarded PATCH -- so they are handled and returned here,
  // before the OPENAI_API_KEY check below (which would otherwise be an
  // unrelated, misleading failure mode for a pure bookkeeping call).
  const researchRunAction = clean(body.researchRunAction || '');
  if (researchRunAction) {
    if (!targetUploadId) return res.status(400).json({ error: 'uploadId is required for researchRunAction requests.' });
    try {
      if (researchRunAction === 'claim') {
        const runIntent = clean(body.runIntent || 'auto');
        // Phase 2A implementation-review ROUND 2, item 3: run identity is
        // NEVER taken from the client. The automatic upload-research path
        // always claims the fixed literal research_run_id 'auto', scoped
        // uniquely by (user_id, upload_id) -- so a reload, a second tab, or
        // a client sending an arbitrary different string all resolve to the
        // exact same row. A genuinely new run identity is only ever minted
        // by THIS server, and only for the explicit, separately-authorized
        // 'manual-rerun' pathway (the "Research Top Accounts" button click
        // in dashboard/index.html when a run is not already in progress).
        const researchRunId = runIntent === 'manual-rerun'
          ? `manual-${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`
          : 'auto';
        const claim = await claimResearchRunAtomic({ userId: uploadOwner.id, uploadId: targetUploadId, researchRunId });
        if (!claim.ok) return res.status(claim.status).json(claim.body);
        const { outcome, run } = claim;
        if (outcome === 'completed') {
          // Reload / second tab / a stale client-generated id after the
          // automatic run already finished: return the cached outcome, do
          // not restart research.
          return res.status(200).json({ ok: true, outcome, researchRunId: run.research_run_id, resultSummary: run.result_summary || {}, completedAt: run.completed_at });
        }
        if (outcome === 'attached-active') {
          // Another attempt (a different tab, or this same tab's still-live
          // lease) currently owns this run. Do not launch a second
          // concurrent execution.
          return res.status(202).json({ ok: true, outcome, researchRunId: run.research_run_id, message: 'This research run is already in progress.' });
        }
        // claimed-new / reclaimed-after-failure / reclaimed-after-expired-lease:
        // this caller now genuinely owns the run. Target-granularity
        // correction round: persist the exact normalized company keys this
        // attempt is targeting BEFORE returning success, so
        // findActiveDuplicateCompanyCollisions() never has to fall back to
        // "every account in this upload" for it. body.targetAccountNames is
        // untrusted client input -- sanitizeTargetCompanyKeys() re-normalizes
        // every entry server-side rather than trusting any client-supplied
        // normalized value. A write failure here fails open (logged, this
        // run simply reports no collisions to other uploads until corrected)
        // and must never block the claim itself from succeeding.
        const targetCompanyKeys = sanitizeTargetCompanyKeys(body.targetAccountNames);
        await persistRunTargetCompanyKeys({
          userId: uploadOwner.id,
          uploadId: targetUploadId,
          researchRunId: run.research_run_id,
          attemptId: run.attempt_id,
          targetCompanyKeys
        });
        return res.status(200).json({ ok: true, outcome, researchRunId: run.research_run_id, attemptId: run.attempt_id, leaseExpiresAt: run.lease_expires_at });
      }
      if (researchRunAction === 'heartbeat') {
        const researchRunId = clean(body.researchRunId || '');
        const attemptId = clean(body.attemptId || '');
        if (!researchRunId || !attemptId) return res.status(400).json({ error: 'researchRunId and attemptId are required.' });
        const result = await heartbeatResearchRunAtomic({ userId: uploadOwner.id, uploadId: targetUploadId, researchRunId, attemptId, leaseSeconds: body.leaseSeconds });
        if (!result.ok) return res.status(409).json({ error: 'This attempt is no longer the active attempt for this research run.', reason: result.reason || 'not-current-attempt' });
        return res.status(200).json({ ok: true, leaseExpiresAt: result.run?.lease_expires_at });
      }
      if (researchRunAction === 'complete' || researchRunAction === 'fail') {
        const researchRunId = clean(body.researchRunId || '');
        const attemptId = clean(body.attemptId || '');
        if (!researchRunId || !attemptId) return res.status(400).json({ error: 'researchRunId and attemptId are required.' });
        const result = researchRunAction === 'complete'
          ? await completeResearchRunAttempt({ uploadId: targetUploadId, researchRunId, attemptId, resultSummary: body.resultSummary || {} })
          : await failResearchRunAttempt({ uploadId: targetUploadId, researchRunId, attemptId, errorMessage: body.errorMessage || '' });
        // applied:false is not an error -- it means a newer attempt already
        // took over this run (item 4: a late result from a
        // reclaimed/expired attempt must not overwrite the replacement
        // attempt's state).
        return res.status(200).json({ ok: true, applied: result.applied });
      }
      if (researchRunAction === 'check-duplicates') {
        // Duplicate-company research control (beta round): read-only,
        // best-effort bookkeeping action, gated by the exact same
        // uploadOwner resolution every other researchRunAction above already
        // requires -- no new authorization surface. accountNames is
        // optional: an explicit list checks only those account names; when
        // omitted, every account currently on this upload is checked (the
        // caller doesn't need to know in advance which single account, or
        // whole list, it is about to dispatch).
        const requestedNames = Array.isArray(body.accountNames)
          ? body.accountNames.map(n => clean(n)).filter(Boolean)
          : null;
        let namesToCheck = requestedNames;
        if (!namesToCheck) {
          try {
            const ownAccounts = await rbSupabase(`ha_accounts?upload_id=eq.${encodeURIComponent(targetUploadId)}&select=account_name`);
            namesToCheck = (Array.isArray(ownAccounts) ? ownAccounts : []).map(a => a.account_name).filter(Boolean);
          } catch (err) {
            // Fail open (item 4): if we cannot even determine which of this
            // upload's own accounts to check, report zero duplicates rather
            // than blocking the caller from proceeding.
            console.warn('[research-batch] duplicate-company check: could not load this upload\'s own accounts; failing open', { uploadId: targetUploadId, message: err && err.message });
            return res.status(200).json({ ok: true, duplicateAccountNames: [], scope: uploadOwner.organization_id ? 'organization' : 'user', checkFailed: true });
          }
        }
        const collisions = await findActiveDuplicateCompanyCollisions({ userId: uploadOwner.id, organizationId: uploadOwner.organization_id, uploadId: targetUploadId });
        const duplicateAccountNames = namesToCheck.filter(name => collisions.has(normalizeCompanyName(name)));
        return res.status(200).json({ ok: true, duplicateAccountNames, scope: uploadOwner.organization_id ? 'organization' : 'user' });
      }
      return res.status(400).json({ error: `Unknown researchRunAction "${researchRunAction}".` });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'Research run tracking request failed.' });
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'OPENAI_API_KEY not configured' });

  // Declared outside the try block so the finally clause below can always
  // stop it, regardless of which return path is taken inside try (there are
  // several -- the no-accounts 400, the success 200, and the catch's 500).
  let heartbeatLoop = null;

  try {
    const { accounts = [], mode = 'ranked', researchRunId = '' } = body;

    // Phase 2A implementation-review ROUND 4, item 2: ANY request bound to
    // an existing upload (uploadId present) must carry a real,
    // server-issued researchRunId AND attemptId -- there is no more
    // untracked-but-uploadId-bound path. This applies uniformly to the
    // automatic batch call, every per-account fallback call, AND the
    // standalone single-account "Research Account" button, which now
    // claims its own manual research run before ever reaching this
    // endpoint (see dashboard/index.html's researchAccountByName()). The
    // only remaining untracked callers are ones that send NO uploadId at
    // all -- the anonymous prospecting flow (prospect_script.js) -- which
    // never reaches this block (see the `if (targetUploadId)` gate above).
    const attemptId = clean(body.attemptId || '');
    const rawResearchRunId = clean(researchRunId);
    if (targetUploadId) {
      if (!attemptId || !rawResearchRunId) {
        return res.status(400).json({ error: 'researchRunId and attemptId are required for any research request bound to an existing upload.' });
      }
    }
    const runId = rawResearchRunId || `unattributed-${startedAt}`;

    if (targetUploadId) {
      const gate = await heartbeatResearchRunAtomic({ userId: uploadOwner.id, uploadId: targetUploadId, researchRunId: runId, attemptId });
      if (!gate.ok) {
        // A stale/replaced attempt is rejected HERE -- before
        // discoverCandidatesForAccounts/callOpenAIJson/callOpenAIWebSearch
        // are ever reached below -- so no provider cost is incurred.
        return res.status(409).json({ error: 'This attempt is no longer the active research run; no provider request was made.', reason: gate.reason || 'not-current-attempt' });
      }
      // Item 1: renew the lease periodically for the duration of THIS
      // request's provider work, so a legitimate long-running batch call
      // (the real Phase 1B fallback ran ~12 minutes) does not lose
      // ownership purely because a fixed lease elapsed.
      heartbeatLoop = startHeartbeatRenewalLoop({ userId: uploadOwner.id, uploadId: targetUploadId, researchRunId: runId, attemptId });
    }

    const seenAccountKeys = new Set();
    let safeAccounts = (Array.isArray(accounts) ? accounts : [])
      .filter(a => a && a.name)
      .map((a, idx) => ({
        id: String(idx),
        name: clean(a.name),
        industry: clean(a.industry || ''),
        location: clean(a.cityState || a.location || ''),
        cityState: clean(a.cityState || a.location || ''),
        notes: clean(a.notes || ''),
        // Falls back to a non-free contact email's domain ONLY when no
        // website was uploaded -- an explicit account.website always wins.
        // See domainFromContactEmail()'s header comment for why this is
        // deliberately narrow (fallback-only, first-valid-contact, no
        // parent-vs-target-company disambiguation).
        website: clean(a.website || '') || (Array.isArray(a.contacts) ? (a.contacts.map(c => domainFromContactEmail(c?.email)).find(Boolean) || '') : ''),
        // Identity-bootstrap provenance (in-memory only, never persisted --
        // safeAccounts itself is a per-request shape, not a DB row): an
        // uploaded website is the user directly asserting "this is my
        // company's site." A contact-email-derived domain only proves an
        // ORGANIZATIONAL relationship (the contact's employer's domain) --
        // it does not by itself prove every page on that domain belongs
        // specifically to this account (see domainFromContactEmail()'s own
        // known-limitation comment: a shared dealer-group domain is the
        // live, proven case). buildDerivedIdentity() below reads this to
        // decide whether a page's content needs to explicitly re-establish
        // account-specificity (always true for 'contact-derived') before it
        // can be trusted as an identity source.
        websiteProvenance: clean(a.website || '') ? 'uploaded' : ((Array.isArray(a.contacts) && a.contacts.some(c => domainFromContactEmail(c?.email))) ? 'contact-derived' : ''),
        categories: Array.isArray(a.categories) ? a.categories.slice(0, 10) : [],
        contacts: Array.isArray(a.contacts) ? a.contacts.slice(0, 12) : [],
        // Core defect fix: see pairedPurchases()'s header comment -- both
        // fields hold the identical paired shape; recentPurchases feeds the
        // live model's own prompt context (accountPromptContext() below),
        // purchases feeds findLikelyRelatedPurchase()'s deterministic
        // recent-past fulfillment check.
        recentPurchases: pairedPurchases(a),
        purchases: pairedPurchases(a),
        oneOffResearch: a.oneOffResearch === true,
        contactName: clean(a.contactName || (Array.isArray(a.contacts) ? a.contacts[0]?.name : '') || ''),
        recentOrderDates: Array.isArray(a.recentOrderDates) ? a.recentOrderDates.slice(0, 5) : [],
        repeatPatterns: Array.isArray(a.repeatPatterns) ? a.repeatPatterns.slice(0, 5) : [],
        existingSignals: Array.isArray(a.existingSignals) ? a.existingSignals.slice(0, 5) : [],
        relationshipStrength: a.relationshipStrength || a.relationshipScore || '',
        quickWinScore: a.quickWinScore || '',
        revenue: Number(a.revenue || 0),
        orderCount: Number(a.orderCount || 0)
      }))
      .filter(a => {
        const key = a.name.toLowerCase().replace(/\b(incorporated|inc|llc|ltd|limited|corp|corporation|co|company)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim() || a.name.toLowerCase();
        if (seenAccountKeys.has(key)) return false;
        seenAccountKeys.add(key);
        return true;
      })
      .slice(0, Math.max(1, Math.min(Number(process.env.RESEARCH_BATCH_MAX_ACCOUNTS || 250), 500)));
    if (!safeAccounts.length) return res.status(400).json({ error: 'No accounts provided' });

    // Duplicate-company research control (beta round): the authoritative
    // enforcement point -- "at the production research dispatch point,
    // before provider work begins." Every caller (individual research, list
    // research, the automatic batch pass, and the per-account fallback loop)
    // ultimately reaches this exact point before any OpenAI/Serper/Firecrawl
    // call below. dashboard/index.html's callers also pre-check via the
    // researchRunAction:'check-duplicates' action above and normally never
    // send an already-known-colliding account here at all; this re-check is
    // deliberate defense-in-depth for the narrow race window between that
    // check and this request (another run claiming the same company in
    // between), and is what makes the protection authoritative rather than
    // purely advisory. Only reachable for uploadId-bound requests -- the
    // anonymous prospecting flow (no uploadId, no authenticated owner) has no
    // cross-upload identity to check against and is unaffected.
    let skippedDuplicateAccountNames = [];
    if (targetUploadId) {
      const collisions = await findActiveDuplicateCompanyCollisions({ userId: uploadOwner.id, organizationId: uploadOwner.organization_id, uploadId: targetUploadId });
      if (collisions.size) {
        const kept = [];
        for (const account of safeAccounts) {
          if (collisions.has(normalizeCompanyName(account.name))) skippedDuplicateAccountNames.push(account.name);
          else kept.push(account);
        }
        safeAccounts = kept;
      }
      // Target-granularity correction round, requirement 4: this run's own
      // stored target set must reflect the FINAL, authoritative researchable
      // set -- not whatever the client originally claimed with -- and this
      // update must land before any provider call below. Otherwise this run
      // would keep blocking another upload's request for a company it
      // ultimately never actually researched (e.g. every account skipped as
      // a duplicate here, or dropped by the same-request dedup above).
      // Written even when safeAccounts is now empty (an explicit [] release).
      // Fails open: a failed update is logged and never blocks dispatch.
      await persistRunTargetCompanyKeys({
        userId: uploadOwner.id,
        uploadId: targetUploadId,
        researchRunId: runId,
        attemptId,
        targetCompanyKeys: sanitizeTargetCompanyKeys(safeAccounts.map(a => a.name))
      });
    }
    if (!safeAccounts.length) {
      // Every requested account was a currently-active duplicate elsewhere
      // in scope -- an honest, distinct, non-error outcome (item 4: this is
      // spend protection, not a reason to make research unavailable or to
      // surface a scary generic failure). Never falls through to the
      // generic "No accounts provided" 400 above.
      return res.status(200).json({
        ok: true,
        byAccount: {},
        signals: [],
        skippedDuplicateAccountNames,
        allAccountsSkippedAsDuplicates: true,
        message: 'Every requested account is already being actively researched from another uploaded list. We skipped duplicate research for now.'
      });
    }

    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    let candidates = [];
    let sourceCoverage = {};
    let candidateSamples = [];
    let searchDiagnostics = [];
    // Identity-bootstrap sprint: declared here, in the SAME outer scope as
    // `candidates` above, not inside the `if (hasSearchProvider)` block below
    // -- that block is a plain `{...}`, not a function, so a `const` declared
    // inside it goes out of scope the moment the block closes. The signal-
    // mapping/grounding loop that reads this map runs well after that block
    // closes (confirmed production defect: "derivedIdentityByAccount is not
    // defined", thrown the instant any mixed/warm-account request with a
    // configured search provider reached the grounding step). Defaults to an
    // empty Map so the no-search-provider branch (hasSearchProvider === false)
    // -- which never runs the block that would populate it -- still reads a
    // safe, empty result instead of throwing.
    let derivedIdentityByAccount = new Map();
    // Founder QA follow-up (identity-bootstrap live-diagnosis, fd2b221 QA):
    // the endpoint regression test proved the pipeline works end to end
    // against a synthetic fixture, but the live Dover Honda run returned
    // "no verified signals" with the identity states unchanged, and NOTHING
    // in the existing response lets anyone tell WHERE in the multi-stage
    // funnel (domain derivation -> owned-domain discovery -> Firecrawl
    // enrichment -> location extraction) that happened -- searchDiagnostics
    // is built inside discoverCandidatesForAccounts() BEFORE Firecrawl
    // enrichment ever runs, so its own enrichedPages field is always 0 and
    // says nothing about this pipeline. Populated below, once per account,
    // from the SAME real candidates/derivedIdentityByAccount this request
    // already computed -- adds no provider call, no new query, no DB
    // write, and is never read by grounding itself (diagnostic-only,
    // truthful reflection of what already happened).
    let identityBootstrapDiagnostics = [];
    let rawText = '';
    // Diagnostics semantic correction (Sprint 1 follow-up): this default
    // used to read 'openai-web-search' because, before this commit, a
    // request with no search provider configured always fell through to
    // callOpenAIWebSearch() -- the value was an accurate prediction of what
    // would run. Since the zero-candidate branch no longer calls that
    // function at all (see synthesisMode below), 'openai-web-search' would
    // now claim a provider call happened when it did not. providerMode
    // describes DISCOVERY strategy attempted, not synthesis outcome --
    // synthesisMode/fallbackSkippedReason are the fields that answer
    // "did an OpenAI call actually happen."
    let providerMode = 'no-search-provider';
    // Commercial-readiness core validation, item 1: accumulated across this
    // single handler invocation, then logged and returned -- never a
    // separate metering system, just the totals this run's own provider
    // calls already report.
    const openaiUsage = { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let firecrawlAttempted = 0;
    let firecrawlScraped = 0;
    // A failed OpenAI call throws and aborts the whole request (existing,
    // unchanged behavior) before the normal success-path usage log below is
    // ever reached -- log the partial usage (including the failure count)
    // right here, at the point of failure, so a failed run is not silently
    // invisible to the usage report.
    function logProviderUsageOnFailure() {
      try {
        console.log('[research-batch.provider-usage]', JSON.stringify({
          userId: uploadOwner?.id || null,
          run: { uploadId: targetUploadId || null, researchRunId: runId, mode, elapsedMs: Date.now() - startedAt, accountsAttempted: safeAccounts.length, failed: true },
          openai: { ...openaiUsage, model },
          serper: { configured: serperConfigured, queries: searchDiagnostics.reduce((sum, d) => sum + (d.targetedQueriesRun || 0), 0), failedQueries: searchDiagnostics.reduce((sum, d) => sum + (Array.isArray(d.queries) ? d.queries.filter(q => q.error).length : 0), 0) },
          firecrawl: { configured: !!process.env.FIRECRAWL_API_KEY, requests: firecrawlAttempted, successes: firecrawlScraped, failures: Math.max(0, firecrawlAttempted - firecrawlScraped) }
        }));
      } catch { /* logging must never mask the real error */ }
    }

    // Prospect Intelligence uses Serper for intent-driven targeted search.
    // Tavily/Brave are intentionally not required for this beta workflow.
    const serperConfigured = !!process.env.SERPER_API_KEY;
    const targetedSearchEnabled = mode === 'prospect-intelligence' && serperConfigured;
    const hasSearchProvider = serperConfigured;
    if (mode === 'prospect-intelligence' || mode === 'warm-account') {
      prospectDebugLog('Request received', {
        // Benchmark diagnostic (scale/research-runtime-benchmark): the t0
        // anchor every other stage-timing elapsedMs in this request is
        // measured against. Near-zero by construction; present for
        // consistency with the other checkpoints below.
        elapsedMs: Date.now() - startedAt,
        mode,
        accountsReceived: accounts.length,
        uniqueAccountsResearched: safeAccounts.length,
        providerMode: hasSearchProvider ? 'serper-targeted-search' : 'no-search-provider',
        serperConfigured,
        targetedSearchEnabled,
        firecrawlConfigured: !!process.env.FIRECRAWL_API_KEY,
        supabaseReuse: 'none - /api/research-batch does not read cached prospect rows before researching'
      });
    }
    if (hasSearchProvider) {
      providerMode = 'targeted-search';
      const discovered = await discoverCandidatesForAccounts(safeAccounts, mode);
      candidates = discovered.candidates;
      sourceCoverage = discovered.sourceCoverage;
      candidateSamples = discovered.samples.slice(0, 16);
      searchDiagnostics = discovered.diagnostics || [];
      // Identity-bootstrap sprint: reorder (never filter/add/remove) so a
      // candidate that already shows real, pre-fetch identity specificity on
      // an account's own trusted domain gets first claim on
      // enrichCandidatesWithFirecrawl()'s per-account slots -- SAME total
      // call ceiling, just spent on the candidate most likely to yield
      // account-specific official evidence instead of losing that slot to
      // an unrelated higher-scoring result.
      const safeAccountsByName = new Map(safeAccounts.map(a => [a.name, a]));
      candidates = prioritizeIdentityBootstrapCandidates(candidates, safeAccountsByName);
      const preEnrichmentCandidates = candidates;
      const enriched = await enrichCandidatesWithFirecrawl(candidates);
      candidates = enriched.candidates;
      firecrawlAttempted = enriched.attemptedCount || 0;
      firecrawlScraped = enriched.scrapedCount || 0;
      if (enriched.scrapedCount) sourceCoverage.firecrawl = enriched.scrapedCount;
      // Identity-bootstrap sprint: build EPHEMERAL derived identity per
      // account from the now-enriched candidate pool -- in-memory only for
      // this request, never persisted (see buildDerivedIdentity()'s own
      // header comment for the full ordering/non-circularity rationale).
      derivedIdentityByAccount = new Map(
        safeAccounts.map(a => [a.name, buildDerivedIdentity(a, candidates.filter(c => c && c.accountName === a.name))])
      );
      // Live-diagnosis fields (see this block's own header comment above):
      // isolates each of the funnel's real narrowing points using the exact
      // same domain-match rule buildDerivedIdentity()/
      // prioritizeIdentityBootstrapCandidates() already apply, so this can
      // never disagree with what those functions actually did.
      identityBootstrapDiagnostics = safeAccounts.map(a => {
        const domain = clean(a.website || '');
        if (!domain) return { accountName: a.name, domain: '', domainProvenance: '', ownedDomainCandidatesDiscovered: [], ownedDomainCandidatesEnriched: [], preFetchNameMatchCount: 0, derivedIdentity: null, failureReason: 'no-domain-derivable-from-upload-or-contact-email' };
        const ownsDomain = (url) => { const d = sourceDomain(url || ''); return !!d && (d === domain || d.endsWith(`.${domain}`)); };
        const ownedPre = preEnrichmentCandidates.filter(c => c && c.accountName === a.name && ownsDomain(c.url));
        const ownedPost = candidates.filter(c => c && c.accountName === a.name && ownsDomain(c.url));
        const ownedEnriched = ownedPost.filter(c => !!c.pageContent);
        const preFetchNameMatchCount = ownedPre.filter(c => `${c.title || ''} ${c.snippet || ''}`.toLowerCase().includes(a.name.toLowerCase())).length;
        const derived = derivedIdentityByAccount.get(a.name) || null;
        let failureReason = '';
        if (!derived) {
          if (!ownedPre.length) failureReason = 'no-owned-domain-candidate-discovered-by-search-or-owned-page-probe';
          else if (!ownedEnriched.length) failureReason = 'owned-domain-candidate-discovered-but-none-received-firecrawl-enrichment';
          else failureReason = 'owned-domain-content-fetched-but-no-name-associated-location-extracted';
        }
        return {
          accountName: a.name,
          domain,
          domainProvenance: a.websiteProvenance || '',
          ownedDomainCandidatesDiscovered: ownedPre.map(c => c.url),
          preFetchNameMatchCount,
          ownedDomainCandidatesEnriched: ownedEnriched.map(c => ({ url: c.url, pageContentRawSample: (c.pageContentRaw || c.pageContent || '').slice(0, 500) })),
          // Live-diagnosis round 2 (extraction-stage detail): only computed
          // once discovery/enrichment already both succeeded (failureReason
          // above is the owned-domain-content-fetched-but-no-... case) --
          // see diagnoseAccountLocationExtraction()'s own header comment in
          // signal-intelligence.js for why this mirrors, rather than calls
          // into, the real extractor.
          extractionDetail: ownedEnriched.map(c => ({
            url: c.url,
            ...diagnoseAccountLocationExtraction(a.name, c.pageContentRaw || c.pageContent || '')
          })),
          derivedIdentity: derived,
          failureReason
        };
      });
      if (mode === 'prospect-intelligence' || mode === 'warm-account') {
        prospectDebugLog('Firecrawl enrichment complete', {
          // Benchmark diagnostic (scale/research-runtime-benchmark): see the
          // 'Request received' comment above. This is the last checkpoint
          // BEFORE the single whole-batch OpenAI synthesis call -- if a
          // timed-out invocation's logs show this line but never show
          // 'OpenAI synthesis starting' or 'LLM opportunity parser complete'
          // below, the time was spent between here and the OpenAI call
          // actually being dispatched (prompt-string construction, which is
          // synchronous and should be sub-millisecond) rather than inside
          // OpenAI itself.
          elapsedMs: Date.now() - startedAt,
          firecrawlCalled: !!process.env.FIRECRAWL_API_KEY && candidates.length > 0,
          candidatesSentToFirecrawl: candidates.length,
          scrapedCount: enriched.scrapedCount || 0
        });
      }
    } else if (mode === 'prospect-intelligence') {
      prospectDebugLog('Targeted search skipped', {
        mode,
        serperConfigured,
        targetedSearchEnabled,
        reason: 'SERPER_API_KEY is not configured. Prospect research will use OpenAI web-search fallback instead of Serper intent-driven query chains.'
      });
    }

    let parsed = null;
    // Sprint 1 controlled-beta policy (fail-closed, intentional): every
    // signal callOpenAIWebSearch() could produce here would carry no
    // discovered candidate to resolve against, so requireResolvedCandidate()
    // rejects it with certainty (see the header comment above that function
    // below). Before this policy, the candidates.length===0 branch still
    // called callOpenAIWebSearch() and paid its full latency/cost for output
    // that Sprint 1 already guarantees gets discarded -- synthesisMode below
    // records which branch actually ran, distinct from providerMode (which
    // describes DISCOVERY strategy, not synthesis outcome).
    let synthesisMode = 'candidate-backed';
    let fallbackSkippedReason = '';
    if (candidates.length) {
      const synthesisPrompt = buildSynthesisPrompt(safeAccounts, candidates);
      // Prompt-size fix (scale/research-runtime-benchmark): removed
      // score/intendedSignalFamily/entityVerification/sourceAuthorityScore/
      // freshnessScore/candidateScore/eventFingerprint from what is SENT to
      // the model -- all seven are this pipeline's OWN internal
      // ranking/dedup bookkeeping (already fully applied earlier: filtering,
      // scoring, clusterCandidates()'s event-level dedup, and the
      // slice(0,30)/slice(0,180) caps all already happened using these
      // values). None of them are evidence text the synthesis prompt's own
      // instructions ask the model to read or weigh -- the prompt already
      // has its own actionability/budget/deadline scoring instructions and
      // never references our internal scores. Removing them loses no
      // evidence the model could act on, only non-evidentiary metadata that
      // existed for OUR selection logic, not the model's reasoning. `score`
      // (discoverCandidatesForAccounts()'s own ranking) and `candidateScore`
      // (clusterCandidates()'s final sort) are both still computed and used
      // internally exactly as before -- only their inclusion in the
      // OUTBOUND prompt payload changed.
      // Benchmark diagnostic (scale/research-runtime-benchmark): the one
      // genuine gap in existing checkpoint logging -- nothing previously
      // marked the moment the single whole-batch OpenAI call actually
      // starts. callOpenAIJson()/callOpenAIWebSearch() have no timeout and
      // no retry (see api/research-batch.js's own architecture), so this is
      // the single most likely place a request approaches the 58s ceiling.
      // If a timed-out invocation's logs show this line but never show 'LLM
      // opportunity parser complete', the OpenAI call itself is where the
      // time went.
      if (mode === 'prospect-intelligence' || mode === 'warm-account') {
        prospectDebugLog('OpenAI synthesis starting', {
          elapsedMs: Date.now() - startedAt,
          candidateCount: candidates.length,
          promptChars: synthesisPrompt.length
        });
      }
      try {
        // Phase 1 monitoring-architecture foundation: the deadline-check-
        // then-call decision itself now lives in runBudgetedSynthesis()
        // (api/lib/research-pipeline.js), parameterized rather than reading
        // the module constants directly -- byte-identical logic, same
        // constants passed explicitly, so this call site's behavior is
        // unchanged. This is what lets a future background worker request
        // its own, independently larger budget without touching this file.
        const result = await runBudgetedSynthesis({
          prompt: synthesisPrompt, apiKey, model, startedAt,
          requestDeadlineMs: REQUEST_DEADLINE_MS,
          minUsefulOpenAiMs: MIN_USEFUL_OPENAI_MS,
          openAiCallMaxMs: OPENAI_CALL_MAX_MS,
          callOpenAIJson
        });
        rawText = result.text;
        openaiUsage.calls += 1;
        openaiUsage.inputTokens += result.usage.inputTokens;
        openaiUsage.outputTokens += result.usage.outputTokens;
        openaiUsage.totalTokens += result.usage.totalTokens;
      } catch (err) {
        openaiUsage.failures += 1;
        logProviderUsageOnFailure();
        throw err;
      }
      parsed = parseJsonLoose(rawText);
    } else {
      // Controlled-beta trust-over-recall policy: candidate-backed discovery
      // (Serper/Firecrawl) found nothing for this request, so there is no
      // independently-sourced evidence for verifyCandidateCompanyGrounding()
      // to check a synthesized signal against. callOpenAIWebSearch() is
      // deliberately NOT called here -- it is left fully intact in this file
      // (still callable, still useful for a future properly-scoped grounded
      // sparse-account fallback) but calling it from THIS branch would only
      // spend real OpenAI web-search latency and cost on output
      // requireResolvedCandidate() is guaranteed to reject, since a
      // candidate-less citation can never resolve to a discovered candidate.
      // This is "research completed, no independently grounded opportunity
      // found" -- not a claim that no opportunity exists, and not a
      // provider/runtime failure -- so it proceeds through the exact same
      // successful empty-result response a genuinely dry candidate-backed
      // account already takes, just without the wasted call.
      synthesisMode = 'no-candidate-evidence';
      fallbackSkippedReason = 'no candidate-backed evidence discovered';
      parsed = { signals: [] };
      sourceCoverage['no-candidate-evidence'] = safeAccounts.length;
      if (mode === 'prospect-intelligence' || mode === 'warm-account') {
        prospectDebugLog('OpenAI synthesis skipped', {
          elapsedMs: Date.now() - startedAt,
          candidateCount: 0,
          synthesisMode,
          reason: fallbackSkippedReason
        });
      }
    }

    const { signals, rawSignals, mappedSignals, validMappedSignals } = mapSignalsFromModelOutput({
      parsed, mode, startedAt, providerMode, candidates, safeAccounts, derivedIdentityByAccount, runId
    });
    if (mode === 'prospect-intelligence' || mode === 'warm-account') {
      prospectDebugLog('Signal filtering complete', {
        rawSignals: rawSignals.length,
        mappedSignals: mappedSignals.length,
        invalidAccountSignalsFiltered: Math.max(0, mappedSignals.length - validMappedSignals.length),
        dedupedSignals: signals.length,
        signalsByAccountBeforeFallback: safeAccounts.map(a => ({
          company: a.name,
          liveSignals: signals.filter(s => s.accountName === a.name).length
        }))
      });
      for (const account of safeAccounts) {
        if (/sparkfun/i.test(account.name)) {
          const rawForAccount = rawSignals.filter(s => clean(s.accountName || s.account || s.company || s.company_name || s.companyName || '').toLowerCase().includes(account.name.toLowerCase()) || account.name.toLowerCase().includes(clean(s.accountName || s.account || s.company || s.company_name || s.companyName || '').toLowerCase()));
          const filteredForAccount = signals.filter(s => s.accountName === account.name);
          prospectDebugLog('SparkFun LLM/filtering diagnostics', {
            mode,
            company: account.name,
            candidatesPassedToLLM: candidates.filter(c => c.accountName === account.name).length,
            llmOutput: rawForAccount.slice(0, 3),
            filteringResult: {
              rawSignalsForCompany: rawForAccount.length,
              liveSignalsAfterFiltering: filteredForAccount.length,
              liveSignalTitles: filteredForAccount.map(s => s.concreteTrigger || s.signalTitle || s.whatChanged || s.signalType)
            },
            fallbackWouldBeUsed: filteredForAccount.length === 0
          });
        }
      }
    }
    const byAccount = {};
    for (const sig of signals) {
      if (!byAccount[sig.accountName]) byAccount[sig.accountName] = [];
      if (byAccount[sig.accountName].length < 4) byAccount[sig.accountName].push(sig);
    }
    Object.keys(byAccount).forEach(name => {
      const ranked = byAccount[name].sort(compareBestSignals);
      byAccount[name] = ranked.slice(0, 4);
    });
    if (mode === 'prospect-intelligence') {
      for (const account of safeAccounts) {
        if (!byAccount[account.name] || !byAccount[account.name].length) {
          const accountDiag = searchDiagnostics.find(d => d.companyName === account.name) || {};
          const fallbackReason = !hasSearchProvider
            ? 'SERPER_API_KEY not configured; no live signal returned by OpenAI web search'
            : candidates.filter(c => c.accountName === account.name).length === 0
              ? 'targeted search completed but returned no ranked candidates above threshold'
              : 'targeted search candidates were passed to LLM but no valid live opportunity survived parsing/filtering';
          prospectDebugLog('Fallback used', {
            company: account.name,
            fallbackUsed: true,
            fallbackReason,
            targetedQueriesRun: accountDiag.targetedQueriesRun || 0,
            rankedCandidates: accountDiag.rankedCandidates || 0,
            topResults: accountDiag.topSources || []
          });
          byAccount[account.name] = [makePredictableTimingSignal(account)];
        } else {
          prospectDebugLog('Live opportunity generated', {
            company: account.name,
            fallbackUsed: false,
            liveOpportunityCount: byAccount[account.name].length,
            opportunities: byAccount[account.name].map(s => ({
              trigger: s.concreteTrigger || s.signalTitle || s.whatChanged || s.signalType,
              signalType: s.signalType,
              confidenceScore: s.confidenceScore,
              rankingScore: Math.round(bestSignalScore(s)),
              publishedDate: s.publishedDate || s.eventDate || s.event_date || '',
              sourceUrl: s.sourceUrl
            }))
          });
        }
      }
    }
    const finalSignals = Object.values(byAccount).flat().sort(compareBestSignals);
    const avgConfidence = finalSignals.length ? Math.round(finalSignals.reduce((sum, s) => sum + Number(s.confidenceScore || 0), 0) / finalSignals.length) : 0;

    // Commercial-readiness core validation, item 1: the smallest reliable
    // per-run usage rollup -- reuses searchDiagnostics (already computed per
    // account above, including targetedQueriesRun and per-query
    // serperHttpStatus/error) rather than adding a second parallel counting
    // mechanism. No API keys, headers, or raw provider response bodies are
    // included -- only counts, token totals, elapsed time, and business
    // identifiers (account/upload/run ids) already used throughout this
    // file's existing debug logging (prospectDebugLog).
    const serperQueries = searchDiagnostics.reduce((sum, d) => sum + (d.targetedQueriesRun || 0), 0);
    const serperFailedQueries = searchDiagnostics.reduce((sum, d) => sum + (Array.isArray(d.queries) ? d.queries.filter(q => q.error).length : 0), 0);
    const accountsWithSignalsCount = new Set(finalSignals.filter(s => !s.isFallbackOpportunity).map(s => s.accountName)).size;
    const providerUsage = {
      run: {
        uploadId: targetUploadId || null,
        researchRunId: runId,
        mode,
        elapsedMs: Date.now() - startedAt,
        accountsAttempted: safeAccounts.length,
        accountsWithSignals: accountsWithSignalsCount,
        accountsWithNoSignals: Math.max(0, safeAccounts.length - accountsWithSignalsCount),
        signalsProduced: finalSignals.filter(s => !s.isFallbackOpportunity).length
      },
      openai: { ...openaiUsage, model },
      serper: { configured: serperConfigured, queries: serperQueries, failedQueries: serperFailedQueries },
      firecrawl: { configured: !!process.env.FIRECRAWL_API_KEY, requests: firecrawlAttempted, successes: firecrawlScraped, failures: Math.max(0, firecrawlAttempted - firecrawlScraped) }
    };
    try {
      console.log('[research-batch.provider-usage]', JSON.stringify({ userId: uploadOwner?.id || null, ...providerUsage }));
    } catch { /* logging must never fail the request */ }

    // Note: this endpoint no longer marks any ha_research_runs row
    // completed/failed itself. Under the round-2 design (item 3/4), a
    // logical research run can span multiple requests to this endpoint (the
    // fallback loop makes up to 4 concurrent per-account calls under one
    // shared attempt), so only the orchestrator that made the 'claim' call
    // knows when the WHOLE run has finished -- see researchTopAccounts() in
    // dashboard/index.html, which calls researchRunAction:'complete'/'fail'
    // explicitly once the entire pass (batch call + any fallback loop) is
    // done.

    return res.status(200).json({
      signals: finalSignals,
      byAccount,
      researchRunId: runId,
      // Duplicate-company research control: accounts that were requested but
      // excluded from safeAccounts above because a matching company already
      // had active research elsewhere in scope. Always present (empty array
      // when nothing was skipped) so callers can reliably distinguish "this
      // account has zero real signals" from "this account was never actually
      // researched" -- the two must never be conflated (a skipped duplicate
      // must not be marked researched or have an empty result persisted).
      skippedDuplicateAccountNames,
      providerUsage,
      diagnostics: {
        elapsedMs: Date.now() - startedAt,
        model,
        providerMode,
        synthesisMode,
        fallbackSkippedReason,
        accountsReceived: accounts.length,
        accountsResearched: safeAccounts.length,
        rankedCandidates: candidates.length,
        rawSignals: rawSignals.length,
        signalsDiscovered: rawSignals.length,
        signalsRejected: Math.max(0, rawSignals.length - finalSignals.length),
        signalsReturned: finalSignals.length,
        highConfidenceOpportunities: finalSignals.filter(s => !s.isFallbackOpportunity && Number(s.confidenceScore || 0) >= 80).length,
        mediumConfidenceOpportunities: finalSignals.filter(s => !s.isFallbackOpportunity && Number(s.confidenceScore || 0) >= 60 && Number(s.confidenceScore || 0) < 80).length,
        predictableTimingOpportunities: finalSignals.filter(s => s.isFallbackOpportunity).length,
        liveSignalsFound: finalSignals.filter(s => !s.isFallbackOpportunity).length,
        accountsWithSignals: new Set(finalSignals.filter(s => !s.isFallbackOpportunity).map(s => s.accountName)).size,
        accountsWithNoSignals: Math.max(0, safeAccounts.length - new Set(finalSignals.filter(s => !s.isFallbackOpportunity).map(s => s.accountName)).size),
        avgConfidence,
        webSearchEnabled: !hasSearchProvider,
        targetedSearchEnabled,
        mode,
        sourceCoverage,
        candidateSamples,
        searchDiagnostics,
        identityBootstrapDiagnostics,
        outputPreview: String(rawText || '').slice(0, 500),
        structuredSummary: {
          eligibleAccounts: safeAccounts.length,
          queuedAccounts: safeAccounts.length,
          processedAccounts: searchDiagnostics.filter(d => d.status === 'processed').length || safeAccounts.length,
          skippedAccounts: Math.max(0, accounts.length - safeAccounts.length),
          failedAccounts: searchDiagnostics.filter(d => d.status === 'failed').length,
          skipReasons: accounts.length > safeAccounts.length ? [{ reason: 'duplicate_or_invalid_account_name', count: accounts.length - safeAccounts.length }] : [],
          failureReasons: searchDiagnostics.filter(d => d.status === 'failed').map(d => ({ accountName: d.companyName, reason: d.error || 'unknown' })),
          queriesRun: searchDiagnostics.reduce((n, d) => n + Number(d.targetedQueriesRun || 0), 0),
          rawResults: searchDiagnostics.reduce((n, d) => n + Number(d.sourcesReturned || 0), 0),
          uniqueCandidates: candidates.length,
          enrichedPages: candidates.filter(c => c.pageContent).length,
          acceptedSignals: finalSignals.length,
          totalProcessingTimeMs: Date.now() - startedAt
        }
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Batch research failed', diagnostics: { elapsedMs: Date.now() - startedAt } });
  } finally {
    heartbeatLoop?.stop();
  }
}

// Named exports for testability (Phase 2A / B3 classification tests, and
// Phase 2A implementation-review round 2's run-claim/lease tests).
export {
  makeSignal, resolveCanonicalEventType, resolveAuthenticatedUploadOwner, resolveAuthenticatedCaller, claimResearchRunAtomic,
  completeResearchRunAttempt, failResearchRunAttempt, heartbeatResearchRunAtomic, clampLeaseSeconds, safeSecretEqual,
  signalEventCategory, resolveSignalEventDate, computeActionability, oneHistoricalOrderFact,
  salesReadyOpener, salesReadyWhy, EVENT_LIKE_TYPES, compact,
  canonicalTemplateFamily, contextToOpener, contextToPromoWhy, promoCategoriesForMoment, inferRecommendedBuyingTeam, buildBusinessContext,
  hasTrustworthyActionabilityMetadata, classifyLegacySignalActionability,
  openaiUsageFromResponse, enrichCandidatesWithFirecrawl,
  resolveDuplicateCheckScopeUserIds, findActiveDuplicateCompanyCollisions,
  sanitizeTargetCompanyKeys, persistRunTargetCompanyKeys,
  queryTemplates, domainFromContactEmail, priorityOwnedPages,
  buildDerivedIdentity, prioritizeIdentityBootstrapCandidates,
  pairedPurchases, accountPromptContext,
  // Phase 1 monitoring-architecture foundation: exported so a future
  // background Queue worker can import these directly (in-process, no HTTP
  // self-call into this endpoint) -- discoverCandidatesForAccounts,
  // callOpenAIJson, and mapLimit were already standalone/request-response-
  // free; only their export was missing. The budget constants are exported
  // so the interactive endpoint's own current values are the single source
  // of truth a worker's own (larger) budget is explicitly compared against
  // in tests, rather than a second, potentially-drifting hardcoded copy.
  // See api/lib/research-pipeline.js for the one piece that needed actual
  // new logic (runBudgetedSynthesis), not just an export.
  discoverCandidatesForAccounts, callOpenAIJson, mapLimit,
  REQUEST_DEADLINE_MS, MIN_USEFUL_OPENAI_MS, OPENAI_CALL_MAX_MS,
  // Phase 2A worker-readiness: the extracted parse/map/validate/grounding/
  // event-resolution tail, and the prompt-builder it depends on -- see
  // their own header comments above.
  mapSignalsFromModelOutput, buildSynthesisPrompt, parseJsonLoose,
  // Find More Like Them V1: additive-only export, same pattern as the
  // Phase 1 worker-readiness exports above -- serperSearch is already a
  // standalone, request/response-free function (no behavior change) reused
  // by api/lib/lookalike-discovery.js for its own candidate-name-discovery
  // queries, rather than a second, duplicated Serper-calling implementation.
  serperSearch
};
