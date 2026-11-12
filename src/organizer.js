import { navigationUrl } from './search.js';
import { pinTitle, hostname } from './shared.js';

// UI state is ephemeral; folders and archive operations are owned by the worker.
export function createOrganizer(env) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#organizer-dialog');
  const input = $('#organizer-search');
  const results = $('#organizer-results');
  let mode = 'commands';
  let choices = [];
  let selected = 0;
  let previousFocus;
  let knownArchive = new Set();
  let initialized = false;
  let pendingOpen = false;
  let toastTimer;
  let busy = false;

  const folders = spaceId => Object.values(env.state().config.folders ?? {}).filter(f => f.spaceId === spaceId);
  const folderPath = folder => {
    const names = [folder.name];
    let parent = env.state().config.folders[folder.parentId];
    const visited = new Set([folder.id]);
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      names.unshift(parent.name);
      parent = env.state().config.folders[parent.parentId];
    }
    return names.join(' / ');
  };
  const run = promise => Promise.resolve(promise).catch(e => error(e.message));

  function notify(message, undo = false) {
    const toast = $('#toast');
    toast.replaceChildren(document.createTextNode(message));
    if (undo) {
      const button = document.createElement('button');
      button.textContent = 'Undo';
      button.onclick = () => run(env.send('undoArchive', { windowId: env.state().windowId }).then(() => toast.classList.remove('show')));
      toast.append(button);
    }
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 8000);
  }
  function error(message) {
    if (dialog.open) {
      $('#organizer-error').textContent = message;
      $('#organizer-error').hidden = false;
    } else notify(message);
  }

  function newFolder(spaceId, parentId = null) {
    env.promptPopover(env.point(), {
      title: 'New folder', placeholder: 'Folder name', value: '', confirm: 'Create',
      onSave: name => run(env.send('createFolder', { spaceId, parentId, name })),
    });
  }

  function folderMenu(id) {
    const folder = env.state().config.folders[id];
    if (!folder) return [];
    const validParent = candidate => {
      let cursor = candidate;
      while (cursor) {
        if (cursor.id === id) return false;
        cursor = env.state().config.folders[cursor.parentId];
      }
      return true;
    };
    return [
      { label: 'Rename folder…', run: () => env.promptPopover(env.point(), {
        title: 'Rename folder', value: folder.name,
        onSave: name => run(env.send('updateFolder', { folderId: id, name })),
      }) },
      { label: 'New subfolder…', run: () => newFolder(folder.spaceId, id) },
      { label: 'Open all tabs', run: () => env.send('openFolder', { windowId: env.state().windowId, folderId: id }) },
      '-',
      folder.parentId && { label: 'Move to top level', run: () => env.send('updateFolder', { folderId: id, parentId: null }) },
      ...folders(folder.spaceId).filter(f => f.id !== folder.parentId && validParent(f)).map(f => ({
        label: `Move into ${folderPath(f)}`, run: () => env.send('updateFolder', { folderId: id, parentId: f.id }),
      })),
      '-',
      { label: 'Remove folder (keep tabs)', run: () => env.send('deleteFolder', { folderId: id }) },
    ];
  }

  function pinFolderItems(tabId, pinId, spaceId) {
    const list = folders(spaceId);
    const pin = env.state().config.pins[pinId];
    return [
      pin?.folderId && { label: 'Move out of folder', run: () => env.send('movePin', { pinId, spaceId, folderId: null }) },
      ...list.filter(f => f.id !== pin?.folderId).map(f => ({
        label: `${pinId ? 'Move' : 'Pin'} to ${folderPath(f)}`,
        run: () => env.send(pinId ? 'movePin' : 'pinTab', { tabId, pinId, spaceId, folderId: f.id }),
      })),
    ].filter(Boolean);
  }

  function renderPins(space, withTab) {
    const items = [];
    const allFolders = folders(space.id);
    const allPins = space.pins.filter(id => env.state().config.pins[id]).map(withTab);
    function visit(parentId, depth) {
      for (const entry of allPins.filter(x => (x.pin.folderId ?? null) === parentId)) items.push({ ...entry, depth });
      for (const folder of allFolders.filter(f => (f.parentId ?? null) === parentId)) {
        items.push({ folder, depth });
        if (!folder.collapsed) visit(folder.id, depth + 1);
      }
    }
    visit(null, 0);
    env.syncList($('#pins'), items, x => x.folder ? 'f' + x.folder.id : 'p' + x.pin.id,
      x => {
        if (!x.folder) return env.createRow();
        const button = document.createElement('button');
        button.className = 'folder-row';
        button.innerHTML = '<span class="folder-chevron"></span><span class="folder-label"></span><span class="folder-count"></span>';
        button.onclick = () => run(env.send('updateFolder', { folderId: button.dataset.folder, collapsed: button.getAttribute('aria-expanded') === 'true' }));
        return button;
      },
      (node, entry) => {
        node.style.setProperty('--depth', entry.depth);
        if (!entry.folder) {
          env.updatePinRow(node, entry);
          node.dataset.folderId = entry.pin.folderId || '';
          return;
        }
        const f = entry.folder;
        node.dataset.folder = f.id;
        node.setAttribute('aria-expanded', String(!f.collapsed));
        node.title = folderPath(f) + ' · Right-click for folder options';
        node.querySelector('.folder-chevron').textContent = f.collapsed ? '▸' : '▾';
        node.querySelector('.folder-label').textContent = f.name;
        node.querySelector('.folder-count').textContent = String(allPins.filter(x => x.pin.folderId === f.id).length);
      });
  }

  function open(which) {
    if (!env.state().config) { pendingOpen = true; return; }
    if (!dialog.open) previousFocus = document.activeElement;
    mode = which;
    $('#organizer-error').hidden = true;
    selected = 0;
    input.value = '';
    $('#organizer-title').textContent = mode === 'archive' ? 'Archive' : 'Command bar';
    input.placeholder = mode === 'archive' ? 'Search closed tabs' : 'Search tabs, spaces, or commands';
    input.setAttribute('aria-label', input.placeholder);
    $('#organizer-tools').hidden = mode !== 'archive';
    if (!dialog.open) dialog.showModal();
    renderResults();
    input.focus();
  }
  function close() {
    dialog.close();
  }
  dialog.addEventListener('close', () => {
    if (previousFocus?.isConnected && document.querySelector('#popover').hidden) previousFocus.focus();
  });
  $('#organizer-close').onclick = close;
  dialog.addEventListener('click', e => { if (e.target === dialog && e.clientY < dialog.getBoundingClientRect().top) close(); });
  $('#command-launch').onclick = () => open('commands');
  $('#archive-launch').onclick = () => open('archive');
  $('#archive-undo').onclick = () => execute({ run: () => env.send('undoArchive', { windowId: env.state().windowId }), keepOpen: true });

  // Match all query words against titles, URLs and space names. A subsequence also
  // finds abbreviated names without requiring a network search service.
  function matches(item, query) {
    const haystack = `${item.label} ${item.detail || ''}`.toLocaleLowerCase();
    return query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every(word => {
      if (haystack.includes(word)) return true;
      let i = 0;
      for (const char of haystack) if (char === word[i]) i++;
      return i === word.length;
    });
  }

  function commandItems() {
    const { config, rt, tabs, windowId, spaceId } = env.state();
    const items = [];
    const spaceName = id => config.spaces.find(s => s.id === id)?.name || 'Essentials';
    const tabSpace = tab => rt.groupSpace?.[tab.groupId] ?? rt.tabSpace?.[tab.id];
    for (const tab of tabs) {
      const pin = config.pins[rt.tabPin?.[tab.id]];
      items.push({ key: 'tab-' + tab.id, label: pin ? pinTitle(pin, tab) : tab.title || hostname(tab.url) || 'New Tab',
        detail: `Tab · ${spaceName(pin ? pin.spaceId : tabSpace(tab))} · ${tab.url || tab.pendingUrl || ''}`,
        run: async () => {
          const id = pin?.spaceId ?? tabSpace(tab);
          if (id) await env.send('switchSpace', { windowId, spaceId: id });
          await chrome.tabs.update(tab.id, { active: true });
        } });
    }
    for (const pin of Object.values(config.pins)) {
      if (tabs.some(t => rt.tabPin?.[t.id] === pin.id)) continue;
      items.push({ key: 'pin-' + pin.id, label: pinTitle(pin), detail: `Pinned · ${spaceName(pin.spaceId)} · ${pin.url}`,
        run: () => env.send('openPin', { windowId, pinId: pin.id }) });
    }
    for (const space of config.spaces) {
      items.push({ key: 'space-' + space.id, label: `Switch to ${space.name}`, detail: 'Space',
        run: () => env.send('switchSpace', { windowId, spaceId: space.id }) });
      items.push({ key: 'move-' + space.id, label: `Move current tab to ${space.name}`, detail: 'Action',
        run: () => {
          const tab = tabs.find(t => t.active);
          const pinId = tab && rt.tabPin?.[tab.id];
          return tab && env.send(pinId ? 'movePin' : 'moveTab', { pinId, tabId: tab.id, spaceId: space.id });
        } });
    }
    items.push(
      { key: 'new', label: 'New tab', detail: 'Action', run: () => env.send('newTab', { windowId, spaceId }) },
      { key: 'folder', label: 'New folder…', detail: 'Action', run: () => newFolder(spaceId) },
      { key: 'archive', label: 'View archive', detail: 'Action', run: () => open('archive'), keepOpen: true },
      { key: 'undo', label: 'Undo last close', detail: 'Restore a tab or cleared space', run: () => env.send('undoArchive', { windowId }) },
      { key: 'clear', label: 'Archive other unpinned tabs in this space', detail: 'Action · Can be undone', run: () => env.send('clearSpace', { windowId, spaceId }) },
    );
    const current = tabs.find(t => t.active);
    if (current) items.push({ key: 'pin', label: 'Pin current tab', detail: 'Action', run: () => env.send('pinTab', { tabId: current.id, spaceId }) });
    return items;
  }

  function renderResults() {
    if (!dialog.open) return;
    const { config, windowId } = env.state();
    const query = input.value.trim();
    const oldKey = choices[selected]?.key;
    if (mode === 'archive') {
      choices = config.archive.map(entry => ({ key: entry.id, label: entry.title || entry.url,
        detail: `${config.spaces.find(s => s.id === entry.spaceId)?.name || 'Deleted space'} · ${new Date(entry.closedAt).toLocaleString()} · ${entry.url}`,
        run: () => env.send('restoreArchive', { windowId, entryIds: [entry.id] }), keepOpen: true }));
      $('#archive-undo').disabled = busy || !config.archive.some(e => e.windowId === windowId);
    } else choices = commandItems();
    choices = choices.filter(item => matches(item, query));
    if (mode === 'commands' && query) choices.push({ key: 'navigate', label: `Open “${query}”`, detail: 'Address or web search', run: async () => {
      const { spaceId } = env.state();
      const url = navigationUrl(query) || undefined;
      const tabId = await env.send('newTab', { windowId, spaceId, url });
      if (!url) await chrome.search.query({ text: query, tabId });
    } });
    selected = Math.max(0, choices.findIndex(item => item.key === oldKey));
    results.replaceChildren();
    choices.forEach((choice, i) => {
      const button = document.createElement('button');
      button.id = `organizer-option-${i}`;
      button.className = 'command-result';
      button.title = choice.detail || choice.label;
      button.setAttribute('role', 'option');
      button.tabIndex = -1;
      const title = document.createElement('span'); title.textContent = choice.label;
      const detail = document.createElement('small'); detail.textContent = choice.detail;
      button.append(title, detail);
      button.onclick = () => execute(choice);
      results.append(button);
    });
    if (!choices.length) {
      const empty = document.createElement('p');
      empty.className = 'command-empty';
      empty.textContent = mode === 'archive' ? 'No archived tabs match.' : 'No results.';
      results.append(empty);
    }
    updateSelection();
  }

  function updateSelection() {
    results.querySelectorAll('[role=option]').forEach((node, i) => node.setAttribute('aria-selected', String(i === selected)));
    if (choices.length) {
      input.setAttribute('aria-activedescendant', `organizer-option-${selected}`);
      results.children[selected]?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  async function execute(choice) {
    if (!choice || busy) return;
    busy = true;
    dialog.setAttribute('aria-busy', 'true');
    try {
      if (!choice.keepOpen) close();
      await choice.run();
    } catch (e) { error(e.message); }
    finally { busy = false; dialog.removeAttribute('aria-busy'); renderResults(); }
  }
  input.addEventListener('input', () => { choices = []; selected = 0; renderResults(); });
  input.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (choices.length) selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      updateSelection();
    } else if (e.key === 'Enter') { e.preventDefault(); execute(choices[selected]); }
  });
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open('commands'); }
  });
  async function consumeRequest() {
    const { commandRequest } = await chrome.storage.session.get('commandRequest');
    if (commandRequest?.windowId === env.state().windowId) {
      await chrome.storage.session.remove('commandRequest');
      if (Date.now() - commandRequest.at < 10000) {
        if (env.state().config) open('commands');
        else pendingOpen = true;
      }
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.commandRequest?.newValue) run(consumeRequest());
  });
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (sender.url !== chrome.runtime.getURL('src/background.js')) return;
    if (msg.target === 'panel' && msg.type === 'commandBar' && msg.windowId === env.state().windowId) open('commands');
  });
  function refresh() {
    const { config, windowId } = env.state();
    const latest = config.archive[0];
    if (initialized && latest && !knownArchive.has(latest.id) && latest.windowId === windowId) {
      const count = config.archive.filter(e => e.batchId === latest.batchId).length;
      notify(`Archived ${count} ${count === 1 ? 'tab' : 'tabs'}`, true);
    }
    knownArchive = new Set(config.archive.map(e => e.id));
    initialized = true;
    if (pendingOpen) { pendingOpen = false; open('commands'); }
    renderResults();
  }
  chrome.commands.getAll().then(commands => {
    const shortcut = commands.find(c => c.name === 'command-bar')?.shortcut;
    $('#command-launch kbd').textContent = shortcut || '⌘/Ctrl K';
  }).catch(() => {});
  run(consumeRequest());
  return { renderPins, refresh, newFolder, folderMenu, pinFolderItems, openCommands: () => open('commands'), error };
}
