// Signup input validation -- founder-directed bounded remediation
// (2026-08-25) after an observed automated public-signup spam pattern (a
// URL-shortener link injected into the Name field). Runs server-side in
// api/auth.js's signup branch, BEFORE any Supabase Admin API call or
// database write -- an invalid submission must be rejected outright, never
// silently sanitized into a junk account. Mirrors signup-form.js's
// meaningful client-side requirements (all fields but crm_erp required) and
// adds the hard caps/URL rejection the client never had.
//
// Pure functions only -- no I/O, no env reads -- so this is directly
// unit-testable without mocking Supabase/fetch.

const NAME_MIN = 2;
const NAME_MAX = 100;
const ORGANIZATION_NAME_MAX = 200;
const ROLE_MAX = 100;
const CRM_ERP_MAX = 100;
// Generous on purpose -- this is a self-reported, informational field (how
// many house accounts the signer manages), not an entitlement value (see
// api/lib/entitlement.js's FREE_ACCOUNT_CAPACITY for the real, separate
// monitored-account ceiling). The cap exists only to reject nonsense/
// overflow-shaped input, not to model any real business ceiling.
const HOUSE_ACCOUNTS_MAX = 100000;

// Matches an explicit, scheme-qualified or www-prefixed URL, or a known
// link-shortener domain (bare or scheme-qualified). Deliberately does NOT
// match a bare "word.tld"-shaped string on its own (e.g. "Cars.com",
// "Overstock.com Inc.") -- a legitimate brand/company name that happens to
// contain its own domain must never be rejected. This is the one signal
// used to reject a "URL/link payload" for both name and organizationName,
// per founder direction: reject an explicit link, never a bare
// domain-looking company name.
const URL_SCHEME_OR_WWW_RE = /(https?:\/\/|www\.)\S+/i;
const LINK_SHORTENER_RE = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|is\.gd|buff\.ly|ow\.ly|rebrand\.ly|cutt\.ly|shorturl\.at|rb\.gy|tiny\.cc)(\/\S*)?\b/i;

export function containsUrlPayload(value = '') {
  const v = String(value || '');
  return URL_SCHEME_OR_WWW_RE.test(v) || LINK_SHORTENER_RE.test(v);
}

function lengthError(fieldLabel, trimmedValue, min, max) {
  const len = trimmedValue.length;
  if (min != null && len < min) return `${fieldLabel} is too short.`;
  if (max != null && len > max) return `${fieldLabel} is too long.`;
  return null;
}

// Returns {valid:true} or {valid:false, error:'<user-facing message>'} --
// the first failing check wins, matching the existing single-message 400
// pattern the rest of api/auth.js already uses.
export function validateSignupProfile({ name, organizationName, role, crm_erp, house_accounts } = {}) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return { valid: false, error: 'Enter your name.' };
  if (containsUrlPayload(trimmedName)) return { valid: false, error: 'Name cannot contain a link or URL.' };
  const nameErr = lengthError('Name', trimmedName, NAME_MIN, NAME_MAX);
  if (nameErr) return { valid: false, error: nameErr };

  const trimmedOrg = String(organizationName || '').trim();
  if (!trimmedOrg) return { valid: false, error: 'Enter your company or organization.' };
  if (containsUrlPayload(trimmedOrg)) return { valid: false, error: 'Company / Organization cannot contain a link or URL.' };
  const orgErr = lengthError('Company / Organization', trimmedOrg, 1, ORGANIZATION_NAME_MAX);
  if (orgErr) return { valid: false, error: orgErr };

  const trimmedRole = String(role || '').trim();
  if (!trimmedRole) return { valid: false, error: 'Choose your role.' };
  const roleErr = lengthError('Role', trimmedRole, 1, ROLE_MAX);
  if (roleErr) return { valid: false, error: roleErr };

  const trimmedCrm = String(crm_erp || '').trim();
  if (trimmedCrm) {
    const crmErr = lengthError('CRM / ERP', trimmedCrm, 1, CRM_ERP_MAX);
    if (crmErr) return { valid: false, error: crmErr };
  }

  const houseAccountsNum = Number(house_accounts);
  if (!Number.isFinite(houseAccountsNum) || !Number.isInteger(houseAccountsNum) || houseAccountsNum <= 0) {
    return { valid: false, error: 'Enter a number of house accounts greater than zero.' };
  }
  if (houseAccountsNum > HOUSE_ACCOUNTS_MAX) {
    return { valid: false, error: 'Number of house accounts is too large.' };
  }

  return { valid: true };
}
