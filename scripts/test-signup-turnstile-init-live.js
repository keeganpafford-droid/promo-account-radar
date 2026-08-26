// Founder Preview QA blocker fix (2026-08-26): the Turnstile widget on
// signup.html could permanently never initialize. Root cause: the
// Cloudflare script tag loaded with `async` (which, combined with the
// prior `defer` attribute, actually behaves as pure `async` -- per the
// HTML spec, `async` wins when both are present) means Cloudflare can
// finish loading and invoke its `onload=onTurnstileLoad` callback at ANY
// time relative to the later, plain <script src="/signup-form.js"> tag
// that used to be the ONLY place window.onTurnstileLoad was defined. If
// Cloudflare called back before that script had run, the callback simply
// didn't exist yet -- a one-shot invocation with no retry -- and nothing
// else in the old code re-triggered a render attempt once BOTH the script
// and the site-key fetch later became independently available.
//
// The fix: define window.onTurnstileLoad in a tiny INLINE script in
// signup.html, placed BEFORE the Turnstile <script> tag (inline scripts
// execute synchronously as the parser reaches them, so this one is
// guaranteed to exist by the time the async script can possibly call
// back), and make signup-form.js's own init idempotent and callable from
// either of the two independent readiness signals (the script, the site-
// key fetch) in EITHER order, plus a load-failure timeout so the user is
// never stuck on "please wait" forever if Turnstile genuinely can't load.
//
// This file exercises the REAL, unmodified signup.html/signup-form.js via
// a real Chromium page, with a FAKE Turnstile script (mirroring the real
// challenges.cloudflare.com/turnstile/v0/api.js contract closely enough:
// it defines window.turnstile.{render,reset} and invokes the onload=
// callback named in its own query string) and a mocked
// /api/auth?action=turnstile-config response -- both served with
// controllable delays via Playwright route interception, so both possible
// completion orders are exercised deterministically, not by chance.
//
// Usage: node scripts/test-signup-turnstile-init-live.js
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

const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
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

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// A minimal fake Turnstile script -- close enough to the real contract for
// this test's purpose: exposes window.turnstile.render()/.reset(), and
// calls the onload callback named in its own ?onload= query param (exactly
// like the real challenges.cloudflare.com/turnstile/v0/api.js does) once
// this fake script itself finishes "loading" server-side (the artificial
// scriptDelayMs below models Cloudflare's own real network+init latency).
// render() marks the container visibly and fires the success callback
// shortly after, mirroring the always-pass Cloudflare test site key's
// real-world behavior (the same 1x00000000000000000000AA credential the
// founder configured on Preview).
function fakeTurnstileScriptBody() {
  return `
    window.turnstile = {
      render: function(container, opts){
        var el = (typeof container === 'string') ? document.querySelector(container) : container;
        if (el) el.innerHTML = '<div id="fakeTurnstileWidget">verified</div>';
        setTimeout(function(){ if (opts && opts.callback) opts.callback('fake-turnstile-token'); }, 20);
        return 'fake-widget-id';
      },
      reset: function(){}
    };
    var params = new URLSearchParams(document.currentScript.src.split('?')[1] || '');
    var cb = params.get('onload');
    if (cb && typeof window[cb] === 'function') window[cb]();
  `;
}

async function withPage(baseUrl, { scriptDelayMs = 0, configDelayMs = 0, blockScript = false, initTimeoutMs = 300 } = {}, run) {
  const browser = await chromium.launch({ executablePath: resolveChromiumExecutablePath() });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(String(err)));

    // Shorten the real 12s load-failure timeout for the test -- see
    // signup-form.js's own comment on window.__turnstileInitTimeoutMs.
    await page.addInitScript((ms) => { window.__turnstileInitTimeoutMs = ms; }, initTimeoutMs);

    await page.route('**/challenges.cloudflare.com/turnstile/v0/api.js**', async route => {
      if (blockScript) { await route.abort(); return; }
      if (scriptDelayMs) await delay(scriptDelayMs);
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: fakeTurnstileScriptBody() });
    });

    const signupRequests = [];
    await page.route('**/api/auth**', async route => {
      const req = route.request();
      const url = new URL(req.url());
      signupRequests.push({ method: req.method(), action: url.searchParams.get('action') || (req.postData() ? JSON.parse(req.postData()).action : null) });
      if (req.method() === 'GET' && url.searchParams.get('action') === 'turnstile-config') {
        if (configDelayMs) await delay(configDelayMs);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, siteKey: 'test-site-key' }) });
      }
      // A real signup POST -- not the focus of this file (see
      // scripts/test-signup-abuse-remediation.js for that coverage), just
      // needs a 200 so we can observe that one was actually attempted with
      // a non-empty turnstileToken.
      const body = JSON.parse(req.postData() || '{}');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, session: { access_token: 'tok', refresh_token: 'rtok', expires_in: 3600 }, user: { email: body.email || '' } }) });
    });

    // domcontentloaded, not 'load' -- Chromium's `load` event waits for
    // ALL sub-resources including in-flight `async` scripts to finish (a
    // real, if easy to misremember, platform behavior: `async` exempts a
    // script from blocking `DOMContentLoaded`, not `load`). With `load`,
    // page.goto() itself would silently absorb the artificial script/config
    // delays below before this function even returns -- meaning every
    // interaction that follows would always run AFTER both signals had
    // already resolved, defeating the entire point of testing both
    // orderings. A real user's browser also makes the page interactive at
    // DOMContentLoaded, not `load`, so this is the more realistic choice
    // regardless.
    await page.goto(`${baseUrl}/signup.html`, { waitUntil: 'domcontentloaded' });
    await run(page, { pageErrors, signupRequests });
  } finally {
    await browser.close();
  }
}

async function fillLegitForm(page) {
  await page.fill('input[name="name"]', 'Jamie Rivera');
  await page.fill('input[name="organizationName"]', 'Rivera Promotional Products');
  await page.selectOption('select[name="role"]', 'Owner');
  await page.fill('input[name="house_accounts"]', '50');
  await page.fill('input[name="email"]', 'jamie@example.com');
  await page.fill('input[name="password"]', 'Sup3rSecret!1');
}

async function main() {
  const server = await startStaticServer();
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1) Turnstile script becomes ready BEFORE the config fetch resolves.
    // initTimeoutMs is deliberately given generous margin above the larger
    // artificial delay (200ms) -- a load-failure timeout close to the
    // actual load time would race the legitimate success path (real
    // network/event-loop overhead can push either one first), which is a
    // property of any timeout-based fallback, not a bug in the widget
    // logic itself; tests 1-3 all keep that margin comfortably wide.
    await withPage(baseUrl, { scriptDelayMs: 20, configDelayMs: 200, initTimeoutMs: 2000 }, async (page, { pageErrors, signupRequests }) => {
      await page.waitForSelector('#fakeTurnstileWidget', { timeout: 5000 });
      assert(true, '1) script-ready-first: the widget still renders once the slower config fetch catches up');
      await fillLegitForm(page);
      await page.click('#signupSubmit');
      await page.waitForTimeout(300);
      const signupPost = signupRequests.find(r => r.method === 'POST' && r.action === 'signup');
      assert(Boolean(signupPost), '1) script-ready-first: submitting after both signals resolve actually sends the signup request (a token was available)');
      assert(pageErrors.length === 0, `1) script-ready-first: no console/page errors (got: ${JSON.stringify(pageErrors)})`);
    });

    // 2) The config fetch resolves BEFORE the Turnstile script becomes
    // ready -- the exact ordering that could previously leave the widget
    // permanently unrendered.
    await withPage(baseUrl, { scriptDelayMs: 200, configDelayMs: 20, initTimeoutMs: 2000 }, async (page, { pageErrors, signupRequests }) => {
      await page.waitForSelector('#fakeTurnstileWidget', { timeout: 5000 });
      assert(true, '2) config-ready-first: the widget still renders once the slower script catches up (the founder QA blocker\'s exact shape)');
      await fillLegitForm(page);
      await page.click('#signupSubmit');
      await page.waitForTimeout(300);
      const signupPost = signupRequests.find(r => r.method === 'POST' && r.action === 'signup');
      assert(Boolean(signupPost), '2) config-ready-first: submitting after both signals resolve actually sends the signup request');
      assert(pageErrors.length === 0, `2) config-ready-first: no console/page errors (got: ${JSON.stringify(pageErrors)})`);
    });

    // 3) Turnstile genuinely never loads (script request blocked/fails) --
    // the user must see a clear failure message, not be stuck on "please
    // wait" forever, once the (shortened, for this test) timeout elapses.
    await withPage(baseUrl, { blockScript: true }, async (page) => {
      const message = page.locator('#signupMessage');
      await page.waitForFunction(() => {
        const el = document.getElementById('signupMessage');
        return el && /could not load verification/i.test(el.textContent || '');
      }, { timeout: 5000 });
      assert(true, '3) Turnstile fails to load entirely: a distinct "could not load verification" message appears once the timeout elapses');
      await fillLegitForm(page);
      await page.click('#signupSubmit');
      const text = await message.textContent();
      assert(/could not load verification/i.test(text || ''), `3) submitting after a load failure still shows the load-failure message, not the generic "please wait" one (got "${text}")`);
    });

    // 4) Sanity: before either signal resolves, submitting shows the
    // "still loading" message (not the load-failure one), and no signup
    // request is ever sent. Both artificial delays and the timeout are
    // given margin comfortably above the real time filling the form and
    // clicking submit actually takes (now that page.goto() uses
    // domcontentloaded rather than load, that real time is on the order of
    // tens of ms, not seconds).
    await withPage(baseUrl, { scriptDelayMs: 1500, configDelayMs: 1500, initTimeoutMs: 3000 }, async (page, { signupRequests }) => {
      await fillLegitForm(page);
      await page.click('#signupSubmit');
      await page.waitForTimeout(50);
      const text = await page.locator('#signupMessage').textContent();
      assert(/please wait a moment/i.test(text || ''), `4) submitting before Turnstile is ready shows the "please wait" message, not a false failure (got "${text}")`);
      const signupPost = signupRequests.find(r => r.method === 'POST' && r.action === 'signup');
      assert(!signupPost, '4) no signup request is ever sent while verification has not yet completed');
    });
  } finally {
    server.close();
  }
}

await main();
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
if (failures) process.exitCode = 1;
