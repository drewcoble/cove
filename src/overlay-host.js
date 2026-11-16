// Shows Cove's search over the current page. Injected by the service worker only when you open
// search (it is not a manifest content script, so sites keep their own Cmd/Ctrl+K).
//
// It draws a dimmed backdrop and an iframe of the extension's launcher page inside a closed
// shadow root. The page can't reach into either: the shadow root is closed and the frame is
// a cross-origin extension page, so the site never sees your tabs, pins, history, or what you
// type. All this script knows is the one-time token it passes to the frame.
(() => {
  if (globalThis.__coveSearch) return;

  let host = null;
  let previousFocus = null;

  const STYLE = `
    :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; }
    .backdrop { position: fixed; inset: 0; background: rgba(16, 12, 24, 0.32); backdrop-filter: blur(2px); }
    iframe {
      position: fixed; left: 50%; top: clamp(16px, 14vh, 140px); transform: translateX(-50%);
      width: min(660px, calc(100vw - 32px)); height: min(500px, calc(100vh - 40px));
      border: 0; border-radius: 18px; color-scheme: light dark; background: transparent;
      box-shadow: 0 28px 100px -20px rgba(12, 7, 19, 0.45), 0 3px 15px rgba(12, 7, 19, 0.12);
    }`;

  function close(notify) {
    if (!host) return;
    host.remove();
    host = null;
    removeEventListener('keydown', onKey, true);
    if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
    if (notify) chrome.runtime.sendMessage({ type: 'overlayClosed' }).catch(() => {});
  }

  // Esc before the frame has focus (it takes focus as soon as it loads).
  function onKey(event) {
    if (event.key === 'Escape' && event.isTrusted) {
      event.stopPropagation();
      close(true);
    }
  }

  function open(token, mode) {
    close(false);
    previousFocus = document.activeElement;
    host = document.createElement('cove-search');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';
    backdrop.addEventListener('click', event => event.isTrusted && close(true));
    const frame = document.createElement('iframe');
    frame.title = 'Cove search';
    frame.src = `${chrome.runtime.getURL('src/launcher.html')}#${new URLSearchParams({ token, mode, view: 'overlay' })}`;
    frame.addEventListener('load', () => frame.focus());
    root.append(style, backdrop, frame);
    document.documentElement.append(host);
    addEventListener('keydown', onKey, true);
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id === chrome.runtime.id && !sender.tab && msg?.type === 'coveCloseSearch') close(false);
  });

  globalThis.__coveSearch = { open };
})();
