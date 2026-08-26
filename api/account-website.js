// Find More Like Them V1 correction (2026-08-26, Founder Preview QA): the
// canonical, narrow way to save a company website for an EXISTING account
// -- specifically so a rep can supply the missing identity anchor
// api/find-similar-companies.js now requires, inline, without navigating
// away or restarting that workflow. Not a general "account completeness"
// endpoint; it only ever touches one field.
//
// STORAGE MODEL (do not invent a new one): ha_accounts has no website
// column and never has. website is canonically raw_data.website -- a JSONB
// key, populated today only via CSV upload column aliases
// (website/website_url/company_website/domain/company_domain/url, see
// dashboard/index.html's UPLOAD_ALIASES). This endpoint writes into that
// exact same field, so the improvement benefits Core (research grounding,
// Monitoring Identity resolution, the dashboard's own website display) as
// well as this feature -- not a parallel field only this page reads.
//
// IDENTITY (corrected 2026-08-26, Founder QA -- an earlier version of this
// file matched by account_name across the whole organization and is WRONG,
// left here as the record of why): api/find-similar-companies.js's own
// account fetch is org-wide (every active user's ha_accounts, matching
// api/get-dashboard.js's TEAM-view scope), not scoped to one rep. Two
// different reps can legitimately have two different companies that happen
// to share a display name (a common risk with franchises/generic business
// names) -- name-based fan-out would silently write one rep's entered
// website onto a different, unrelated company. get-dashboard.js's own
// byAccount.set(a.account_name, ...) dedup-by-name is a DISPLAY
// convenience for one rep's own repeat-upload history; it is not an
// identity guarantee this endpoint may reuse for a write. Every other
// account-metadata write in this codebase (dashboard/index.html's
// saveAccountMetadataEdit()/saveCurrentUpload()) identifies the account by
// (uploadId, account_name) -- ha_accounts's own unique constraint -- never
// by name alone, org-wide. This endpoint now matches that precedent: it
// writes to exactly the ONE ha_accounts row api/find-similar-companies.js
// itself already resolved as "the seed" (its real, stable id, passed
// through in missingWebsiteSeeds[].accountId), verified to belong to the
// caller's own organization. It does not fan out to any other row that
// happens to share the same name, including this same rep's own older
// duplicate uploads -- narrower than the previous version, deliberately.
//
// Read-modify-write, not a raw column replace: raw_data carries many other
// keys (contacts, location, intelligenceMode, ...) a PATCH with only
// {website} would silently destroy. The row's current raw_data is fetched
// immediately before the write and merged.
import { normalizeDomain } from './lib/monitoring-identity.js';

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
// Same shape as api/find-similar-companies.js's/api/prospect-one-off.js's
// own context() -- resolves the caller to a real ha_users row and their
// organization's active user id set, so the write below can never touch a
// row outside the caller's own organization.
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

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    const ctx = await context(req);
    if (!ctx) return json(res, 401, { error: 'Authentication required' });

    const body = req.body || {};
    const accountId = clean(body.accountId);
    if (!accountId) return json(res, 400, { error: 'accountId is required' });

    const normalized = normalizeDomain(body.website);
    if (!normalized) return json(res, 400, { error: 'Please enter a valid website (e.g. companywebsite.com).' });

    if (!ctx.userIds.length) return json(res, 404, { error: 'Account not found.' });

    // Scoped to the caller's own organization (org-isolation guard,
    // unchanged) AND to the exact row id the seed already resolved to --
    // never a broader name match. limit=1 is structural, not a safety net:
    // id is ha_accounts's own primary key, so at most one row can ever
    // match.
    const rows = await sb(`ha_accounts?id=eq.${encodeURIComponent(accountId)}&user_id=${inFilter(ctx.userIds)}&select=id,raw_data&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return json(res, 404, { error: 'Account not found.' });

    const rawData = (row.raw_data && typeof row.raw_data === 'object') ? row.raw_data : {};
    await sb(`ha_accounts?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: JSON.stringify({ raw_data: { ...rawData, website: normalized } })
    });

    return json(res, 200, { ok: true, website: normalized });
  } catch (err) {
    console.error('[account-website]', err);
    return json(res, 500, { error: err.message || 'Could not save website' });
  }
}
