// Search launcher. Runs as an extension page: in an iframe over a web page (view=overlay) or
// as a tab (view=tab). It reads tabs, pins, the archive and history itself, so none of that
// reaches the web page underneath. Nothing is shown until the service worker confirms this
// launcher's one-time token. Adapted from a contribution by Julio Orozco (drewcoble/cove#1).

import { COLORS, isWebUrl, redactUrl } from './shared.js';
import { searchCatalog } from './search-catalog.js';
import { rankSearch } from './search-ranking.js';
import { searchScore } from './search.js';

const $ = sel => document.querySelector(sel);
const params = new URLSearchParams(location.hash.slice(1));
const token = params.get('token');
const view = params.get('view') === 'overlay' ? 'overlay' : 'tab';
document.documentElement.dataset.view = view;

const ICONS = {
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18-3-3.2-3-14.8 0-18Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  space: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M9 4v16"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  undo: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.globe}</svg>`;
const root = chrome.runtime.getURL('');
const HISTORY_DAYS = 90;

const input = $('#search');
const results = $('#results');
let ctx = null; // { windowId, sourceTabId, spaceId, mode }
let mode = 'all';
let data = null; // { config, rt, tabs, archive, memory }
let history = [];
let catalog = null;
let choices = [];
let selected = 0;
let busy = false;

async function call(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, token, ...payload });
  if (!res?.ok) throw new Error(res?.error || 'That didn’t work. Try again.');
  return res.result;
}

function showError(error) {
  $('#error').textContent = error?.message || String(error);
  $('#error').hidden = false;
}

const close = () => call('launcherClose').catch(() => window.close());

// ---------------------------------------------------------------------------------------
// Data

async function loadData() {
  const [local, { rt = {} }, tabs] = await Promise.all([
    chrome.storage.local.get(['config', 'archive', 'searchMemory']),
    chrome.storage.session.get('rt'),
    chrome.tabs.query({ windowId: ctx.windowId }),
  ]);
  data = { config: local.config, rt, tabs, archive: local.archive ?? [], memory: local.searchMemory ?? {} };
  catalog = null;
}

async function loadHistory() {
  if (!data.config.settings.searchHistory) return (history = []);
  const entries = await chrome.history
    .search({ text: '', startTime: Date.now() - HISTORY_DAYS * 86400000, maxResults: 2000 })
    .catch(() => []);
  history = entries
    .filter(e => isWebUrl(e.url))
    .map(e => ({ ...e, url: redactUrl(e.url, { keepHash: true }) }))
    .filter(e => e.url);
}

const currentSpace = () =>
  data.config.spaces.find(s => s.id === (data.rt.activeSpace?.[ctx.windowId] ?? ctx.spaceId)) ?? data.config.spaces[0];

function getCatalog() {
  return (catalog ??= searchCatalog({
    config: data.config,
    archive: data.archive,
    rt: data.rt,
    tabs: data.tabs,
    windowId: ctx.windowId,
    excludeTabId: ctx.sourceTabId,
    spaceId: currentSpace().id,
    mode,
    root,
  }));
}

// ---------------------------------------------------------------------------------------
// Rendering

function rank(query) {
  if (mode === 'archive') {
    return getCatalog()
      .map(item => ({ item, score: searchScore(item.label, item.searchDetail, query) }))
      .filter(e => e.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map(e => e.item);
  }
  return rankSearch({ items: getCatalog(), history, memory: data.config.settings.searchHistory ? data.memory : {}, query, spaceId: currentSpace().id });
}

function favicon(url) {
  return isWebUrl(url) ? `${root}_favicon/?pageUrl=${encodeURIComponent(url)}&size=32` : null;
}

function render(keepSelection = true) {
  if (!data) return;
  const oldKey = keepSelection ? choices[selected]?.key : null;
  const raw = input.value;
  const query = raw.trim();
  choices = rank(query);
  selected = Math.max(0, choices.findIndex(c => c.key === oldKey));

  const space = currentSpace();
  document.documentElement.style.setProperty('--space', COLORS[space.color] ?? COLORS.blue);
  $('#space-name').textContent = space.name;
  $('#heading').textContent =
    mode === 'archive' ? 'Closed tabs' : query.startsWith('>') ? 'Commands' : query ? 'Results' : 'Pick up where you left off';
  $('#count').textContent = mode === 'archive' ? `${data.archive.length} saved` : '';
  $('#clear').hidden = !raw;
  $('#archive-toggle').setAttribute('aria-pressed', String(mode === 'archive'));
  $('#clear-archive').hidden = mode !== 'archive' || !data.archive.length;

  results.replaceChildren();
  choices.forEach((choice, i) => results.append(resultRow(choice, i)));
  if (!choices.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent =
      mode === 'archive'
        ? data.config.settings.archiveClosedTabs
          ? 'No closed tabs yet. Tabs you close show up here.'
          : 'The archive is turned off in Cove’s settings.'
        : 'Type to search, paste a URL, or type > for commands.';
    results.append(empty);
  }
  $('#announce').textContent = `${choices.length} ${choices.length === 1 ? 'result' : 'results'}`;
  updateSelection(false);
}

function resultRow(choice, i) {
  const row = document.createElement('div');
  row.className = 'result';
  row.id = `result-${i}`;
  row.setAttribute('role', 'option');
  row.title = [choice.label, choice.url].filter(Boolean).join('\n');

  const icon = document.createElement('span');
  icon.className = 'result-icon';
  const src = choice.icon ? null : favicon(choice.url);
  if (src) {
    const img = Object.assign(document.createElement('img'), { alt: '', src });
    img.onerror = () => (icon.innerHTML = svg('globe'));
    icon.append(img);
  } else {
    icon.innerHTML = svg(choice.icon);
  }

  const text = document.createElement('span');
  text.className = 'result-text';
  text.append(
    Object.assign(document.createElement('span'), { className: 'result-title', textContent: choice.label }),
    Object.assign(document.createElement('span'), { className: 'result-detail', textContent: choice.detail || '' }),
  );
  const badge = Object.assign(document.createElement('span'), { className: 'result-kind', textContent: choice.badge || '' });
  row.append(icon, text, badge);

  if (choice.kind === 'archive') {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'result-delete';
    del.title = 'Remove from archive';
    del.innerHTML = svg('x');
    del.addEventListener('click', event => {
      event.stopPropagation();
      run(() => call('launcherAction', { kind: 'deleteArchive', id: choice.id }));
    });
    row.append(del);
  }
  row.addEventListener('pointermove', () => {
    if (selected !== i) {
      selected = i;
      updateSelection(false);
    }
  });
  row.addEventListener('mousedown', event => event.preventDefault());
  row.addEventListener('click', () => execute(choice));
  return row;
}

function updateSelection(scroll = true) {
  results.querySelectorAll('[role=option]').forEach((node, i) => node.setAttribute('aria-selected', String(i === selected)));
  if (choices.length) {
    input.setAttribute('aria-activedescendant', `result-${selected}`);
    if (scroll) results.children[selected]?.scrollIntoView({ block: 'nearest' });
  } else {
    input.removeAttribute('aria-activedescendant');
  }
}

// ---------------------------------------------------------------------------------------
// Actions

async function run(fn) {
  if (busy) return;
  busy = true;
  $('#error').hidden = true;
  try {
    await fn();
  } catch (error) {
    showError(error);
  } finally {
    busy = false;
  }
}

function setMode(next) {
  mode = next;
  catalog = null;
  input.value = '';
  input.placeholder = mode === 'archive' ? 'Search closed tabs' : 'Search tabs, pins, history, or type a URL';
  render(false);
  input.focus();
}

function showFolderForm() {
  $('#folder-space').textContent = currentSpace().name;
  $('#folder-form').hidden = false;
  results.hidden = true;
  $('#folder-name').value = '';
  $('#folder-name').focus();
}

function hideFolderForm() {
  $('#folder-form').hidden = true;
  results.hidden = false;
  input.focus();
}

function execute(choice) {
  if (!choice) return;
  if (choice.kind === 'action') {
    if (choice.id === 'archive') return setMode('archive');
    if (choice.id === 'folder') return showFolderForm();
    if (choice.id === 'undo') return run(() => call('launcherAction', { kind: 'undo' }));
  }
  run(() => call('launcherAction', { kind: choice.kind, id: choice.id, text: choice.text, query: input.value }));
}

$('#folder-form').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    await call('launcherAction', { kind: 'folder', text: $('#folder-name').value });
    await close();
  });
});
$('#folder-cancel').addEventListener('click', hideFolderForm);
$('#folder-name').addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    hideFolderForm();
  }
});

$('#search-form').addEventListener('submit', event => event.preventDefault());
$('#clear').addEventListener('click', () => {
  input.value = '';
  render(false);
  input.focus();
});
$('#archive-toggle').addEventListener('click', () => setMode(mode === 'archive' ? 'all' : 'archive'));

let confirmClear = null;
$('#clear-archive').addEventListener('click', () => {
  const button = $('#clear-archive');
  if (!confirmClear) {
    button.textContent = 'Click again to clear';
    confirmClear = setTimeout(() => {
      confirmClear = null;
      button.textContent = 'Clear all';
    }, 3000);
    return;
  }
  clearTimeout(confirmClear);
  confirmClear = null;
  button.textContent = 'Clear all';
  run(() => call('clearArchive'));
});

input.addEventListener('input', () => {
  $('#error').hidden = true;
  render(false);
});

addEventListener('keydown', event => {
  if (!data || !$('#folder-form').hidden) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!choices.length) return;
    selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
    updateSelection();
  } else if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    execute(choices[selected]);
  } else if (event.key === 'Escape') {
    // Esc clears what's typed; Esc on an empty box closes search. (The folder form handles
    // its own Esc.)
    event.preventDefault();
    if (input.value) {
      input.value = '';
      render(false);
    } else {
      close();
    }
  }
});

// ---------------------------------------------------------------------------------------
// Boot: nothing is read or shown until the service worker accepts this launcher's token.

let refreshTimer;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    await loadData();
    render();
  }, 60);
}

try {
  ctx = await call('launcherHello');
  mode = ctx.mode;
  await loadData();
  await loadHistory();
  if (mode === 'archive') setMode('archive');
  render(false);
  input.focus();
  addEventListener('focus', () => $('#folder-form').hidden && input.focus());
  // Over a page, keyboard focus can be stuck in Chrome's own UI (e.g. the address bar after
  // closing a New Tab), which a frame can't take it from. Switch to the tab launcher then.
  if (view === 'overlay') {
    setTimeout(() => !document.hasFocus() && call('launcherFallback').catch(() => {}), 300);
  }
  chrome.storage.onChanged.addListener(changes => {
    if (changes.config && changes.config.newValue?.settings?.searchHistory !== data.config.settings.searchHistory) {
      loadData().then(loadHistory).then(() => render());
    } else if (changes.config || changes.archive || changes.rt || changes.searchMemory) {
      refreshSoon();
    }
  });
  for (const ev of ['onCreated', 'onRemoved', 'onUpdated', 'onActivated', 'onMoved']) chrome.tabs[ev].addListener(refreshSoon);
} catch {
  $('.panel').replaceChildren(
    Object.assign(document.createElement('p'), {
      className: 'expired',
      textContent: 'This search has closed. Press your search shortcut to open it again.',
    }),
  );
}
