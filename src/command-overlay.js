// Runs in Chrome's isolated world. The page cannot access this state or the closed shadow root.
(() => {
  if (globalThis.__coveCommandOverlay) return;
  const extensionRoot = chrome.runtime.getURL('');
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  let token = null;
  let host, shadow, dialog, input, list, previousFocus;
  let snapshot, choices = [], selected = 0, mode = 'all', busy = false, composing = false, folder = false;
  let opening = false, version = 0, refreshTimer;
  let resources;
  const loadResources = () => resources ||= Promise.all([
    import(chrome.runtime.getURL('src/search-catalog.js')),
    import(chrome.runtime.getURL('src/search.js')),
    import(chrome.runtime.getURL('src/shared.js')),
    fetch(chrome.runtime.getURL('src/command-overlay.css')).then(r => { if (!r.ok) throw new Error('Could not load search.'); return r.text(); }),
  ]);
  const send = async (type, payload = {}) => {
    const response = await chrome.runtime.sendMessage({ type, token, ...payload });
    if (!response?.ok) throw new Error(response?.error || 'Could not complete this action. Try again.');
    return response.result;
  };
  const $ = selector => shadow.querySelector(selector);
  function focus() {
    if (!dialog?.open) return;
    (folder ? $('#folder-name') : input).focus({ preventScroll: true });
    if (!folder) input.select();
  }
  function close() {
    if (!token) return;
    const closingToken = token;
    token = null;
    version++;
    opening = false;
    clearTimeout(refreshTimer);
    dialog?.close();
    host?.remove();
    host = shadow = dialog = input = list = null;
    snapshot = null;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    chrome.runtime.sendMessage({ type: 'closeCommandOverlay', token: closingToken }).catch(() => {});
  }
  function error(reason) {
    if (!shadow) return;
    $('#error').textContent = reason?.message || String(reason);
    $('#error').hidden = false;
  }
  async function refresh() {
    if (!token || !shadow) return;
    const requestVersion = ++version;
    const data = await send('commandContext');
    if (requestVersion !== version || !token || !shadow) return;
    snapshot = data;
    render(true);
  }
  function schedule() {
    if (!token || opening) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refresh().catch(error), 50);
  }
  function selection(scroll = false) {
    if (!list) return;
    [...list.querySelectorAll('[role=option]')].forEach((node, index) => node.setAttribute('aria-selected', String(index === selected)));
    if (choices.length) {
      input.setAttribute('aria-activedescendant', `zen-command-option-${selected}`);
      if (scroll) list.children[selected]?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function render(preserve = false) {
    if (!snapshot || !shadow || composing) return;
    const [{ searchCatalog }, { searchScore, navigationUrl }, { COLORS }] = loaded;
    const oldKey = preserve ? choices[selected]?.key : null;
    const raw = input.value.trim();
    const commandsOnly = mode === 'all' && raw.startsWith('>');
    const query = commandsOnly ? raw.slice(1).trim() : raw;
    const all = searchCatalog({ ...snapshot, excludeTabId: snapshot.tabId, mode, root: extensionRoot });
    const matching = all.filter(item => !commandsOnly || ['action', 'space'].includes(item.kind))
      .map(item => ({ item, score: searchScore(item.label, `${item.detail} ${item.searchDetail || ''}`, query) }))
      .filter(entry => entry.score >= 0).sort((a, b) => b.score - a.score).map(entry => entry.item);
    choices = matching.slice(0, 6);
    if (mode === 'all' && query && !commandsOnly) {
      const url = navigationUrl(query);
      choices.push({ key: 'navigate', kind: 'navigate', text: query, label: url ? `Go to ${query}` : `Search for “${query}”`,
        detail: 'Open in a new tab in this space', badge: url ? 'Visit' : 'Search web' });
    }
    selected = Math.max(0, choices.findIndex(item => item.key === oldKey));
    const space = snapshot.config.spaces.find(s => s.id === snapshot.spaceId);
    host.style.setProperty('--cove-space', COLORS[space?.color] || COLORS.purple);
    $('#space').textContent = space?.name || 'Your space';
    $('#heading').textContent = mode === 'archive' ? 'Archived tabs' : commandsOnly ? 'Commands' : query ? 'Tabs, pins, and spaces' : 'Pick up where you left off';
    $('#clear').hidden = !raw;
    $('#archive').setAttribute('aria-pressed', String(mode === 'archive'));
    list.replaceChildren();
    choices.forEach((choice, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'result'; button.id = `zen-command-option-${index}`; button.tabIndex = -1;
      button.setAttribute('role', 'option'); button.dataset.key = choice.key; button.title = `${choice.label}\n${choice.searchDetail || choice.detail}`;
      const icon = document.createElement('span'); icon.className = 'result-icon'; icon.setAttribute('aria-hidden', 'true');
      icon.textContent = choice.kind === 'space' ? '◫' : choice.kind === 'archive' ? '↶' : choice.kind === 'navigate' ? '↗' : choice.kind === 'action' ? '⌘' : (choice.label[0] || '·').toLocaleUpperCase();
      const text = document.createElement('span'); text.className = 'result-text';
      const title = document.createElement('span'); title.className = 'result-title'; title.textContent = choice.label;
      const detail = document.createElement('span'); detail.className = 'result-detail'; detail.textContent = choice.detail;
      text.append(title, detail);
      const badge = document.createElement('span'); badge.className = 'result-kind'; badge.textContent = choice.badge;
      const enter = document.createElement('span'); enter.className = 'enter'; enter.textContent = '↵'; enter.setAttribute('aria-hidden', 'true');
      button.append(icon, text, badge, enter);
      button.onpointermove = () => { if (selected !== index) { selected = index; selection(); } };
      button.onmousedown = event => event.preventDefault();
      button.onclick = event => { if (event.isTrusted) execute(choice); };
      list.append(button);
    });
    if (!choices.length) {
      const empty = document.createElement('p'); empty.className = 'empty';
      empty.textContent = mode === 'archive' ? 'No matching archived tabs.' : 'No matching commands. Try “folder” or “archive”.';
      list.append(empty);
    }
    $('#status').textContent = `${choices.length} results available.`;
    selection();
  }
  function changeMode(next) {
    mode = next; input.value = ''; input.placeholder = mode === 'archive' ? 'Search your archive…' : 'Search or enter URL…';
    render(); input.focus();
  }
  function showFolder(show) {
    folder = show;
    $('#search-view').hidden = show;
    $('#folder-view').hidden = !show;
    if (show) { $('#folder-name').value = ''; $('#folder-name').focus(); }
    else { render(); input.focus(); }
  }
  async function execute(choice) {
    if (busy || !choice) return;
    if (choice.kind === 'action' && choice.id === 'archive') return changeMode('archive');
    if (choice.kind === 'action' && choice.id === 'folder') return showFolder(true);
    busy = true;
    $('#error').hidden = true;
    dialog.setAttribute('aria-busy', 'true');
    try {
      await send('commandAction', { kind: choice.kind === 'action' ? choice.id : choice.kind, id: choice.id, text: choice.text });
      close();
    } catch (reason) { error(reason); await refresh().catch(() => {}); }
    finally { busy = false; dialog?.removeAttribute('aria-busy'); }
  }
  function handleKey(event) {
    if (event.isComposing || composing || busy) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (folder) return showFolder(false);
      if (input.value) { input.value = ''; render(); input.focus(); }
      else if (mode === 'archive') changeMode('all');
      else close();
    } else if (!folder && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      if (choices.length) selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      selection(true);
    } else if (!folder && event.key === 'Enter' && shadow.activeElement === input) {
      event.preventDefault(); execute(choices[selected]);
    }
  }
  let loaded;
  async function open(nextToken) {
    if (token === nextToken && (opening || dialog?.open)) return focus();
    if (token) close();
    token = nextToken; opening = true; busy = composing = folder = false; mode = 'all'; selected = 0;
    const openToken = nextToken;
    try {
      loaded = await loadResources();
      if (token !== openToken) return;
      previousFocus = document.activeElement;
      host = document.createElement('cove-command');
      host.style.setProperty('display', 'block', 'important');
      shadow = host.attachShadow({ mode: 'closed' });
      const sheet = new CSSStyleSheet(); sheet.replaceSync(loaded[3]); shadow.adoptedStyleSheets = [sheet];
      shadow.innerHTML = `<dialog aria-label="Cove command bar"><section class="surface">
        <div id="search-view"><form id="search-form" autocomplete="off"><span class="search-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg></span><input id="search" placeholder="Search or enter URL…" autocomplete="off" spellcheck="false" role="combobox" aria-label="Search tabs, pins, spaces, or the web" aria-controls="results" aria-expanded="true" aria-autocomplete="list"><button id="clear" type="button" aria-label="Clear search" hidden>✕</button></form>
        <div class="heading"><span id="heading">Getting your spaces ready…</span><span id="space"></span></div><div id="results" role="listbox" aria-label="Search results"></div>
        <footer><span class="hints"><kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↵</kbd> open <kbd>esc</kbd> back</span><button id="archive" type="button" aria-pressed="false">Archive ↶</button></footer></div>
        <form id="folder-view" hidden><h2>New folder</h2><label for="folder-name">Name</label><input id="folder-name" required maxlength="120" autocomplete="off" placeholder="A place for your tabs"><div class="actions"><button id="folder-cancel" type="button">Cancel</button><button id="folder-save" type="submit">Create folder</button></div></form>
        <p id="error" role="alert" hidden></p><p id="status" class="sr-only" role="status" aria-live="polite"></p></section></dialog>`;
      dialog = $('dialog'); input = $('#search'); list = $('#results');
      $('#search-form').onsubmit = event => { event.preventDefault(); if (!composing) execute(choices[selected]); };
      $('#clear').onclick = () => { input.value = ''; render(); input.focus(); };
      $('#archive').onclick = () => changeMode(mode === 'archive' ? 'all' : 'archive');
      $('#folder-cancel').onclick = () => showFolder(false);
      $('#folder-view').onsubmit = async event => {
        event.preventDefault();
        const name = $('#folder-name').value.trim();
        if (!name || busy) return;
        busy = true; $('#folder-save').disabled = true;
        try {
          await send('commandAction', { kind: 'folder', text: name });
          await refresh();
          showFolder(false); input.value = ''; render();
          $('#status').textContent = `Created folder ${name}.`;
        } catch (reason) { error(reason); }
        finally { busy = false; if (shadow) $('#folder-save').disabled = false; }
      };
      dialog.oncancel = event => { event.preventDefault(); close(); };
      dialog.onpointerdown = event => { if (event.target === dialog) close(); };
      (document.documentElement || document).append(host);
      dialog.showModal();
      input.focus();
      await refresh();
      if (token === openToken) input.focus();
    } catch (reason) {
      if (token === openToken) { if (shadow) error(reason); else close(); }
    } finally { if (token === openToken) opening = false; }
  }
  globalThis.__coveCommandOverlay = { open, focus, isOpen: () => opening || !!dialog?.open };
  window.addEventListener('keydown', event => {
    const shortcut = event.key.toLowerCase() === 'k' && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey && !event.shiftKey;
    if (shortcut && event.isTrusted && !event.isComposing) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (dialog?.open) focus();
      else if (!event.repeat) chrome.runtime.sendMessage({ type: 'openCommandOverlay' }).catch(() => {});
      return;
    }
    if (host && event.composedPath().includes(host)) {
      if (event.isTrusted) handleKey(event);
      event.stopImmediatePropagation();
    }
  }, true);
  // Keep typing inside the closed shadow tree from reaching host-page handlers.
  for (const type of ['keyup', 'keypress', 'beforeinput', 'input', 'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'copy', 'cut']) {
    window.addEventListener(type, event => {
      if (!host || !event.composedPath().includes(host)) return;
      if (type === 'compositionstart') composing = true;
      if (type === 'compositionend') { composing = false; render(); }
      if (type === 'input' && shadow.activeElement === input) { $('#error').hidden = true; render(); }
      event.stopImmediatePropagation();
    }, true);
  }
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && !sender.tab && message?.type === 'commandRefresh') schedule();
  });
})();
