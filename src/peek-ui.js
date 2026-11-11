// Injected into a Peek's page (on every load) by the service worker: a small floating toolbar
// plus Esc to close and ⌘↩ / Ctrl+Enter to keep it as a tab. The Peek is either a popup window
// or, in full screen, a temporary tab.
(() => {
  if (window.__covePeek) return;
  // dismiss(): the Peek was kept as a tab, so drop the toolbar and the Esc / ⌘↩ keys.
  const state = { active: true, dismiss: () => ((state.active = false), host.remove()) };
  window.__covePeek = state;

  const send = type => chrome.runtime.sendMessage({ type }).catch(() => {});
  const icon = d =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

  const host = document.createElement('cove-peek');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; position: fixed; top: 10px; right: 10px; z-index: 2147483647; }
      .bar {
        display: flex; gap: 2px; padding: 3px; border-radius: 10px;
        background: rgba(32, 32, 36, 0.86); backdrop-filter: blur(10px);
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3); opacity: 0.55; transition: opacity 0.15s;
      }
      .bar:hover { opacity: 1; }
      button {
        all: unset; width: 26px; height: 26px; display: grid; place-items: center;
        border-radius: 7px; color: #eee; cursor: default;
      }
      button:hover { background: rgba(255, 255, 255, 0.14); }
      svg { width: 15px; height: 15px; }
    </style>
    <div class="bar">
      <button data-type="peekExpand" title="Open as tab (⌘↩)">${icon(
        '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
      )}</button>
      <button data-type="peekClose" title="Close (Esc)">${icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>')}</button>
    </div>`;
  root.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (btn) send(btn.dataset.type);
  });
  document.documentElement.append(host);

  // Bubble phase, so a page that handles Esc itself (closing its own modal) keeps it.
  window.addEventListener('keydown', e => {
    if (!state.active) return;
    if (e.key === 'Escape' && !e.defaultPrevented) send('peekClose');
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send('peekExpand');
    }
  });
})();
