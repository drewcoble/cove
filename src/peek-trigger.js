// Content script on every page:
//   - Option-click (Alt-click) a link to open it in Peek. Chrome's own Option-click behaviour
//     (download the link) is suppressed while that setting is on.
//   - In an Essential, a plain click on a link to another site opens it in Peek instead of
//     navigating the Essential away. The service worker sets __coveEssential on those tabs.

let enabled = true;

// Only the one setting this script needs is read here; it deliberately doesn't load the
// config or listen to storage changes, either of which would put your pinned URLs into
// every page. Live changes arrive as a message from the service worker.
chrome.storage.local.get('peekOnAltClick').then(({ peekOnAltClick }) => {
  enabled = peekOnAltClick ?? true;
});
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id === chrome.runtime.id && !sender.tab && msg?.type === 'peekPrefs') enabled = !!msg.peekOnAltClick;
});

// Rough registrable domain ("mail.google.com" -> "google.com", "bbc.co.uk" stays whole), so
// moving around inside one site isn't treated as leaving it.
function site(hostname) {
  const parts = hostname.split('.');
  const n = parts.length > 2 && parts.at(-1).length === 2 && parts.at(-2).length <= 3 ? 3 : 2;
  return parts.slice(-n).join('.');
}

window.addEventListener(
  'click',
  e => {
    // isTrusted: a page must not be able to open windows by synthesizing clicks.
    if (!e.isTrusted || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const link = e.composedPath().find(n => n instanceof HTMLAnchorElement && n.href);
    if (!link || !/^https?:/i.test(link.href) || link.hasAttribute('download')) return;
    const altPeek = enabled && e.altKey;
    const essentialPeek =
      !e.altKey && globalThis.__coveEssential === true && site(new URL(link.href).hostname) !== site(location.hostname);
    if (!altPeek && !essentialPeek) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    chrome.runtime.sendMessage({ type: 'peek', url: link.href }).catch(() => {});
  },
  true,
);
