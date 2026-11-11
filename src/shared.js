// Helpers shared by the service worker and the side panel.

// Spaces map 1:1 onto Chrome tab-group colors so the tab strip matches the sidebar.
export const COLORS = {
  grey: '#9aa0a6',
  blue: '#8ab4f8',
  red: '#f28b82',
  yellow: '#fdd663',
  green: '#81c995',
  pink: '#ff8bcb',
  purple: '#c58af9',
  cyan: '#78d9ec',
  orange: '#fcad70',
};

export const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

export function normUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return url;
  }
}

export const sameUrl = (a, b) => !!a && !!b && normUrl(a) === normUrl(b);

// A pinned tab has "drifted" once it navigates away from its pinned URL. Redirects seen
// right after the pin was opened (gmail.com -> mail.google.com/mail/u/0) are stored as
// aliases so they don't count as drift.
export function isDrifted(pin, url) {
  if (!url || sameUrl(url, pin.url)) return false;
  return !(pin.aliases ?? []).some(a => sameUrl(a, url));
}

export function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url ?? '';
  }
}

// A custom name always wins, no matter where the tab has navigated to.
export function pinTitle(pin, tab) {
  return pin.title || tab?.title || pin.defaultTitle || hostname(pin.url);
}

export const isWebUrl = url => /^https?:/i.test(url ?? '');

// Query parameters that commonly carry sign-in codes, tokens or signatures.
const SENSITIVE_PARAM = /token|secret|passw|credential|signature|^sig$|^code$|^state$|^nonce$|^ticket$|^session|^sid$|^key$|api[-_]?key|^auth|saml|^otp$|^jwt$/i;

const SENSITIVE_HASH = /(^#|[#&?])(access_token|id_token|refresh_token|token|code|state)=/i;

// The URL minus any sensitive-looking query parameters, so sign-in callbacks like
// `/callback?code=…#access_token=…` never end up in storage or in exported setups.
// By default the #fragment is dropped too (for URLs Cove records on its own: redirect aliases,
// a pinned tab's last URL). With keepHash (a URL you're pinning) it's kept unless it carries
// a token, so app routes like `#/dashboard` still work.
export function redactUrl(url, { keepHash = false } = {}) {
  try {
    const u = new URL(url);
    if (!keepHash || SENSITIVE_HASH.test(u.hash)) u.hash = '';
    for (const key of [...u.searchParams.keys()]) if (SENSITIVE_PARAM.test(key)) u.searchParams.delete(key);
    return u.href;
  } catch {
    return '';
  }
}
