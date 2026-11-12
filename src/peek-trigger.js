// Option-click explicitly opens Peek. Ordinary links leaving an Essential open
// as regular tabs in the currently selected space, preserving the Essential.
let enabled = true;
chrome.storage.local.get('peekOnAltClick').then(({ peekOnAltClick }) => {
  enabled = peekOnAltClick ?? true;
}).catch(() => {});
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && !sender.tab && message?.type === 'peekPrefs') enabled = !!message.peekOnAltClick;
});
// Initialize as early as possible on reload, rather than waiting for page load to finish.
try {
  chrome.runtime.sendMessage({ type: 'essentialStatus' }).then(response => {
    if (response?.ok && typeof globalThis.__coveEssential !== 'boolean') globalThis.__coveEssential = response.result;
  }).catch(() => {});
} catch { /* An extension reload can invalidate an older content-script context. */ }

// Rough registrable domain: keep in-app navigation (e.g. reading an email) in place.
function site(hostname) {
  const parts = hostname.split('.');
  const n = parts.length > 2 && parts.at(-1).length === 2 && parts.at(-2).length <= 3 ? 3 : 2;
  return parts.slice(-n).join('.');
}

window.addEventListener('click', event => {
  if (!event.isTrusted || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const link = event.composedPath().find(node => node instanceof HTMLAnchorElement && node.href);
  if (!link || !/^https?:/i.test(link.href) || link.hasAttribute('download')) return;
  const peek = enabled && event.altKey;
  const fromEssential = !event.altKey && globalThis.__coveEssential === true && site(new URL(link.href).hostname) !== site(location.hostname);
  if (!peek && !fromEssential) return;
  const url = link.href;
  const sourceUrl = location.href;
  event.preventDefault();
  event.stopImmediatePropagation();
  // Never swallow a real link if extension messaging or tab creation fails.
  const fallback = () => { if (location.href === sourceUrl) location.assign(url); };
  try {
    chrome.runtime.sendMessage({ type: peek ? 'peek' : 'openEssentialLink', url }).then(response => {
      if (!response?.ok) fallback();
    }).catch(fallback);
  } catch { fallback(); }
}, true);
