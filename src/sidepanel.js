import { COLORS, isDrifted, pinTitle, hostname, isWebUrl } from './shared.js';

// Lucide icon paths (ISC license).
const ICONS = {
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  rotateCw: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  rotateCcw: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  volume:
    '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>',
  volumeX:
    '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  sliders:
    '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  pinOff:
    '<path d="M12 17v5"/><path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/><path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/>',
  star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  duplicate:
    '<line x1="15" x2="15" y1="12" y2="18"/><line x1="12" x2="18" y1="15" y2="15"/><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  pencil:
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
};

const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
const GLOBE =
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8a8a90" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS.globe}</svg>`,
  );

const $ = sel => document.querySelector(sel);

let windowId;
let config;
let rt = {};
let tabs = [];
let drag = null;
let shownSpaceId = null;
let lastActiveTabId = null;
let spaceShortcuts = {}; // 0-based space index -> shortcut bound at chrome://extensions/shortcuts

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...payload });
  if (!res?.ok) console.warn('[cove]', type, res?.error);
  return res?.result;
}

// ---------------------------------------------------------------------------------------
// State

async function refresh() {
  const [{ config: c }, { rt: r }, t] = await Promise.all([
    chrome.storage.local.get('config'),
    chrome.storage.session.get('rt'),
    chrome.tabs.query({ windowId }),
  ]);
  if (!c) return;
  config = c;
  rt = r ?? {};
  tabs = t;
  render();
}

let refreshTimer = null;
let renderDeferred = false;
function schedule() {
  if (drag) {
    renderDeferred = true;
    return;
  }
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 25);
}

function activeSpaceId() {
  const ids = config.spaces.map(s => s.id);
  const id = rt.activeSpace?.[windowId];
  if (ids.includes(id)) return id;
  return ids.includes(rt.lastSpace) ? rt.lastSpace : ids[0];
}

const spaceOf = t => (t.pinned ? null : rt.groupSpace?.[t.groupId] ?? rt.tabSpace?.[t.id] ?? null);
const boundPinOf = t => {
  const pid = rt.tabPin?.[t.id];
  return pid && config.pins[pid] ? pid : null;
};
const boundTabOf = pinId => tabs.find(t => rt.tabPin?.[t.id] === pinId) ?? null;
const activeTab = () => tabs.find(t => t.active) ?? null;
const tabUrl = t => t?.url || t?.pendingUrl || '';

function faviconFor(tab, pin) {
  const fav = tab?.favIconUrl;
  if (fav && (isWebUrl(fav) || fav.startsWith('data:'))) return fav;
  if (!tab && pin?.favIconUrl) return pin.favIconUrl;
  const url = tab ? tabUrl(tab) : pin?.url;
  if (!isWebUrl(url)) return pin?.favIconUrl || GLOBE;
  return `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=32`;
}

function setImg(img, src) {
  if (img.dataset.src === src) return;
  img.dataset.src = src;
  img.onerror = () => {
    img.onerror = null;
    img.src = GLOBE;
  };
  img.src = src;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

// Keyed DOM reconciliation so hover, focus and in-progress renames survive re-renders.
function syncList(container, items, keyOf, create, update) {
  const existing = new Map();
  for (const child of container.children) if (child.dataset.key) existing.set(child.dataset.key, child);
  const keep = new Set();
  let prev = null;
  for (const item of items) {
    const key = keyOf(item);
    keep.add(key);
    let node = existing.get(key);
    if (!node) {
      node = create(item);
      node.dataset.key = key;
    }
    update(node, item);
    const expected = prev ? prev.nextSibling : container.firstChild;
    if (node !== expected) container.insertBefore(node, expected);
    prev = node;
  }
  for (const [key, node] of existing) if (!keep.has(key)) node.remove();
}

// ---------------------------------------------------------------------------------------
// Rendering

function render() {
  if (!config || !windowId) return;
  const spaceId = activeSpaceId();
  const space = config.spaces.find(s => s.id === spaceId);
  document.documentElement.style.setProperty('--space', COLORS[space.color] ?? COLORS.blue);

  const boundByPin = new Map();
  for (const t of tabs) {
    const pid = boundPinOf(t);
    if (pid && !boundByPin.has(pid)) boundByPin.set(pid, t);
  }
  const withTab = id => ({ pin: config.pins[id], tab: boundByPin.get(id) ?? null });

  renderToolbar();
  const essentials = config.essentials.filter(id => config.pins[id]);
  syncList($('#essentials'), essentials.map(withTab), x => 'p' + x.pin.id, createEssential, updateEssential);
  $('#essentials').style.setProperty('--ess-cols', essentialColumns(essentials.length));
  renderHeader(space);
  syncList(
    $('#pins'),
    space.pins.filter(id => config.pins[id]).map(withTab),
    x => 'p' + x.pin.id,
    createRow,
    updatePinRow,
  );
  syncList(
    $('#tabs'),
    tabs.filter(t => !t.pinned && !boundPinOf(t) && spaceOf(t) === space.id),
    t => 't' + t.id,
    createRow,
    updateTabRow,
  );
  syncList($('#spaces'), config.spaces, s => 's' + s.id, createSpaceButton, (node, s) =>
    updateSpaceButton(node, s, s.id === space.id),
  );

  animateSwitch(space.id);
  const active = activeTab();
  if (active && active.id !== lastActiveTabId) {
    lastActiveTabId = active.id;
    document.querySelector('#space .row.active')?.scrollIntoView({ block: 'nearest' });
  }
}

// Up to 3 Essentials share one row; 4–10 split over two rows with the extra one on top
// (3/2, 3/3, 4/3 … 5/5); beyond that, rows of 5.
const essentialColumns = n => Math.max(1, n <= 3 ? n : Math.min(5, Math.ceil(n / 2)));

function renderToolbar() {
  const input = $('#url');
  if (document.activeElement === input) return;
  const url = tabUrl(activeTab());
  input.value = isWebUrl(url) ? hostname(url) : url.startsWith('chrome://newtab') ? '' : url;
}

function renderHeader(space) {
  setText($('#space-icon'), space.icon ?? '');
  const name = $('#space-name');
  if (!name.dataset.editing) setText(name, space.name);
}

function animateSwitch(spaceId) {
  if (shownSpaceId && shownSpaceId !== spaceId) {
    const ids = config.spaces.map(s => s.id);
    const inner = $('#space-inner');
    inner.classList.remove('from-left', 'from-right');
    void inner.offsetWidth;
    inner.classList.add(ids.indexOf(spaceId) > ids.indexOf(shownSpaceId) ? 'from-right' : 'from-left');
    $('#space').scrollTop = 0;
  }
  shownSpaceId = spaceId;
}

function createEssential() {
  const node = document.createElement('div');
  node.className = 'ess';
  node.draggable = true;
  node.innerHTML = '<img alt="" draggable="false"><span class="dot"></span>';
  return node;
}

function updateEssential(node, { pin, tab }) {
  node.dataset.kind = 'pin';
  node.dataset.id = pin.id;
  const drifted = !!tab && isDrifted(pin, tabUrl(tab));
  node.classList.toggle('active', !!tab?.active);
  node.classList.toggle('unloaded', !tab);
  node.classList.toggle('drifted', drifted);
  node.title = pinTitle(pin, drifted ? null : tab) + (drifted ? `\nNow: ${tab.title || tabUrl(tab)}\nClick again to go back` : '');
  setImg(node.querySelector('img'), faviconFor(drifted ? null : tab, pin));
}

function createRow() {
  const node = document.createElement('div');
  node.className = 'row';
  node.draggable = true;
  node.innerHTML = `
    <span class="fav"><img alt="" draggable="false"><span class="reset" title="Back to pinned page">${svg('rotateCcw')}</span></span>
    <span class="sep">/</span>
    <span class="title"></span>
    <button class="audio icon-btn sm"></button>
    <button class="close icon-btn sm">${svg('x')}</button>`;
  return node;
}

function setAudio(node, tab) {
  const muted = !!tab?.mutedInfo?.muted;
  node.classList.toggle('audible', !!tab?.audible);
  node.classList.toggle('muted', muted);
  const btn = node.querySelector('.audio');
  const icon = muted ? 'volumeX' : 'volume';
  if (btn.dataset.icon !== icon) {
    btn.dataset.icon = icon;
    btn.innerHTML = svg(icon);
    btn.title = muted ? 'Unmute' : 'Mute';
  }
}

function updatePinRow(node, { pin, tab }) {
  node.dataset.kind = 'pin';
  node.dataset.id = pin.id;
  const url = tabUrl(tab);
  const drifted = !!tab && isDrifted(pin, url);
  node.classList.toggle('active', !!tab?.active);
  node.classList.toggle('unloaded', !tab);
  node.classList.toggle('discarded', !!tab?.discarded);
  node.classList.toggle('drifted', drifted);
  setText(node.querySelector('.title'), pinTitle(pin, tab));
  node.title = [pin.title || pin.defaultTitle, drifted ? `Now: ${tab.title || url}` : '', pin.url].filter(Boolean).join('\n');
  node.querySelector('.close').title = 'Unload';
  setImg(node.querySelector('img'), faviconFor(tab, pin));
  setAudio(node, tab);
}

function updateTabRow(node, tab) {
  node.dataset.kind = 'tab';
  node.dataset.id = tab.id;
  const url = tabUrl(tab);
  node.classList.toggle('active', tab.active);
  node.classList.toggle('discarded', !!tab.discarded);
  node.classList.remove('drifted', 'unloaded');
  setText(node.querySelector('.title'), tab.title || (isWebUrl(url) ? hostname(url) : 'New Tab'));
  node.title = [tab.title, url].filter(Boolean).join('\n');
  node.querySelector('.close').title = 'Close tab';
  setImg(node.querySelector('img'), faviconFor(tab));
  setAudio(node, tab);
}

function createSpaceButton() {
  const node = document.createElement('button');
  node.className = 'space-btn';
  return node;
}

function updateSpaceButton(node, space, active) {
  node.dataset.spaceId = space.id;
  const shortcut = spaceShortcuts[config.spaces.indexOf(space)];
  node.title = shortcut ? `${space.name} (${shortcut})` : space.name;
  node.style.setProperty('--c', COLORS[space.color] ?? COLORS.grey);
  node.classList.toggle('active', active);
  const content = space.icon || '';
  if (node.dataset.content !== content) {
    node.dataset.content = content;
    if (content) node.textContent = content;
    else node.innerHTML = '<span class="dot"></span>';
  }
}

// ---------------------------------------------------------------------------------------
// Toolbar

$('#back').innerHTML = svg('arrowLeft');
$('#forward').innerHTML = svg('arrowRight');
$('#reload').innerHTML = svg('rotateCw');
$('#space-menu').innerHTML = svg('more');
$('#settings').innerHTML = svg('sliders');
$('#add-space').innerHTML = svg('plus');
$('#new-tab .fav').innerHTML = svg('plus');
$('#essentials').dataset.hint = 'Drop here to add to Essentials';
$('#pins').dataset.hint = 'Drop here to pin';

const withActive = fn => {
  const t = activeTab();
  if (t) fn(t).catch(() => {});
};
$('#back').onclick = () => withActive(t => chrome.tabs.goBack(t.id));
$('#forward').onclick = () => withActive(t => chrome.tabs.goForward(t.id));
$('#reload').onclick = () => withActive(t => chrome.tabs.reload(t.id));

const urlInput = $('#url');
urlInput.addEventListener('focus', () => {
  const url = tabUrl(activeTab());
  urlInput.value = url.startsWith('chrome://newtab') ? '' : url;
  setTimeout(() => urlInput.select());
});
urlInput.addEventListener('blur', renderToolbar);
urlInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') urlInput.blur();
});
$('#urlbar').addEventListener('submit', e => {
  e.preventDefault();
  const text = urlInput.value.trim();
  const tab = activeTab();
  if (!text || !tab) return;
  navigate(tab, text);
  urlInput.blur();
});

function navigate(tab, text) {
  if (/^[a-z][\w+.-]*:\/\//i.test(text) || /^(about|chrome):/i.test(text)) {
    return chrome.tabs.update(tab.id, { url: text });
  }
  if (!/\s/.test(text) && /^localhost(:\d+)?([/?#].*)?$/i.test(text)) {
    return chrome.tabs.update(tab.id, { url: 'http://' + text });
  }
  if (!/\s/.test(text) && /^([\w-]+\.)+[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)) {
    return chrome.tabs.update(tab.id, { url: 'https://' + text });
  }
  return chrome.search.query({ text, tabId: tab.id });
}

// ---------------------------------------------------------------------------------------
// Clicks

const toggleMute = tab => tab && chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });

$('#essentials').addEventListener('click', e => {
  const node = e.target.closest('.ess');
  if (node) send('openPin', { windowId, pinId: node.dataset.id });
});

$('#essentials').addEventListener('auxclick', e => {
  const node = e.target.closest('.ess');
  if (node && e.button === 1) send('unloadPin', { windowId, pinId: node.dataset.id });
});

$('#pins').addEventListener('click', e => {
  const node = e.target.closest('.row');
  if (!node || node.dataset.editing) return;
  const pinId = node.dataset.id;
  if (e.target.closest('.close')) return send('unloadPin', { windowId, pinId });
  if (e.target.closest('.audio')) return toggleMute(boundTabOf(pinId));
  if (e.target.closest('.fav') && node.classList.contains('drifted')) return send('resetPin', { windowId, pinId });
  send('openPin', { windowId, pinId });
});

$('#pins').addEventListener('auxclick', e => {
  const node = e.target.closest('.row');
  if (node && e.button === 1) send('unloadPin', { windowId, pinId: node.dataset.id });
});

$('#tabs').addEventListener('click', e => {
  const node = e.target.closest('.row');
  if (!node) return;
  const tabId = +node.dataset.id;
  if (e.target.closest('.close')) return send('closeTabs', { windowId, tabIds: [tabId] });
  if (e.target.closest('.audio')) return toggleMute(tabs.find(t => t.id === tabId));
  chrome.tabs.update(tabId, { active: true });
});

$('#tabs').addEventListener('auxclick', e => {
  const node = e.target.closest('.row');
  if (node && e.button === 1) send('closeTabs', { windowId, tabIds: [+node.dataset.id] });
});

$('#new-tab').onclick = () => send('newTab', { windowId, spaceId: activeSpaceId() });
$('#clear').onclick = () => send('clearSpace', { windowId, spaceId: activeSpaceId() });
$('#space-name').addEventListener('dblclick', () => renameSpaceInline());
$('#space-menu').onclick = e => openMenu(e, spaceMenu(activeSpaceId()));
$('#settings').onclick = e => openSettings(e);
$('#add-space').onclick = e => openSpaceEditor(e, null);
$('#spaces').addEventListener('click', e => {
  const btn = e.target.closest('.space-btn');
  if (btn) send('switchSpace', { windowId, spaceId: btn.dataset.spaceId });
});

// Horizontal trackpad swipe switches spaces.
let swipeAccum = 0;
let swipeLocked = false;
let swipeUnlockTimer = null;
document.addEventListener(
  'wheel',
  e => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || e.target.closest('#menu, #popover, #spaces')) return;
    clearTimeout(swipeUnlockTimer);
    swipeUnlockTimer = setTimeout(() => {
      swipeLocked = false;
      swipeAccum = 0;
    }, 220);
    if (swipeLocked) return;
    swipeAccum += e.deltaX;
    if (Math.abs(swipeAccum) > 90) {
      swipeLocked = true;
      send('stepSpace', { windowId, delta: swipeAccum > 0 ? 1 : -1 });
      swipeAccum = 0;
    }
  },
  { passive: true },
);

// ---------------------------------------------------------------------------------------
// Context menus

document.addEventListener('contextmenu', e => {
  if (e.target.closest('input')) return;
  e.preventDefault();
  const spaceBtn = e.target.closest('.space-btn');
  if (spaceBtn) return openMenu(e, spaceMenu(spaceBtn.dataset.spaceId));
  if (e.target.closest('#space-header')) return openMenu(e, spaceMenu(activeSpaceId()));
  const node = e.target.closest('[data-kind]');
  if (!node) return;
  if (node.dataset.kind === 'tab') openMenu(e, tabMenu(+node.dataset.id));
  else openMenu(e, pinMenu(node.dataset.id, node));
});

function moveToSpaceItems(run, excludeId) {
  const others = config.spaces.filter(s => s.id !== excludeId);
  if (!others.length) return [];
  return ['-', { label: 'Move to space' }, ...others.map(s => ({ space: s, label: s.name, run: () => run(s.id) }))];
}

function tabMenu(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab) return [];
  const spaceId = activeSpaceId();
  const muted = !!tab.mutedInfo?.muted;
  return [
    { icon: 'pin', label: 'Pin tab', run: () => send('pinTab', { tabId, spaceId }) },
    { icon: 'star', label: 'Add to Essentials', run: () => send('pinTab', { tabId, spaceId: null }) },
    ...moveToSpaceItems(id => send('moveTab', { tabId, spaceId: id }), spaceId),
    '-',
    { icon: 'link', label: 'Copy link', run: () => navigator.clipboard.writeText(tabUrl(tab)) },
    { icon: 'duplicate', label: 'Duplicate', run: () => chrome.tabs.duplicate(tabId) },
    { icon: muted ? 'volume' : 'volumeX', label: muted ? 'Unmute tab' : 'Mute tab', run: () => toggleMute(tab) },
    !tab.active && !tab.discarded && { icon: 'moon', label: 'Unload tab', run: () => chrome.tabs.discard(tabId) },
    '-',
    { icon: 'x', label: 'Close tab', run: () => send('closeTabs', { windowId, tabIds: [tabId] }) },
  ];
}

function pinMenu(pinId, node) {
  const pin = config.pins[pinId];
  if (!pin) return [];
  const tab = boundTabOf(pinId);
  const drifted = !!tab && isDrifted(pin, tabUrl(tab));
  const essential = pin.spaceId == null;
  const spaceId = activeSpaceId();
  return [
    {
      icon: 'pencil',
      label: 'Rename…',
      run: () => (essential ? renamePinPopover(node, pin) : renamePinInline(node, pin)),
    },
    { icon: 'link', label: 'Edit pinned URL…', run: () => editPinUrl(node, pin) },
    drifted && '-',
    drifted && { icon: 'rotateCcw', label: 'Go back to pinned URL', run: () => send('resetPin', { windowId, pinId }) },
    drifted && {
      icon: 'pin',
      label: 'Replace pinned URL with current',
      run: () => send('setPinUrl', { pinId, url: tabUrl(tab), title: tab.title }),
    },
    '-',
    essential
      ? { icon: 'pin', label: 'Move to pinned tabs', run: () => send('movePin', { pinId, spaceId }) }
      : { icon: 'star', label: 'Add to Essentials', run: () => send('movePin', { pinId, spaceId: null }) },
    ...(essential ? [] : moveToSpaceItems(id => send('movePin', { pinId, spaceId: id }), pin.spaceId)),
    '-',
    { icon: 'copy', label: 'Copy pinned URL', run: () => navigator.clipboard.writeText(pin.url) },
    tab && { icon: 'moon', label: 'Unload', run: () => send('unloadPin', { windowId, pinId }) },
    tab && {
      icon: 'pinOff',
      label: essential ? 'Remove from Essentials (keep tab)' : 'Unpin (keep tab)',
      run: () => send('unpin', { pinId, windowId }),
    },
    {
      icon: 'trash',
      label: essential ? 'Delete Essential' : 'Delete pinned tab',
      danger: true,
      run: () => send('removePin', { pinId }),
    },
  ];
}

function spaceMenu(spaceId) {
  const space = config.spaces.find(s => s.id === spaceId);
  if (!space) return [];
  const i = config.spaces.indexOf(space);
  const order = config.spaces.map(s => s.id);
  const move = delta => {
    order.splice(i, 1);
    order.splice(i + delta, 0, spaceId);
    send('reorderSpaces', { order });
  };
  return [
    { icon: 'pencil', label: 'Edit space…', run: () => openSpaceEditor(lastMenuPoint, space) },
    { icon: 'plus', label: 'New space…', run: () => openSpaceEditor(lastMenuPoint, null) },
    '-',
    i > 0 && { icon: 'chevronLeft', label: 'Move left', run: () => move(-1) },
    i < config.spaces.length - 1 && { icon: 'chevronRight', label: 'Move right', run: () => move(1) },
    '-',
    config.spaces.length > 1 && {
      icon: 'trash',
      label: 'Delete space…',
      danger: true,
      run: () => confirmDeleteSpace(space),
    },
  ];
}

let lastMenuPoint = { clientX: 0, clientY: 0 };

function openMenu(e, rawItems) {
  closePopover();
  lastMenuPoint = { clientX: e.clientX, clientY: e.clientY };
  // Drop falsy entries and collapse leading/trailing/double separators.
  const items = [];
  for (const it of rawItems.filter(Boolean)) {
    if (it === '-' && (!items.length || items.at(-1) === '-')) continue;
    items.push(it);
  }
  while (items.at(-1) === '-') items.pop();
  if (!items.length) return;

  const menu = $('#menu');
  menu.replaceChildren();
  for (const it of items) {
    if (it === '-') {
      menu.append(Object.assign(document.createElement('div'), { className: 'sep' }));
    } else if (!it.run) {
      menu.append(Object.assign(document.createElement('div'), { className: 'label', textContent: it.label }));
    } else {
      const btn = document.createElement('button');
      btn.className = 'item' + (it.danger ? ' danger' : '');
      if (it.icon) btn.innerHTML = svg(it.icon);
      else if (it.space) {
        const mark = document.createElement('span');
        mark.style.cssText = 'width:15px;display:grid;place-items:center';
        if (it.space.icon) mark.textContent = it.space.icon;
        else
          mark.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${COLORS[it.space.color] ?? COLORS.grey}"></span>`;
        btn.append(mark);
      }
      btn.append(Object.assign(document.createElement('span'), { textContent: it.label }));
      btn.onclick = () => {
        closeMenu();
        it.run();
      };
      menu.append(btn);
    }
  }
  menu.hidden = false;
  place(menu, e.clientX, e.clientY);
}

function place(node, x, y) {
  node.style.left = '0px';
  node.style.top = '0px';
  const r = node.getBoundingClientRect();
  node.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  node.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}

const closeMenu = () => ($('#menu').hidden = true);
const closePopover = () => ($('#popover').hidden = true);

document.addEventListener('mousedown', e => {
  if (!e.target.closest('#menu')) closeMenu();
  if (!e.target.closest('#popover')) closePopover();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeMenu();
    closePopover();
  }
});
window.addEventListener('blur', closeMenu);

// ---------------------------------------------------------------------------------------
// Inline editing & popovers

function renamePinInline(node, pin) {
  if (!node || node.dataset.editing) return;
  const title = node.querySelector('.title');
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = pin.title || title.textContent;
  input.placeholder = pin.defaultTitle || 'Leave empty to use the page title';
  node.dataset.editing = '1';
  node.draggable = false;
  title.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = save => {
    if (finished) return;
    finished = true;
    input.replaceWith(title);
    delete node.dataset.editing;
    node.draggable = true;
    if (save) send('renamePin', { pinId: pin.id, title: input.value });
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
}

function renameSpaceInline() {
  const nameEl = $('#space-name');
  if (nameEl.dataset.editing) return;
  const spaceId = activeSpaceId();
  const space = config.spaces.find(s => s.id === spaceId);
  const input = document.createElement('input');
  input.value = space.name;
  nameEl.dataset.editing = '1';
  nameEl.replaceChildren(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = save => {
    if (finished) return;
    finished = true;
    delete nameEl.dataset.editing;
    nameEl.textContent = save && input.value.trim() ? input.value.trim() : space.name;
    if (save && input.value.trim()) send('updateSpace', { spaceId, name: input.value });
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function openPopover(point, build) {
  closeMenu();
  // Start from a fresh element so listeners from a previous popover can't fire again.
  const pop = $('#popover').cloneNode(false);
  $('#popover').replaceWith(pop);
  build(pop);
  pop.hidden = false;
  const x = point?.clientX ?? point?.left ?? 8;
  const y = point?.clientY ?? point?.top ?? 8;
  place(pop, x, y);
  pop.querySelector('input')?.focus();
  pop.querySelector('input')?.select();
}

const anchorPoint = node => {
  const r = node?.getBoundingClientRect();
  return r ? { clientX: r.left, clientY: r.bottom + 4 } : lastMenuPoint;
};

function promptPopover(point, { title, value, placeholder, confirm = 'Save', onSave }) {
  openPopover(point, pop => {
    pop.innerHTML = `<h3></h3><label><input></label>
      <div class="actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save"></button></div>`;
    pop.querySelector('h3').textContent = title;
    pop.querySelector('[data-act=save]').textContent = confirm;
    const input = pop.querySelector('input');
    input.value = value ?? '';
    input.placeholder = placeholder ?? '';
    const save = () => {
      closePopover();
      onSave(input.value);
    };
    input.addEventListener('keydown', e => e.key === 'Enter' && save());
    pop.querySelector('[data-act=save]').onclick = save;
    pop.querySelector('[data-act=cancel]').onclick = closePopover;
  });
}

function renamePinPopover(node, pin) {
  promptPopover(anchorPoint(node), {
    title: 'Rename',
    value: pin.title,
    placeholder: pin.defaultTitle || 'Leave empty to use the page title',
    onSave: title => send('renamePin', { pinId: pin.id, title }),
  });
}

function editPinUrl(node, pin) {
  promptPopover(anchorPoint(node), {
    title: 'Pinned URL',
    value: pin.url,
    placeholder: 'https://',
    onSave: url => {
      url = url.trim();
      if (!url) return;
      if (!/^[a-z][\w+.-]*:/i.test(url)) url = 'https://' + url;
      send('setPinUrl', { pinId: pin.id, url });
    },
  });
}

function openSpaceEditor(point, space) {
  openPopover(point, pop => {
    pop.innerHTML = `<h3></h3>
      <div class="row-inputs">
        <label>Icon<input name="icon" maxlength="8" placeholder="🙂"></label>
        <label style="flex:1">Name<input name="name" placeholder="Space name"></label>
      </div>
      <div class="swatches"></div>
      <div class="actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="save"></button></div>`;
    pop.querySelector('h3').textContent = space ? 'Edit space' : 'New space';
    pop.querySelector('[data-act=save]').textContent = space ? 'Save' : 'Create';
    const nameInput = pop.querySelector('[name=name]');
    const iconInput = pop.querySelector('[name=icon]');
    nameInput.value = space?.name ?? '';
    iconInput.value = space?.icon ?? '';
    const used = new Set(config.spaces.map(s => s.color));
    let color = space?.color ?? Object.keys(COLORS).find(c => !used.has(c)) ?? 'grey';
    const swatches = pop.querySelector('.swatches');
    for (const [name, hex] of Object.entries(COLORS)) {
      const sw = document.createElement('button');
      sw.className = 'swatch' + (name === color ? ' selected' : '');
      sw.style.setProperty('--c', hex);
      sw.title = name;
      sw.onclick = () => {
        color = name;
        swatches.querySelectorAll('.swatch').forEach(s => s.classList.toggle('selected', s === sw));
      };
      swatches.append(sw);
    }
    const save = () => {
      closePopover();
      const payload = { name: nameInput.value, icon: iconInput.value, color };
      if (space) send('updateSpace', { spaceId: space.id, ...payload });
      else send('createSpace', { windowId, ...payload });
    };
    for (const input of [nameInput, iconInput]) input.addEventListener('keydown', e => e.key === 'Enter' && save());
    pop.querySelector('[data-act=save]').onclick = save;
    pop.querySelector('[data-act=cancel]').onclick = closePopover;
  });
  setTimeout(() => $('#popover [name=name]')?.focus());
}

function confirmDeleteSpace(space) {
  const count = tabs.filter(t => spaceOf(t) === space.id).length;
  openPopover(lastMenuPoint, pop => {
    pop.innerHTML = `<h3></h3><div style="color:var(--muted);font-size:12px"></div>
      <div class="actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="ok">Delete</button></div>`;
    pop.querySelector('h3').textContent = `Delete “${space.name}”?`;
    pop.querySelector('div').textContent =
      `Its pinned tabs are removed` + (count ? ` and ${count} open tab${count === 1 ? '' : 's'} in this window will close.` : '.');
    pop.querySelector('[data-act=ok]').onclick = () => {
      closePopover();
      send('deleteSpace', { spaceId: space.id });
    };
    pop.querySelector('[data-act=cancel]').onclick = closePopover;
  });
}

function openSettings(e) {
  openPopover({ clientX: e.clientX, clientY: e.clientY - 200 }, pop => {
    pop.innerHTML = `<h3>Settings</h3>
      <label class="toggle"><span>Collapse other spaces in the tab strip<small>Only the current space's tab group stays expanded.</small></span><input type="checkbox" name="collapseInactive"></label>
      <label class="toggle"><span>Click an active pinned tab to reset it<small>Sends it back to its pinned URL after you've navigated away.</small></span><input type="checkbox" name="resetOnReclick"></label>
      <label class="toggle"><span>Option-click a link to Peek<small>Opens it in a floating window. Esc closes it, ⌘↩ keeps it as a tab.</small></span><input type="checkbox" name="peekOnAltClick"></label>
      <label class="toggle"><span>Open links from Essentials in Peek<small>Your Essential stays put behind the Peek.</small></span><input type="checkbox" name="peekFromEssentials"></label>
      <label class="toggle"><span>Open Peek in split view<small>Beside the current tab instead of a floating window. Full screen always uses split view.</small></span><input type="checkbox" name="peekInSplitView"></label>
      <div class="links"><a data-act="export">Export setup…</a><a data-act="import">Import setup…</a><a data-act="shortcuts">Keyboard shortcuts…</a></div>`;
    for (const input of pop.querySelectorAll('input[type=checkbox]')) {
      input.checked = !!config.settings[input.name];
      input.onchange = () => send('updateSettings', { patch: { [input.name]: input.checked } });
    }
    pop.querySelector('[data-act=shortcuts]').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    pop.querySelector('[data-act=export]').onclick = exportSetup;
    pop.querySelector('[data-act=import]').onclick = () => {
      closePopover();
      importPicker.click();
    };
  });
}

// ---------------------------------------------------------------------------------------
// Export / import of spaces, pinned tabs, Essentials and settings

async function exportSetup() {
  closePopover();
  const data = await send('exportConfig');
  if (!data) return showToast('Couldn’t export');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const link = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `cove-setup-${new Date().toISOString().slice(0, 10)}.json`,
  });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  showToast('Setup exported');
}

const importPicker = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
importPicker.addEventListener('change', async () => {
  const file = importPicker.files[0];
  importPicker.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return showToast('That file isn’t valid JSON');
  }
  const spaces = Array.isArray(data?.config?.spaces) ? data.config.spaces.length : 0;
  const pins = data?.config?.pins && typeof data.config.pins === 'object' ? Object.keys(data.config.pins).length : 0;
  openPopover({ clientX: 8, clientY: innerHeight / 3 }, pop => {
    pop.innerHTML = `<h3>Import setup?</h3><div class="note"></div>
      <div class="actions"><button class="btn" data-act="cancel">Cancel</button><button class="btn primary" data-act="ok">Import</button></div>`;
    pop.querySelector('.note').textContent =
      `Replaces your current spaces, pinned tabs, Essentials and settings with ${spaces} space${spaces === 1 ? '' : 's'} ` +
      `and ${pins} pinned tab${pins === 1 ? '' : 's'}/Essential${pins === 1 ? '' : 's'} from ${file.name}. Open tabs stay open.`;
    pop.querySelector('[data-act=cancel]').onclick = closePopover;
    pop.querySelector('[data-act=ok]').onclick = async () => {
      closePopover();
      const res = await chrome.runtime.sendMessage({ type: 'importConfig', data });
      showToast(res?.ok ? `Imported ${res.result.spaces} spaces, ${res.result.pins} pins` : res?.error || 'Import failed');
    };
  });
});

// ---------------------------------------------------------------------------------------
// Drag & drop
//   tab   -> Essentials / pinned list    : pin it there
//   pin   -> Essentials / pinned list    : move / reorder the pin
//   tab   -> tab list                    : reorder (moves the Chrome tab)
//   pin   -> tab list                    : unpin, keep the tab where it was dropped
//   either -> space button               : move to that space

const zones = [$('#essentials'), $('#pins'), $('#tabs')];

function clearIndicators() {
  document.querySelectorAll('.drop-before, .drop-end, .drop-target').forEach(n => {
    n.classList.remove('drop-before', 'drop-end', 'drop-target');
  });
}

function endDrag() {
  drag?.node.classList.remove('dragging-el');
  document.body.classList.remove('dragging');
  clearIndicators();
  drag = null;
  if (renderDeferred) {
    renderDeferred = false;
    schedule();
  }
}

function dropPosition(zone, e) {
  const items = [...zone.children].filter(c => c.dataset.kind && c !== drag.node);
  const grid = zone.id === 'essentials';
  for (let i = 0; i < items.length; i++) {
    const r = items[i].getBoundingClientRect();
    const before = grid
      ? e.clientY < r.top || (e.clientY < r.bottom && e.clientX < r.left + r.width / 2)
      : e.clientY < r.top + r.height / 2;
    if (before) return { index: i, beforeNode: items[i] };
  }
  return { index: items.length, beforeNode: null };
}

document.addEventListener('dragstart', e => {
  const node = e.target.closest?.('[data-kind]');
  if (!node || node.dataset.editing) return;
  drag = { kind: node.dataset.kind, id: node.dataset.kind === 'tab' ? +node.dataset.id : node.dataset.id, node };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', '');
  requestAnimationFrame(() => {
    node.classList.add('dragging-el');
    document.body.classList.add('dragging');
  });
});
document.addEventListener('dragend', endDrag);

for (const zone of zones) {
  zone.addEventListener('dragover', e => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const { beforeNode } = dropPosition(zone, e);
    clearIndicators();
    if (beforeNode) beforeNode.classList.add('drop-before');
    else zone.classList.add('drop-end');
  });
  zone.addEventListener('dragleave', e => {
    if (!zone.contains(e.relatedTarget)) clearIndicators();
  });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    if (drag) handleDrop(zone, e);
    endDrag();
  });
}

function handleDrop(zone, e) {
  const { index, beforeNode } = dropPosition(zone, e);
  const spaceId = activeSpaceId();
  const { kind, id } = drag;
  if (zone.id === 'tabs') {
    const beforeTabId = beforeNode ? +beforeNode.dataset.id : null;
    if (kind === 'tab') send('moveTab', { tabId: id, spaceId, beforeTabId });
    else send('unpin', { pinId: id, windowId, spaceId, beforeTabId, place: true });
    return;
  }
  const target = zone.id === 'essentials' ? null : spaceId;
  if (kind === 'tab') send('pinTab', { tabId: id, spaceId: target, index });
  else send('movePin', { pinId: id, spaceId: target, index });
}

$('#spaces').addEventListener('dragover', e => {
  const btn = e.target.closest('.space-btn');
  if (!drag || !btn) return;
  e.preventDefault();
  clearIndicators();
  btn.classList.add('drop-target');
});
$('#spaces').addEventListener('drop', e => {
  const btn = e.target.closest('.space-btn');
  e.preventDefault();
  if (drag && btn) {
    const spaceId = btn.dataset.spaceId;
    if (drag.kind === 'tab') send('moveTab', { tabId: drag.id, spaceId });
    else send('movePin', { pinId: drag.id, spaceId });
  }
  endDrag();
});

// ---------------------------------------------------------------------------------------
// Boot

let toastTimer;
function showToast(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}
const SERVICE_WORKER = chrome.runtime.getURL('src/background.js');
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.url !== SERVICE_WORKER) return;
  if (msg?.target === 'panel' && msg.type === 'toast' && msg.windowId === windowId) showToast(msg.text);
});

chrome.storage.onChanged.addListener(schedule);
for (const ev of ['onCreated', 'onUpdated', 'onRemoved', 'onMoved', 'onActivated', 'onAttached', 'onDetached', 'onReplaced']) {
  chrome.tabs[ev].addListener(schedule);
}
for (const ev of ['onCreated', 'onUpdated', 'onRemoved', 'onMoved']) chrome.tabGroups[ev].addListener(schedule);

async function loadShortcuts() {
  spaceShortcuts = {};
  for (const c of await chrome.commands.getAll()) {
    const n = c.name.match(/^space-(\d)$/)?.[1];
    if (n && c.shortcut) spaceShortcuts[n - 1] = c.shortcut;
  }
  render();
}
// Shortcuts can change on chrome://extensions/shortcuts while the panel is open.
window.addEventListener('focus', loadShortcuts);

windowId = (await chrome.windows.getCurrent()).id;
await refresh();
await loadShortcuts();
