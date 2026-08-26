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
      company: 'Peak Outfitters', seedCompany: 'Ridgeline Apparel',
      whySimilar: 'Surfaced from a search for Outdoor Retail companies similar to Ridgeline Apparel.',
      similarityEvidence: 'Peak Outfitters and Basecamp Goods are often named as Ridgeline Apparel competitors.',
      similaritySourceUrl: 'https://example.com/competitors',
      reasonToReachOut: { title: 'Peak Outfitters held a ribbon cutting for its new distribution center', whyItMatters: 'A new distribution center typically means fresh onboarding and opening-day merchandise needs.', sourceUrl: 'https://www.businesswire.com/peak-outfitters-new-facility', sourceName: 'businesswire.com' },
      hasCurrentReasonToReachOut: true, allSignals: [{ accountName: 'Peak Outfitters' }], researchCoverage: 'complete', researchError: null
    },
    {
      company: 'Northface Trail Co', seedCompany: 'Ridgeline Apparel',
      whySimilar: 'Surfaced from a general competitors/alternatives search for Ridgeline Apparel.',
      similarityEvidence: null, similaritySourceUrl: null,
      reasonToReachOut: null, hasCurrentReasonToReachOut: false, allSignals: [], researchCoverage: 'complete', researchError: null
    }
  ],
  excluded: [{ name: 'Summit Gear Co', reason: 'already-an-existing-customer' }],
  missingSeeds: [], candidateCount: 2
};

let findSimilarCalls = [];
let prospectOneOffCalls = [];

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
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIND_SIMILAR_RESPONSE) });
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
      await page.waitForSelector('.result-card', { timeout: 10000 });

      assert(findSimilarCalls.length === 1, '6) clicking Find Companies Like This calls /api/find-similar-companies exactly once');
      const sentSeeds = findSimilarCalls[0]?.seedAccountNames || [];
      assert(sentSeeds.length === 3 && sentSeeds.every(n => DASHBOARD_ACCOUNTS.some(a => a.name === n)), `7) the request carries exactly the 3 explicitly-selected real seed names (got ${JSON.stringify(sentSeeds)})`);

      const cardCount = await page.locator('.result-card').count();
      assert(cardCount === 2, `8) both returned candidates render as result cards (got ${cardCount})`);

      const peakCard = page.locator('.result-card', { hasText: 'Peak Outfitters' });
      assert(await peakCard.locator('.seed-tag').textContent().then(t => t.includes('Ridgeline Apparel')), '9) each card is clearly tagged with the seed customer it came from');
      assert(await peakCard.locator('.rank-badge').count() === 1, '10) a candidate with a grounded current signal shows the "Grounded reason to reach out" badge');
      assert((await peakCard.locator('.section-text').first().textContent()).includes('Outdoor Retail'), '11) the plain-English similarity explanation renders on the card');
      assert(await peakCard.locator('a.source-link').count() >= 1, '12) evidence/source links render for a grounded candidate');

      const northfaceCard = page.locator('.result-card', { hasText: 'Northface Trail Co' });
      assert(await northfaceCard.locator('.rank-badge').count() === 0, '13) a candidate with no current signal does NOT show the grounded-reason badge');
      assert((await northfaceCard.locator('.no-signal').textContent()).includes('No current, timely public signal'), '14) REQUIRED: the no-signal candidate is represented honestly on the page, not dropped or fabricated');

      const excludedNoteText = await page.locator('.excluded-note').textContent();
      assert(excludedNoteText.includes('1 candidate(s) excluded'), '15) the excluded-candidate count is visible on the page, not silently hidden');

      await peakCard.locator('.save-btn').click();
      await page.waitForFunction(() => document.querySelector('.save-btn')?.textContent?.includes('Saved'), { timeout: 5000 });
      assert(prospectOneOffCalls.length === 1, '16) Save to Target Accounts calls the existing, unmodified /api/prospect-one-off endpoint exactly once');
      assert(prospectOneOffCalls[0]?.companyName === 'Peak Outfitters', '17) the save call carries the correct candidate company name');
      assert((await peakCard.locator('.save-btn').textContent()).includes('Saved'), '18) the button reflects the successful save back to the user');

      assert(pageErrors.length === 0, `19) REQUIRED: no uncaught page errors during the whole flow (got: ${pageErrors.join(' | ')})`);
    });
  } finally {
    server.close();
  }
}

await run();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
