// Find More Like Them V1 -- live-navigation regression coverage for the new
// Preview surface (real Chromium, real find-similar-companies.html, real
// site-header.js/site-header.css served over http, not file://). Same
// harness convention as scripts/test-whitespace-cell-answers-live.js (see
// that file's own header comment for why a real static server + real
// unstubbed site-header.js is used, and why auth-client.js itself is
// replaced with a minimal stub exposing only the functions this page
// actually calls -- getUser()/authHeadersAsync() -- rather than simulating
// the full auth backend).
//
// Exercises the whole Founder-Preview surface end to end against a fully
// mocked /api/find-similar-companies and /api/prospect-one-off: seed
// selection (including the 3-seed cap), the request this page actually
// sends, result-card rendering (both a grounded-reason-to-reach-out
// candidate and an honest no-signal candidate), the excluded-count note,
// and the "Save to Target Accounts" action reusing the existing, unmodified
// api/prospect-one-off.js endpoint.
//
// Usage: node scripts/test-find-similar-companies-page-live.js
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import http from 'http';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else { failures += 1; console.error(`FAIL: ${message}`); }
}

function resolveChromiumExecutablePath() {
  const candidate = '/opt/pw-browsers/chromium';
  return existsSync(candidate) ? candidate : undefined;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8'
};
function startStaticServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        let filePath = path.join(REPO_ROOT, urlPath);
        if (urlPath.endsWith('/')) filePath = path.join(filePath, 'index.html');
        if (!filePath.startsWith(REPO_ROOT)) { res.writeHead(403); res.end(); return; }
        if (!existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(readFileSync(filePath));
      } catch (err) { res.writeHead(500); res.end(String(err)); }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const DASHBOARD_ACCOUNTS = [
  { name: 'Ridgeline Apparel', relationshipMode: 'Warm' },
  { name: 'Summit Gear Co', relationshipMode: '' },
  { name: 'Alpine Outfitters', relationshipMode: 'Cold' },
  { name: 'Basecamp Supply', relationshipMode: '' }
];

const FIND_SIMILAR_RESPONSE = {
  ok: true,
  seeds: [{ seedName: 'Ridgeline Apparel', seedProfile: {}, queries: [], excluded: [] }],
  results: [
    {
      company: 'Peak Outfitters', seedCompany: 'Ridgeline Apparel', relationshipType: 'Industry Peer',
      whySimilar: 'Surfaced as a peer in the same specific business (Outdoor Retail) as Ridgeline Apparel.',
      similarityEvidence: 'Peak Outfitters and Basecamp Goods are often named as Ridgeline Apparel competitors.',
      similaritySourceUrl: 'https://example.com/competitors',
      reasonToReachOut: { title: 'Peak Outfitters held a ribbon cutting for its new distribution center', whyItMatters: 'A new distribution center typically means fresh onboarding and opening-day merchandise needs.', sourceUrl: 'https://www.businesswire.com/peak-outfitters-new-facility', sourceName: 'businesswire.com' },
      hasCurrentReasonToReachOut: true, allSignals: [{ accountName: 'Peak Outfitters' }], researchCoverage: 'complete', researchError: null
    },
    {
      company: 'Northface Trail Co', seedCompany: 'Ridgeline Apparel', relationshipType: 'Nearby Opportunity',
      whySimilar: 'Nearby Opportunity: found in Ridgeline Apparel\'s own market (Denver, CO) -- geography alone, not a claim of same industry or business type.',
      similarityEvidence: null, similaritySourceUrl: null,
      reasonToReachOut: null, hasCurrentReasonToReachOut: false, allSignals: [], researchCoverage: 'complete', researchError: null
    }
  ],
  excluded: [{ name: 'Summit Gear Co', reason: 'already-an-existing-customer' }],
  missingSeeds: [], candidateCount: 2
};

let findSimilarCalls = [];
let prospectOneOffCalls = [];
let accountWebsiteCalls = [];
// Starts false so the FIRST /api/find-similar-companies call reproduces the
// real founder-reported blocker: a selected seed with no known website, and
// the server's own guided (not error) response. Set true by the mocked
// /api/account-website route once a save succeeds, so the SECOND call (the
// page's own auto-continue) returns the normal happy-path result -- proving
// the whole "add website inline -> continue without restarting" loop end to
// end against the real page, not just the server contract.
let websiteSaved = false;

async function withPage(baseUrl, run) {
  const browser = await chromium.launch({ executablePath: resolveChromiumExecutablePath() });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));

    await page.addInitScript(() => {
      localStorage.setItem('haAuthSession', JSON.stringify({ access_token: 'test-token-fmlt' }));
    });

    await page.route('**/auth-client.js', route => route.fulfill({
      status: 200, contentType: 'text/javascript',
      body: `window.HouseAuth = {
        getUser: () => ({ email: 'qa@example.com', name: 'QA Tester' }),
        authHeadersAsync: async (h) => ({...(h||{}), Authorization: 'Bearer test-token-fmlt'}),
        authHeaders: (h) => ({...(h||{}), Authorization: 'Bearer test-token-fmlt'})
      };`
    }));

    await page.route('**/api/get-dashboard**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ accounts: DASHBOARD_ACCOUNTS })
    }));

    await page.route('**/api/find-similar-companies', async route => {
      findSimilarCalls.push(JSON.parse(route.request().postData() || '{}'));
      if (!websiteSaved) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          ok: false,
          missingWebsiteSeeds: [{ name: 'Ridgeline Apparel', accountId: 'acct-ridgeline-1' }],
          error: 'A website helps House Accounts identify the right company and find more accurate matches.'
        }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIND_SIMILAR_RESPONSE) });
    });

    await page.route('**/api/account-website', async route => {
      const body = JSON.parse(route.request().postData() || '{}');
      accountWebsiteCalls.push(body);
      websiteSaved = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, website: 'ridgeline.com' }) });
    });

    await page.route('**/api/prospect-one-off', async route => {
      prospectOneOffCalls.push(JSON.parse(route.request().postData() || '{}'));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await run(page, pageErrors);
  } finally {
    await browser.close();
  }
}

async function run() {
  const server = await startStaticServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await withPage(baseUrl, async (page, pageErrors) => {
      await page.goto(`${baseUrl}/find-similar-companies.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#seedList .seed-row', { timeout: 10000 });

      const seedRowCount = await page.locator('#seedList .seed-row').count();
      assert(seedRowCount === DASHBOARD_ACCOUNTS.length, `1) all ${DASHBOARD_ACCOUNTS.length} of the org's real accounts render as seed candidates (got ${seedRowCount})`);

      const warmBadgeText = await page.locator('#seedList .seed-row', { hasText: 'Ridgeline Apparel' }).locator('.seed-badge').textContent();
      assert(warmBadgeText.trim() === 'Warm', '2) relationshipMode renders as a non-selecting hint badge on the seed row');

      assert(await page.locator('#findBtn').isDisabled(), '3) the Find button starts disabled with nothing selected');

      // Select 4 seeds -- the 4th must be rejected by the client-side cap,
      // matching the server's own MAX_SEEDS=3 (defense in depth, not a
      // second source of truth for the limit itself).
      const checkboxes = page.locator('#seedList input[type="checkbox"]');
      for (let i = 0; i < 4; i++) await checkboxes.nth(i).click();
      const checkedCount = await page.locator('#seedList input[type="checkbox"]:checked').count();
      assert(checkedCount === 3, `4) REQUIRED: selecting a 4th seed is rejected client-side -- at most 3 stay checked (got ${checkedCount})`);
      assert((await page.locator('#status').textContent()).includes('at most 3'), '5) the cap rejection is explained to the user, not silently ignored');

      await page.locator('#findBtn').click();

      // Founder Preview QA correction (2026-08-26): the first real call
      // reproduces the actual reported blocker -- a selected seed with no
      // known website. The server's own guided response (not an error)
      // must render as an inline, plain-language prompt right here, and
      // results must NOT render yet.
      await page.waitForSelector('.missing-website-card', { timeout: 10000 });
      assert(findSimilarCalls.length === 1, '6) clicking Find Companies Like This calls /api/find-similar-companies exactly once');
      const sentSeeds = findSimilarCalls[0]?.seedAccountNames || [];
      assert(sentSeeds.length === 3 && sentSeeds.every(n => DASHBOARD_ACCOUNTS.some(a => a.name === n)), `7) the request carries exactly the 3 explicitly-selected real seed names (got ${JSON.stringify(sentSeeds)})`);
      assert(await page.locator('.result-card').count() === 0, '8) REQUIRED: no result cards render while a required seed website is missing');

      const missingCard = page.locator('.missing-website-card');
      assert(await missingCard.count() === 1, `9) exactly one missing-website card renders, matching the one seed the server named (got ${await missingCard.count()})`);
      assert((await missingCard.locator('h3').textContent()).includes('website'), '10) the card heading matches the founder-specified copy ("Add ... website")');
      assert((await missingCard.locator('p').textContent()).trim() === 'A website helps House Accounts identify the right company and find more accurate matches.', '11) REQUIRED: the exact founder-specified explanatory copy renders, no database terminology substituted in');
      assert(await missingCard.locator('input').getAttribute('placeholder') === 'companywebsite.com', '12) the input placeholder matches the founder-specified example');
      assert((await missingCard.locator('button').textContent()).replace(/\s+/g, ' ').trim() === 'Save & Continue', '13) the action button reads exactly "Save & Continue"');

      await missingCard.locator('input').fill('ridgeline.com');
      await missingCard.locator('button', { hasText: 'Save' }).click();

      // Saving must both persist the website AND continue the SAME search
      // automatically -- no restart, no re-picking seeds -- landing on the
      // real result cards from the (now website-aware) second call.
      await page.waitForSelector('.result-card', { timeout: 10000 });
      assert(accountWebsiteCalls.length === 1, '14) REQUIRED: saving calls the new /api/account-website endpoint exactly once');
      assert(accountWebsiteCalls[0]?.accountId === 'acct-ridgeline-1' && accountWebsiteCalls[0]?.website === 'ridgeline.com', `15) REQUIRED (Founder QA identity correction): the save call carries the specific resolved accountId (never just the account name) and the entered website (got ${JSON.stringify(accountWebsiteCalls[0])})`);
      assert(await page.locator('.missing-website-card').count() === 0, '16) the missing-website prompt is gone once resolved');
      assert(findSimilarCalls.length === 2, '17) REQUIRED: the lookalike search continues automatically after the save -- a second call happens with no further click from the user');
      assert(JSON.stringify(findSimilarCalls[1]?.seedAccountNames) === JSON.stringify(sentSeeds), '18) REQUIRED: the continued search reuses the exact same seed selection -- the workflow is not restarted');

      const cardCount = await page.locator('.result-card').count();
      assert(cardCount === 2, `19) both returned candidates render as result cards (got ${cardCount})`);

      const peakCard = page.locator('.result-card', { hasText: 'Peak Outfitters' });
      assert(await peakCard.locator('.seed-tag').textContent().then(t => t.includes('Ridgeline Apparel')), '20) each card is clearly tagged with the seed customer it came from');
      assert(await peakCard.locator('.rank-badge').count() === 1, '21) a candidate with a grounded current signal shows the "Grounded reason to reach out" badge');
      assert((await peakCard.locator('.section-text').first().textContent()).includes('Outdoor Retail'), '22) the plain-English similarity explanation renders on the card');
      assert(await peakCard.locator('a.source-link').count() >= 1, '23) evidence/source links render for a grounded candidate');

      assert((await peakCard.locator('.relationship-badge').textContent()) === 'Industry Peer', '23b) REQUIRED (Founder QA Round 2): the candidate\'s relationshipType renders as a plain category badge, not a fabricated number/score');

      const northfaceCard = page.locator('.result-card', { hasText: 'Northface Trail Co' });
      assert(await northfaceCard.locator('.rank-badge').count() === 0, '24) a candidate with no current signal does NOT show the grounded-reason badge');
      assert((await northfaceCard.locator('.relationship-badge').textContent()) === 'Nearby Opportunity', '24b) REQUIRED: a local-lens candidate is labeled "Nearby Opportunity" on the page, never claiming industry similarity');
      assert((await northfaceCard.locator('.no-signal').textContent()).includes('No current, timely public signal'), '25) REQUIRED: the no-signal candidate is represented honestly on the page, not dropped or fabricated');

      const excludedNoteText = await page.locator('.excluded-note').textContent();
      assert(excludedNoteText.includes('1 candidate(s) excluded'), '26) the excluded-candidate count is visible on the page, not silently hidden');

      await peakCard.locator('.save-btn').click();
      await page.waitForFunction(() => document.querySelector('.save-btn')?.textContent?.includes('Saved'), { timeout: 5000 });
      assert(prospectOneOffCalls.length === 1, '27) Save to Target Accounts calls the existing, unmodified /api/prospect-one-off endpoint exactly once');
      assert(prospectOneOffCalls[0]?.companyName === 'Peak Outfitters', '28) the save call carries the correct candidate company name');
      assert((await peakCard.locator('.save-btn').textContent()).includes('Saved'), '29) the button reflects the successful save back to the user');

      assert(pageErrors.length === 0, `30) REQUIRED: no uncaught page errors during the whole flow (got: ${pageErrors.join(' | ')})`);
    });
  } finally {
    server.close();
  }
}

await run();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
