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
