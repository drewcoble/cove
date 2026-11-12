import { COLORS } from './shared.js';
import { searchCatalog } from './search-catalog.js';
import { navigationUrl, searchScore } from './search.js';

const $ = selector => document.querySelector(selector);
const input = $('#search');
const results = $('#results');
const folderDialog = $('#folder-dialog');
const root = chrome.runtime.getURL('');
const icons = {
  globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c4 4 4 12 0 16-4-4-4-12 0-16Z"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  space: '<rect x="4" y="4" width="16" height="16" rx="5"/><path d="M9 4v16"/>',
  folder: '<path d="M3 8V5h6l2 3h10v11H3Z"/>',
  undo: '<path d="M4 10h9a6 6 0 0 1 0 12M4 10l5-5M4 10l5 5"/>',
  archive: '<path d="M5 8v12h14V8M3 4h18v4H3ZM9 12h6"/>',
};
const svg = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${icons[name] || icons.globe}</svg>`;
let context;
let config;
let rt = {};
let tabs = [];
let choices = [];
let selected = 0;
let mode = 'all';
let busy = false;
let composing = false;
let refreshTimer;
let generation = 0;
let ready = false;

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || 'That action could not be completed. Please try again.');
  return response.result;
}
function showError(error) {
  $('#error').textContent = error?.message || String(error);
  $('#error').hidden = false;
  input.focus();
}
function spaceId() {
  const known = id => config?.spaces.some(space => space.id === id);
  const id = rt.tabSpace?.[context.tabId] || rt.activeSpace?.[context.windowId] || context.spaceId;
  return known(id) ? id : config.spaces[0].id;
}
function favicon(url) {
  return /^https?:/i.test(url || '') ? `${root}_favicon/?pageUrl=${encodeURIComponent(url)}&size=32` : null;
}

function catalog() {
  return searchCatalog({ config, rt, tabs, windowId: context.windowId, excludeTabId: context.tabId,
    spaceId: spaceId(), mode, root }).map(item => {
    if (item.kind !== 'action') return item;
    const actions = {
      folder: openFolderForm,
      archive: () => changeMode('archive'),
      undo: async () => { await send('undoArchive', { windowId: context.windowId }); await refresh(); },
    };
    return { ...item, action: actions[item.id] };
  });
}

function render(preserveSelection = true) {
  if (!ready || composing) return;
  const oldKey = preserveSelection ? choices[selected]?.key : null;
  const raw = input.value.trim();
  const commandsOnly = mode === 'all' && raw.startsWith('>');
  const query = commandsOnly ? raw.slice(1).trim() : raw;
  const candidates = catalog().filter(item => !commandsOnly || item.kind === 'action' || item.kind === 'space');
  const matching = candidates.map(item => ({ item, score: searchScore(item.label, `${item.detail} ${item.searchDetail || ''}`, query) }))
    .filter(entry => entry.score >= 0).sort((a, b) => b.score - a.score).map(entry => entry.item);
  const total = matching.length;
  choices = matching.slice(0, query ? 7 : 6);
  if (mode === 'all' && query && !commandsOnly) {
    const url = navigationUrl(query);
    choices.push({ key: 'navigate', kind: 'navigate', label: url ? `Go to ${query}` : `Search for “${query}”`,
      detail: url ? 'Open in this tab' : 'Use your default search engine', badge: url ? 'Visit' : 'Search web', icon: url ? 'globe' : 'search',
      action: () => send('navigateNewTab', { tabId: context.tabId, text: query }),
    });
  }
  selected = Math.max(0, choices.findIndex(item => item.key === oldKey));
  $('#clear-search').hidden = !raw;
  $('#results-heading').textContent = mode === 'archive' ? 'Your archived tabs' : commandsOnly ? 'Commands' : query ? 'Tabs, pins, and spaces' : 'Pick up where you left off';
  $('#result-count').textContent = total > matching.slice(0, query ? 7 : 6).length ? `${Math.min(query ? 7 : 6, total)} of ${total}` : '';
  results.replaceChildren();
  for (const [i, choice] of choices.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `result-${i}`;
    button.dataset.key = choice.key;
    button.dataset.kind = choice.kind;
    button.className = 'result';
    button.tabIndex = -1;
    button.setAttribute('role', 'option');
    button.title = `${choice.label}\n${choice.searchDetail || choice.detail}`;
    const icon = document.createElement('span');
    icon.className = 'result-icon';
    const src = favicon(choice.url);
    if (src) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = src;
      img.onerror = () => icon.innerHTML = svg(choice.icon);
      icon.append(img);
    } else icon.innerHTML = svg(choice.icon);
    const text = document.createElement('span'); text.className = 'result-text';
    const label = document.createElement('span'); label.className = 'result-title'; label.textContent = choice.label;
    const detail = document.createElement('span'); detail.className = 'result-detail'; detail.textContent = choice.detail;
    text.append(label, detail);
    const badge = document.createElement('span'); badge.className = 'result-kind'; badge.textContent = choice.badge;
    const enter = document.createElement('span'); enter.className = 'result-enter'; enter.textContent = '↵'; enter.setAttribute('aria-hidden', 'true');
    button.append(icon, text, badge, enter);
    button.addEventListener('pointermove', () => { if (selected !== i) { selected = i; updateSelection(false); } });
    button.addEventListener('mousedown', event => event.preventDefault());
    button.onclick = () => execute(choice);
    results.append(button);
  }
  if (!choices.length) {
    const empty = document.createElement('p'); empty.className = 'empty-state';
    empty.textContent = mode === 'archive' ? 'No archived tabs here yet. Closed tabs will appear here.' : commandsOnly ? 'No matching commands. Try “folder” or “archive”.' : 'A little room to begin. Type a URL, a search, or > for commands.';
    results.append(empty);
  }
  const space = config.spaces.find(space => space.id === spaceId());
  $('#space-name').textContent = space.name;
  document.documentElement.style.setProperty('--space', COLORS[space.color] || COLORS.purple);
  $('#announcements').textContent = `${choices.length} ${choices.length === 1 ? 'result' : 'results'} available.`;
  updateSelection(false);
}
function updateSelection(scroll = true) {
  [...results.querySelectorAll('[role=option]')].forEach((node, i) => node.setAttribute('aria-selected', String(i === selected)));
  if (choices.length) {
    input.setAttribute('aria-activedescendant', `result-${selected}`);
    if (scroll) results.children[selected]?.scrollIntoView({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}
async function execute(choice) {
  if (busy || !choice) return;
  busy = true;
  $('.search-panel').setAttribute('aria-busy', 'true');
  $('#error').hidden = true;
  try {
    if (choice.action) await choice.action();
    else await send('selectNewTabResult', { tabId: context.tabId, kind: choice.kind, id: choice.id });
  } catch (error) { showError(error); }
  finally { busy = false; $('.search-panel').removeAttribute('aria-busy'); }
}
function changeMode(next) {
  mode = next;
  input.value = '';
  input.placeholder = mode === 'archive' ? 'Search your archive…' : 'Search or enter URL…';
  $('#archive-toggle').setAttribute('aria-pressed', String(mode === 'archive'));
  render(false);
  input.focus();
}
async function refresh() {
  const version = ++generation;
  const [local, session, currentTabs] = await Promise.all([
    chrome.storage.local.get('config'), chrome.storage.session.get('rt'), chrome.tabs.query({ windowId: context.windowId }),
  ]);
  if (version !== generation) return;
  if (!local.config) throw new Error('Your spaces are still loading. Reload this page to try again.');
  config = local.config;
  rt = session.rt || {};
  tabs = currentTabs;
  ready = true;
  render();
}
function schedule() {
  if (!context) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(showError), 40);
}
function openFolderForm() {
  $('#folder-name').value = '';
  $('#folder-error').hidden = true;
  folderDialog.showModal();
  $('#folder-name').focus();
}
$('#folder-cancel').onclick = () => folderDialog.close();
folderDialog.addEventListener('close', () => input.focus());
$('#folder-form').onsubmit = async event => {
  event.preventDefault();
  const name = $('#folder-name').value.trim();
  if (!name || $('#folder-save').disabled) return;
  $('#folder-save').disabled = true;
  try {
    await send('createFolder', { spaceId: spaceId(), name });
    folderDialog.close();
    input.value = '';
    await refresh();
    $('#announcements').textContent = `Created folder ${name}.`;
  } catch (error) { $('#folder-error').textContent = error.message; $('#folder-error').hidden = false; }
  finally { $('#folder-save').disabled = false; }
};
$('#search-form').onsubmit = event => { event.preventDefault(); if (!composing) execute(choices[selected]); };
input.addEventListener('compositionstart', () => composing = true);
input.addEventListener('compositionend', () => { composing = false; render(false); });
input.addEventListener('input', () => { $('#error').hidden = true; render(false); });
input.addEventListener('keydown', event => {
  if (event.isComposing || composing || busy) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (choices.length) selected = (selected + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
    updateSelection();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    execute(choices[selected]);
  }
});
document.addEventListener('keydown', event => {
  if (event.isComposing || composing || folderDialog.open || busy || !context) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); input.focus(); input.select(); }
  if (event.key !== 'Escape') return;
  event.preventDefault();
  if (input.value) { input.value = ''; render(false); input.focus(); }
  else if (mode === 'archive') changeMode('all');
  else execute({ action: () => send('dismissNewTab', context) });
});
$('#clear-search').onclick = () => { input.value = ''; render(false); input.focus(); };
$('#archive-toggle').onclick = () => { if (ready) changeMode(mode === 'archive' ? 'all' : 'archive'); };
$('.wordmark').onclick = event => { event.preventDefault(); input.focus(); };
chrome.storage.onChanged.addListener(schedule);
for (const name of ['onCreated', 'onUpdated', 'onRemoved', 'onActivated', 'onMoved', 'onAttached', 'onDetached']) chrome.tabs[name].addListener(schedule);
window.addEventListener('unhandledrejection', event => { event.preventDefault(); showError(event.reason); });
try {
  const tab = await chrome.tabs.getCurrent();
  context = await send('newTabContext', { tabId: tab.id });
  await refresh();
  // Chrome may keep focus in the omnibox on a native New Tab. Request page focus
  // once on load; never steal it back while someone is using browser controls.
  if (tab.active) input.focus();
} catch (error) { showError(error); }

chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.url !== chrome.runtime.getURL('src/background.js')) return;
  if (message.target === 'newtab' && message.type === 'focusSearch' && message.tabId === context?.tabId) { input.focus(); input.select(); }
});
