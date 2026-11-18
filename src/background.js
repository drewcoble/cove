// Cove service worker.
//
// Model:
//   - A space is backed by one Chrome tab group per window (group title = space name), so
//     space-mates stay contiguous in the tab strip and inactive spaces can be collapsed.
//   - Essentials are Chrome-pinned tabs (shared by every space, never grouped).
//   - Pinned tabs are entries in a space's `pins` list. A pin is "bound" to at most one live
//     tab per window; closing that tab leaves the pin in the sidebar, unloaded.
//
//   - Folders organize a space's pinned tabs (nested, per space). They're purely a sidebar
//     grouping: Chrome still has one tab group per space.
//
// Persistent config (spaces, pins, folders, settings) lives in storage.local. The closed-tab
// archive has its own storage.local key, so tab closes never rewrite the setup and setup
// edits never rewrite the archive. Runtime bookkeeping keyed by tab/group/window ids lives in
// storage.session, which survives service-worker restarts but not browser restarts; on a
// fresh browser session `reconcile()` rebuilds it from the restored tab groups and tab URLs.

import { validParent, descendants, tabSpace as treeSpace } from './tab-tree.js';
import { destinationKey, searchMemoryText, normalizeSearchMemory } from './search-ranking.js';
import { isLauncherOrNewTab, isNewTabUrl, navigationUrl } from './search.js';
import { COLORS, newId, sameUrl, isDrifted, isWebUrl, redactUrl } from './shared.js';

const SETTLE_GRACE_MS = 1500;
const ACTIVATION_RACE_MS = 300;
const MAX_ALIASES = 4;
const MAX_ARCHIVE = 500;
const MAX_SEARCH_MEMORY = { searches: 50, selections: 100 };

let config;
let rt;
let archive = []; // closed tabs, newest first (storage.local 'archive')
// Last-known url/title per tab, so a tab closed from Chrome's own UI can still be archived.
// Kept in memory and saved to storage.session only when it changes (debounced).
const tabSnapshots = new Map();
const lastActivation = new Map(); // windowId -> { prev, curr, at }
const expectedRemovals = new Set(); // tabs we close ourselves (we pick the successor up front)
const settling = new Map(); // tabId -> { completedAt } while a freshly opened pin may still redirect
const windowTypes = new Map();

function defaultConfig() {
  return {
    version: 2,
    fresh: true,
    spaces: [{ id: newId(), name: 'Main', icon: '', color: 'blue', pins: [] }],
    essentials: [],
    pins: {},
    folders: {}, // id -> { id, name, spaceId, parentId, collapsed }
    settings: {
      collapseInactive: true,
      resetOnReclick: true,
      peekOnAltClick: true,
      peekFromEssentials: true,
      peekInSplitView: false,
      searchHistory: true,
      archiveClosedTabs: true,
    },
  };
}

function emptyRt() {
  return {
    initialized: false,
    groupSpace: {}, // groupId -> spaceId
    activeSpace: {}, // windowId -> spaceId
    lastSpace: null,
    tabSpace: {}, // tabId -> spaceId (kept so we still know a tab's space in onRemoved)
    tabPin: {}, // tabId -> pinId
    mru: {}, // windowId -> [tabId, ...] most recent first
    peeks: {}, // peek popup windowId -> { tabId, parentWindowId, spaceId }
    tabPeeks: {}, // tab-based peek tabId -> { parentWindowId, returnTabId, split }
    tabParent: {},
    treeDetached: {},
    treeCollapsed: {},
    searches: {}, // launcher token -> { tabId, windowId, overlay } for an open search
  };
}

function normalizeConfig(c) {
  const cfg = c ?? defaultConfig();
  cfg.settings = { ...defaultConfig().settings, ...cfg.settings };
  cfg.pins ??= {};
  cfg.essentials = (cfg.essentials ?? []).filter(id => cfg.pins[id]);
  if (!cfg.spaces?.length) cfg.spaces = defaultConfig().spaces;
  for (const s of cfg.spaces) s.pins = (s.pins ?? []).filter(id => cfg.pins[id]);
  for (const pin of Object.values(cfg.pins)) {
    pin.lastUrl = pin.lastUrl && redactUrl(pin.lastUrl, { keepHash: true });
    pin.aliases = [...new Set((pin.aliases ?? []).map(url => redactUrl(url, { keepHash: true })).filter(Boolean))];
  }
  repairFolders(cfg);
  cfg.version = 2;
  return cfg;
}

// Folders may come from storage written by an older build or from an imported file, so make
// them consistent: every folder belongs to an existing space, a parent is in the same space,
// there are no cycles, and a pin's folder is in the pin's own space.
function repairFolders(cfg) {
  cfg.folders = cfg.folders && typeof cfg.folders === 'object' ? cfg.folders : {};
  const spaceIds = new Set(cfg.spaces.map(s => s.id));
  for (const [id, folder] of Object.entries(cfg.folders)) {
    if (!folder || folder.id !== id || !spaceIds.has(folder.spaceId)) delete cfg.folders[id];
  }
  for (const folder of Object.values(cfg.folders)) {
    const parent = cfg.folders[folder.parentId];
    if (!parent || parent.spaceId !== folder.spaceId) folder.parentId = null;
  }
  // Break cycles: walk up from each folder; if we revisit one, detach the folder we started at.
  for (const folder of Object.values(cfg.folders)) {
    const seen = new Set([folder.id]);
    for (let p = cfg.folders[folder.parentId]; p; p = cfg.folders[p.parentId]) {
      if (seen.has(p.id)) {
        folder.parentId = null;
        break;
      }
      seen.add(p.id);
    }
  }
  for (const pin of Object.values(cfg.pins)) {
    const folder = cfg.folders[pin.folderId];
    pin.folderId = folder && pin.spaceId != null && folder.spaceId === pin.spaceId ? pin.folderId : null;
  }
}

// Archive entries only ever hold web pages, with sign-in parameters stripped.
function normalizeArchive(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map(e => ({ ...e, url: redactUrl(e?.url, { keepHash: true }), favIconUrl: isWebUrl(e?.favIconUrl) ? e.favIconUrl : '' }))
    .filter(e => e.id && isWebUrl(e.url))
    .slice(0, MAX_ARCHIVE);
}

// ---------------------------------------------------------------------------------------
// Serialized execution: every event and message runs through one queue so async handlers
// never interleave, and state is flushed to storage once per task.

let treeRestoreIdentity;
const tabWindows = new Map(); // tab id -> window id, never a URL
let lastTreeShape = null;
let treeSaveTimer;
let browserStarting = false;
let dirtyConfig = false;
let dirtyRt = false;
let dirtyTree = false;
let dirtyArchive = false;
const touchConfig = () => (dirtyConfig = true);
const touchRt = () => (dirtyRt = true);
const touchArchive = () => (dirtyArchive = true);
const touchTree = () => { dirtyTree = true; touchRt(); };

async function flush() {
  const writes = [];
  if (dirtyConfig) {
    dirtyConfig = false;
    // peekOnAltClick is mirrored to its own key: peek-trigger.js runs on every site and reads
    // only that, so your pinned URLs and names are never loaded into web pages.
    writes.push(chrome.storage.local.set({ config, peekOnAltClick: !!config.settings.peekOnAltClick }));
  }
  if (dirtyRt) {
    dirtyRt = false;
    writes.push(chrome.storage.session.set({ rt }));
  }
  if (dirtyTree) {
    dirtyTree = false;
    const shape = JSON.stringify({ parents: rt.tabParent, detached: rt.treeDetached, collapsed: rt.treeCollapsed });
    if (shape !== lastTreeShape) {
      lastTreeShape = shape;
      clearTimeout(treeSaveTimer);
      treeSaveTimer = setTimeout(() => enqueue(saveTabTree), 300);
    }
  }
  if (dirtyArchive) {
    dirtyArchive = false;
    writes.push(chrome.storage.local.set({ archive }));
  }
  await Promise.all(writes);
}

async function saveTabTree() {
  const ids = new Set([...Object.keys(rt.tabParent), ...Object.values(rt.tabParent).map(String),
    ...Object.keys(rt.treeDetached), ...Object.keys(rt.treeCollapsed).map(key => key.slice(key.lastIndexOf(':') + 1))]);
  const identities = Object.fromEntries([...ids].filter(id => tabWindows.has(+id))
    .map(id => [id, { windowId: tabWindows.get(+id) }]));
  await chrome.storage.local.set({ tabTreeState: {
    parents: rt.tabParent, detached: rt.treeDetached, collapsed: rt.treeCollapsed, identities,
  } });
}

// Chrome may recycle tab/window ids in a new browser session. Keep extension-reload
// recovery within a session, but never attach yesterday's tree to today's reused ids.
chrome.runtime.onStartup.addListener(() => {
  browserStarting = true;
  enqueue(async () => {
    clearTimeout(treeSaveTimer);
    rt.tabParent = {}; rt.treeDetached = {}; rt.treeCollapsed = {};
    lastTreeShape = JSON.stringify({ parents: rt.tabParent, detached: rt.treeDetached, collapsed: rt.treeCollapsed });
    await chrome.storage.local.remove('tabTreeState');
    touchRt();
  });
});

const ready = (async () => {
  const [{ config: c, archive: a, searchMemory, tabTreeState }, { rt: r, tabSnapshots: snaps }] = await Promise.all([
    chrome.storage.local.get(['config', 'archive', 'searchMemory', 'tabTreeState']),
    chrome.storage.session.get(['rt', 'tabSnapshots']),
  ]);
  const stored = JSON.stringify(c);
  config = normalizeConfig(c);
  rt = { ...emptyRt(), ...r };
  if (searchMemory) {
    const normalized = normalizeSearchMemory(searchMemory);
    if (JSON.stringify(normalized) !== JSON.stringify(searchMemory)) {
      await chrome.storage.local.set({ searchMemory: normalized });
    }
  }
  if (!browserStarting && !r?.tabParent && tabTreeState) {
    rt.tabParent = tabTreeState.parents || {}; rt.treeCollapsed = tabTreeState.collapsed || {};
    rt.treeDetached = tabTreeState.detached || {}; treeRestoreIdentity = tabTreeState.identities || {};
  }
  if (!c || JSON.stringify(config) !== stored) touchConfig();
  archive = normalizeArchive(a);
  for (const [id, snap] of Object.entries(snaps ?? {})) if (!tabSnapshots.has(+id)) tabSnapshots.set(+id, snap);
  await chrome.storage.local.set({ peekOnAltClick: !!config.settings.peekOnAltClick });
  lastTreeShape = JSON.stringify({ parents: rt.tabParent, detached: rt.treeDetached, collapsed: rt.treeCollapsed });
  await reconcile().catch(e => console.error('[cove] reconcile failed', e));
  await flush();
})();

let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(() => ready).then(fn).finally(flush);
  chain = run.catch(e => console.error('[cove]', e));
  return run;
}

// Tab edits fail while the user is mid-drag in the tab strip; retry briefly.
async function safe(fn, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries || !/dragging|cannot be edited/i.test(e?.message ?? '')) throw e;
      await new Promise(r => setTimeout(r, 120 * (i + 1)));
    }
  }
}

const getTab = id => chrome.tabs.get(+id).catch(() => null);

async function isNormalWindow(windowId) {
  if (!windowTypes.has(windowId)) {
    const w = await chrome.windows.get(windowId).catch(() => null);
    windowTypes.set(windowId, w?.type ?? 'gone');
  }
  return windowTypes.get(windowId) === 'normal';
}

// ---------------------------------------------------------------------------------------
// Spaces & groups

const spaceById = id => config.spaces.find(s => s.id === id);
const pinList = spaceId => (spaceId == null ? config.essentials : spaceById(spaceId)?.pins);
const tabSpaceOf = tab => (tab.pinned ? null : rt.groupSpace[tab.groupId] ?? rt.tabSpace[tab.id] ?? null);

function windowSpace(windowId) {
  let id = rt.activeSpace[windowId];
  if (!spaceById(id)) {
    id = spaceById(rt.lastSpace) ? rt.lastSpace : config.spaces[0].id;
    rt.activeSpace[windowId] = id;
    touchRt();
  }
  return id;
}

function setWindowSpace(windowId, spaceId) {
  if (rt.activeSpace[windowId] === spaceId && rt.lastSpace === spaceId) return;
  rt.activeSpace[windowId] = spaceId;
  rt.lastSpace = spaceId;
  touchRt();
}

async function groupFor(windowId, spaceId) {
  const groups = await chrome.tabGroups.query({ windowId });
  return groups.find(g => rt.groupSpace[g.id] === spaceId)?.id ?? null;
}

async function putTabInSpace(tab, spaceId) {
  const space = spaceById(spaceId);
  if (!space || !(await isNormalWindow(tab.windowId))) return;
  if (tab.pinned) await safe(() => chrome.tabs.update(tab.id, { pinned: false }));
  let groupId = await groupFor(tab.windowId, spaceId);
  if (groupId != null) {
    await safe(() => chrome.tabs.group({ tabIds: [tab.id], groupId }));
  } else {
    groupId = await safe(() => chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } }));
    rt.groupSpace[groupId] = spaceId;
    await safe(() => chrome.tabGroups.update(groupId, { title: space.name, color: space.color }));
  }
  rt.tabSpace[tab.id] = spaceId;
  touchRt();
  collapseSoon(tab.windowId);
}

async function createTabInSpace(windowId, spaceId, { url, active = true, openerTabId } = {}) {
  const tab = await safe(() => chrome.tabs.create({ windowId, url, active, ...(openerTabId != null ? { openerTabId } : {}) }));
  await putTabInSpace(tab, spaceId);
  return tab;
}

// Collapse every group except the active space's so the Chrome tab strip mirrors the sidebar.
// This also keeps Chrome's own "which tab next" choice inside the visible space.
async function applyCollapse(windowId) {
  if (!config.settings.collapseInactive || !(await isNormalWindow(windowId))) return;
  const active = windowSpace(windowId);
  const [groups, [activeTab]] = await Promise.all([
    chrome.tabGroups.query({ windowId }),
    chrome.tabs.query({ windowId, active: true }),
  ]);
  for (const g of groups) {
    const collapsed = rt.groupSpace[g.id] !== active && g.id !== activeTab?.groupId;
    if (g.collapsed !== collapsed) await safe(() => chrome.tabGroups.update(g.id, { collapsed })).catch(() => {});
  }
}

const collapseTimers = new Map();
function collapseSoon(windowId) {
  clearTimeout(collapseTimers.get(windowId));
  collapseTimers.set(windowId, setTimeout(() => enqueue(() => applyCollapse(windowId)), 60));
}

async function syncGroupsForSpace(space) {
  for (const [gid, sid] of Object.entries(rt.groupSpace)) {
    if (sid !== space.id) continue;
    await safe(() => chrome.tabGroups.update(+gid, { title: space.name, color: space.color })).catch(() => {});
  }
}

// Most-recently-used tab in the same space, excluding tabs that are on their way out.
async function pickSuccessor(windowId, spaceId, excludeId) {
  const tabs = await chrome.tabs.query({ windowId });
  const candidates = tabs.filter(
    t => t.id !== excludeId && !expectedRemovals.has(t.id) && tabSpaceOf(t) === spaceId,
  );
  const mru = rt.mru[windowId] ?? [];
  const rank = t => {
    const i = mru.indexOf(t.id);
    return i === -1 ? Infinity : i;
  };
  candidates.sort((a, b) => rank(a) - rank(b) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return candidates[0] ?? null;
}

// Chrome has already picked a replacement for a closed/detached active tab, ignoring spaces.
// Override it with a tab from the space the user was in.
async function replaceLostActiveTab(windowId, tabId, spaceId) {
  const target = spaceById(spaceId) ? spaceId : windowSpace(windowId);
  const next = await pickSuccessor(windowId, target, tabId);
  if (next) await safe(() => chrome.tabs.update(next.id, { active: true }));
  else if (spaceId) await createTabInSpace(windowId, target);
  setWindowSpace(windowId, target);
  collapseSoon(windowId);
}

function wasActiveTab(windowId, tabId, at) {
  const la = lastActivation.get(windowId);
  const curr = la?.curr ?? rt.mru[windowId]?.[0];
  // onActivated (Chrome's pick) can arrive before or after onRemoved; handle both orders.
  return curr === tabId || (la?.prev === tabId && at - la.at < ACTIVATION_RACE_MS);
}

// ---------------------------------------------------------------------------------------
// Pins

const insertAt = (list, id, index) =>
  list.splice(index == null || index < 0 || index > list.length ? list.length : index, 0, id);

function detachPin(pinId) {
  for (const list of [config.essentials, ...config.spaces.map(s => s.pins)]) {
    const i = list.indexOf(pinId);
    if (i !== -1) list.splice(i, 1);
  }
}

const goodFavicon = u => (isWebUrl(u) || (u?.startsWith('data:') && u.length < 8000) ? u : '');

function createPin(tab, spaceId, index) {
  const id = newId();
  const url = redactUrl(tab.url || tab.pendingUrl, { keepHash: true }) || 'chrome://newtab/';
  config.pins[id] = {
    id,
    url,
    title: '',
    defaultTitle: tab.title || '',
    favIconUrl: goodFavicon(tab.favIconUrl),
    aliases: [],
    spaceId,
    folderId: null,
    lastUrl: redactUrl(url, { keepHash: true }),
  };
  insertAt(pinList(spaceId), id, index);
  touchConfig();
  return config.pins[id];
}

function bindTab(tabId, pinId) {
  rt.tabPin[tabId] = pinId;
  touchRt();
  syncEssentialFlag(tabId);
}

function unbindTab(tabId) {
  if (tabId in rt.tabPin) {
    delete rt.tabPin[tabId];
    touchRt();
  }
  settling.delete(+tabId);
  syncEssentialFlag(+tabId);
}

// Tells peek-trigger.js (same isolated world) whether its tab is an Essential, so links to
// other sites open in Peek. Re-sent on every page load because the flag lives on the document.
const essentialFlagged = new Set();
function syncEssentialFlag(tabId) {
  const pin = config?.pins[rt?.tabPin[tabId]];
  const on = !!pin && pin.spaceId == null && !!config.settings.peekFromEssentials;
  if (!on && !essentialFlagged.has(tabId)) return;
  if (on) essentialFlagged.add(tabId);
  else essentialFlagged.delete(tabId);
  chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, func: v => (globalThis.__coveEssential = v), args: [on] })
    .catch(() => {});
}

async function boundTabs(pinId) {
  const out = [];
  for (const [id, p] of Object.entries(rt.tabPin)) {
    if (p !== pinId) continue;
    const t = await getTab(id);
    if (t) out.push(t);
    else unbindTab(id);
  }
  return out;
}

const boundTab = async (pinId, windowId) => (await boundTabs(pinId)).find(t => t.windowId === windowId) ?? null;

async function placePinTab(tab, spaceId) {
  if (spaceId == null) {
    if (!tab.pinned) await safe(() => chrome.tabs.update(tab.id, { pinned: true }));
    delete rt.tabSpace[tab.id];
    touchRt();
    syncEssentialFlag(tab.id);
    return;
  }
  await putTabInSpace(tab, spaceId);
  if (tab.active) setWindowSpace(tab.windowId, spaceId);
  syncEssentialFlag(tab.id);
}

function addAlias(pin, url) {
  url = redactUrl(url, { keepHash: true });
  // Same-page fragment changes are navigation, not redirect aliases, even during settling.
  if ([pin.url, ...(pin.aliases || [])].some(home => sameUrl(home, url))) return;
  if (!isWebUrl(url) || !isDrifted(pin, url)) return;
  pin.aliases = [url, ...(pin.aliases ?? [])].slice(0, MAX_ALIASES);
  touchConfig();
}

// ---------------------------------------------------------------------------------------
// Setup export / import

const SETUP_FORMAT = 'cove-setup';
const IMPORTABLE_URL = /^(https?|chrome|about|file):/i;

// Validates an exported setup and rebuilds it from known fields only, so a hand-edited or
// foreign file can't smuggle in odd URLs, favicons or settings.
function parseSetup(data) {
  const c = data?.format === SETUP_FORMAT ? data.config : null;
  if (!c || !Array.isArray(c.spaces) || !c.spaces.length || typeof c.pins !== 'object' || !c.pins) {
    throw new Error('Not a setup file exported from this extension');
  }
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const pins = {};
  for (const [id, p] of Object.entries(c.pins)) {
    if (typeof p?.url !== 'string' || !IMPORTABLE_URL.test(p.url)) continue;
    pins[id] = {
      id,
      url: p.url,
      title: str(p.title, 200),
      defaultTitle: str(p.defaultTitle, 300),
      favIconUrl: goodFavicon(p.favIconUrl),
      aliases: (Array.isArray(p.aliases) ? p.aliases : []).filter(a => typeof a === 'string' && isWebUrl(a)).slice(0, MAX_ALIASES),
      spaceId: null,
      lastUrl: typeof p.lastUrl === 'string' && IMPORTABLE_URL.test(p.lastUrl) ? p.lastUrl : p.url,
      folderId: typeof p.folderId === 'string' ? p.folderId : null,
    };
  }
  const listed = new Set();
  const spaces = c.spaces
    .filter(sp => typeof sp?.id === 'string')
    .map(sp => {
      const space = {
        id: sp.id,
        name: str(sp.name, 100).trim() || 'Space',
        icon: str(sp.icon, 8),
        color: COLORS[sp.color] ? sp.color : 'grey',
        pins: [],
      };
      for (const id of Array.isArray(sp.pins) ? sp.pins : []) {
        if (!pins[id] || listed.has(id)) continue;
        listed.add(id);
        pins[id].spaceId = space.id;
        space.pins.push(id);
      }
      return space;
    });
  const essentials = [];
  for (const id of Array.isArray(c.essentials) ? c.essentials : []) {
    if (!pins[id] || listed.has(id)) continue;
    listed.add(id);
    essentials.push(id);
  }
  for (const id of Object.keys(pins)) if (!listed.has(id)) delete pins[id];
  const folders = {};
  for (const [id, f] of Object.entries(c.folders && typeof c.folders === 'object' ? c.folders : {})) {
    if (typeof f?.spaceId !== 'string') continue;
    folders[id] = {
      id,
      spaceId: f.spaceId,
      parentId: typeof f.parentId === 'string' ? f.parentId : null,
      name: str(f.name, 100).trim() || 'Folder',
      collapsed: f.collapsed === true,
    };
  }
  const settings = {};
  for (const key of Object.keys(defaultConfig().settings)) {
    if (typeof c.settings?.[key] === 'boolean') settings[key] = c.settings[key];
  }
  // normalizeConfig -> repairFolders drops unknown spaces, cross-space parents and cycles.
  return normalizeConfig({ version: 2, spaces, essentials, pins, folders, settings });
}

// Tree relationships are session state, independent of saved pin/folder membership.
async function pruneTabTree() {
  const tabs = await chrome.tabs.query({});
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  let changed = false;
  for (const [child, parent] of Object.entries(rt.tabParent)) {
    if (!validParent(byId.get(+child), byId.get(parent), rt)) {
      delete rt.tabParent[child]; rt.treeDetached[child] = true; changed = true;
    }
  }
  for (const id of Object.keys(rt.treeDetached)) if (!byId.has(+id)) { delete rt.treeDetached[id]; changed = true; }
  for (const key of Object.keys(rt.treeCollapsed)) if (!byId.has(+key.slice(key.lastIndexOf(':') + 1))) { delete rt.treeCollapsed[key]; changed = true; }
  if (changed) touchTree();
}
function revealTabParents(tab) {
  const spaceId = treeSpace(tab, rt) || windowSpace(tab.windowId);
  const seen = new Set(); let id = rt.tabParent[tab.id];
  let changed = false;
  while (id != null && !seen.has(id)) {
    seen.add(id);
    const key = `${spaceId}:${id}`;
    if (rt.treeCollapsed[key]) { delete rt.treeCollapsed[key]; changed = true; }
    revealPinFolders(rt.tabPin[id]); id = rt.tabParent[id];
  }
  if (changed) touchTree();
}
// openerTabId is only a browser hint: external apps can inherit the active tab as
// their opener. Only a renderer-created navigation target confirms a link's source.
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId, url }) =>
  enqueue(async () => {
    const [tab, source] = await Promise.all([getTab(tabId), getTab(sourceTabId)]);
    if (!tab || !source || tab.windowId !== source.windowId || !(await isNormalWindow(tab.windowId))) return;
    if (await peekInsteadOfTab(tab, sourceTabId, url)) return;
    if (tab.pinned || rt.tabPin[tabId] || isPeekTab(tabId) || isPeekTab(sourceTabId)) return;
    if ((tab.pendingUrl || tab.url || '').startsWith('chrome-extension:') ||
        (source.pendingUrl || source.url || '').startsWith('chrome-extension:')) return;
    if (rt.tabParent[tabId] != null || rt.treeDetached[tabId]) return;
    const spaceId = tabSpaceOf(source) || windowSpace(tab.windowId);
    if (tabSpaceOf(tab) !== spaceId) await putTabInSpace(tab, spaceId);
    const current = await getTab(tabId);
    if (!validParent(current, source, rt)) return;
    rt.tabParent[tabId] = sourceTabId;
    touchTree();
    if (current.active) {
      setWindowSpace(current.windowId, spaceId);
      revealTabParents(current);
      await applyCollapse(current.windowId);
    }
  }),
);

// ---------------------------------------------------------------------------------------
// Message handlers (called from the side panel)

const handlers = {
  async setTabParent({ tabId, parentId = null, beforeTabId = null }) {
    const tab = await getTab(tabId);
    if (!tab || tab.pinned || rt.tabPin[tabId]) throw new Error('Choose an ordinary tab to move.');
    if (parentId != null) {
      const parent = await getTab(parentId);
      if (!validParent(tab, parent, rt) || descendants(tabId, rt.tabParent).includes(parentId)) throw new Error('Choose a parent in the same window and space, outside this branch.');
      delete rt.treeDetached[tabId];
      rt.tabParent[tabId] = parentId;
      delete rt.treeCollapsed[`${treeSpace(tab, rt)}:${parentId}`];
    } else { delete rt.tabParent[tabId]; rt.treeDetached[tabId] = true; }
    touchTree();
    if (beforeTabId != null) await handlers.moveTab({ tabId, spaceId: treeSpace(tab, rt), beforeTabId });
    const current = await getTab(tabId); if (current) rememberTab(current);
  },
  async toggleTabTree({ windowId, tabId, spaceId }) {
    const tab = await getTab(tabId);
    if (!tab || tab.windowId !== windowId || !spaceById(spaceId)) return;
    const key = `${spaceId}:${tabId}`;
    if (rt.treeCollapsed[key]) delete rt.treeCollapsed[key]; else rt.treeCollapsed[key] = true;
    touchTree();
  },
  async newChildTab({ tabId }) {
    const parent = await getTab(tabId);
    if (!parent) return;
    const spaceId = treeSpace(parent, rt) || windowSpace(parent.windowId);
    const child = await createTabInSpace(parent.windowId, spaceId, { openerTabId: parent.id });
    delete rt.treeDetached[child.id];
    rt.tabParent[child.id] = parent.id; revealTabParents(child); touchTree();
    return child.id;
  },
  async switchSpace({ windowId, spaceId }) {
    if (!spaceById(spaceId)) return;
    setWindowSpace(windowId, spaceId);
    const [cur] = await chrome.tabs.query({ windowId, active: true });
    if (!cur || tabSpaceOf(cur) !== spaceId) {
      // An empty space just shows empty; we don't spawn a New Tab on every switch.
      const next = await pickSuccessor(windowId, spaceId);
      if (next) await safe(() => chrome.tabs.update(next.id, { active: true }));
    }
    await applyCollapse(windowId);
  },

  async stepSpace({ windowId, delta }) {
    const n = config.spaces.length;
    const i = config.spaces.findIndex(s => s.id === windowSpace(windowId));
    await handlers.switchSpace({ windowId, spaceId: config.spaces[(i + delta + n) % n].id });
  },

  // `index` is 0-based; shortcuts for spaces that don't exist are ignored.
  async goToSpace({ windowId, index }) {
    const space = config.spaces[index];
    if (space) await handlers.switchSpace({ windowId, spaceId: space.id });
  },

  async createSpace({ windowId, name, icon, color }) {
    const used = new Set(config.spaces.map(s => s.color));
    const space = {
      id: newId(),
      name: name?.trim() || 'New Space',
      icon: icon?.trim() ?? '',
      color: COLORS[color] ? color : Object.keys(COLORS).find(c => !used.has(c)) ?? 'grey',
      pins: [],
    };
    config.spaces.push(space);
    touchConfig();
    if (windowId != null) await handlers.switchSpace({ windowId, spaceId: space.id });
    return space.id;
  },

  async updateSpace({ spaceId, name, icon, color }) {
    const s = spaceById(spaceId);
    if (!s) return;
    if (name?.trim()) s.name = name.trim();
    if (icon != null) s.icon = icon.trim();
    if (COLORS[color]) s.color = color;
    touchConfig();
    await syncGroupsForSpace(s);
  },

  async deleteSpace({ spaceId }) {
    const s = spaceById(spaceId);
    if (!s || config.spaces.length <= 1) return;
    const i = config.spaces.indexOf(s);
    const fallback = config.spaces[i + 1] ?? config.spaces[i - 1];
    const allTabs = await chrome.tabs.query({});
    const doomed = allTabs.filter(t => tabSpaceOf(t) === spaceId);
    for (const [wid, sid] of Object.entries(rt.activeSpace)) {
      if (sid === spaceId) await handlers.switchSpace({ windowId: +wid, spaceId: fallback.id });
    }
    for (const wid of new Set(doomed.map(t => t.windowId))) {
      const survivors = allTabs.filter(t => t.windowId === wid && !doomed.includes(t));
      const active = allTabs.find(t => t.windowId === wid && t.active);
      if (!survivors.length || doomed.includes(active)) {
        const next = await pickSuccessor(wid, fallback.id);
        if (next) await safe(() => chrome.tabs.update(next.id, { active: true }));
        else await createTabInSpace(wid, fallback.id);
      }
    }
    for (const t of doomed) {
      expectedRemovals.add(t.id);
      unbindTab(t.id);
    }
    if (doomed.length) await safe(() => chrome.tabs.remove(doomed.map(t => t.id))).catch(() => {});
    for (const pid of s.pins) delete config.pins[pid];
    for (const [fid, f] of Object.entries(config.folders)) if (f.spaceId === spaceId) delete config.folders[fid];
    config.spaces.splice(config.spaces.indexOf(s), 1);
    for (const [gid, sid] of Object.entries(rt.groupSpace)) if (sid === spaceId) delete rt.groupSpace[gid];
    if (rt.lastSpace === spaceId) rt.lastSpace = fallback.id;
    touchConfig();
    touchRt();
  },

  async reorderSpaces({ order }) {
    config.spaces.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    touchConfig();
  },

  async newTab({ windowId, spaceId, url }) {
    const target = spaceById(spaceId) ? spaceId : windowSpace(windowId);
    setWindowSpace(windowId, target);
    return (await createTabInSpace(windowId, target, { url })).id;
  },

  async closeTabs({ windowId, tabIds }) {
    const tabs = (await chrome.tabs.query({ windowId })).filter(t => tabIds.includes(t.id));
    const active = tabs.find(t => t.active);
    for (const id of tabIds) expectedRemovals.add(id);
    if (active) {
      // Pick the successor ourselves before Chrome does, so there's no flash of another space.
      const spaceId = active.pinned ? windowSpace(windowId) : tabSpaceOf(active) ?? windowSpace(windowId);
      const next = await pickSuccessor(windowId, spaceId, active.id);
      if (next) await safe(() => chrome.tabs.update(next.id, { active: true }));
      else if (!active.pinned) await createTabInSpace(windowId, spaceId);
    }
    await safe(() => chrome.tabs.remove(tabIds)).catch(() => {});
    // One close (a single tab, or Clear) is one archive batch, so Undo brings all of it back.
    const gone = new Set(tabIds);
    for (const t of await chrome.tabs.query({ windowId }).catch(() => [])) gone.delete(t.id);
    archiveTabs(tabs.filter(t => gone.has(t.id) && archivable(t)).map(snapshotTab), { notify: true });
  },

  async clearSpace({ windowId, spaceId }) {
    const tabs = await chrome.tabs.query({ windowId });
    const tabIds = tabs.filter(t => tabSpaceOf(t) === spaceId && !rt.tabPin[t.id] && !t.active).map(t => t.id);
    if (tabIds.length) await handlers.closeTabs({ windowId, tabIds });
  },

  // Click a pin to switch to it; click it again while it's active and has
  // navigated away to send it back to its pinned URL.
  // `reset: false` (used by search and "Open all tabs") only switches, never resets.
  async openPin({ windowId, pinId, reset = true }) {
    const pin = config.pins[pinId];
    if (!pin) return;
    revealPinFolders(pinId);
    const tab = await boundTab(pinId, windowId);
    if (tab) {
      if (!tab.active) await safe(() => chrome.tabs.update(tab.id, { active: true }));
      else if (reset && config.settings.resetOnReclick && isDrifted(pin, tab.url || tab.pendingUrl)) {
        await handlers.resetPin({ windowId, pinId });
      }
      return;
    }
    if (pin.spaceId == null) {
      const t = await safe(() => chrome.tabs.create({ windowId, url: pin.url, active: true, pinned: true }));
      bindTab(t.id, pinId);
      settling.set(t.id, { completedAt: null });
    } else {
      const t = await safe(() => chrome.tabs.create({ windowId, url: pin.url, active: true }));
      bindTab(t.id, pinId);
      settling.set(t.id, { completedAt: null });
      await putTabInSpace(t, pin.spaceId);
      setWindowSpace(windowId, pin.spaceId);
    }
  },

  async resetPin({ windowId, pinId }) {
    const pin = config.pins[pinId];
    const tab = pin && (await boundTab(pinId, windowId));
    if (!tab) return;
    settling.set(tab.id, { completedAt: null });
    await safe(() => chrome.tabs.update(tab.id, { url: pin.url, active: true }));
  },

  async unloadPin({ windowId, pinId }) {
    const tab = await boundTab(pinId, windowId);
    if (tab) await handlers.closeTabs({ windowId, tabIds: [tab.id] });
  },

  async pinTab({ tabId, spaceId = null, index, folderId = null }) {
    const tab = await getTab(tabId);
    if (!tab || (spaceId != null && !spaceById(spaceId))) return;
    validateFolder(folderId, spaceId);
    const existing = rt.tabPin[tabId];
    if (existing && config.pins[existing]) return handlers.movePin({ pinId: existing, spaceId, index, folderId });
    delete rt.tabParent[tabId]; rt.treeDetached[tabId] = true; touchTree();
    const pin = createPin(tab, spaceId, index);
    pin.folderId = folderId;
    bindTab(tabId, pin.id);
    await placePinTab(tab, spaceId);
  },

  // `folderId` is the pin's folder after the move (null = top level of the space).
  async movePin({ pinId, spaceId = null, index, folderId = null }) {
    const pin = config.pins[pinId];
    if (!pin || !pinList(spaceId)) return;
    validateFolder(folderId, spaceId);
    detachPin(pinId);
    insertAt(pinList(spaceId), pinId, index);
    const changed = pin.spaceId !== spaceId;
    pin.spaceId = spaceId;
    pin.folderId = folderId;
    touchConfig();
    if (changed) for (const t of await boundTabs(pinId)) await placePinTab(t, spaceId);
  },

  // Remove the pin but keep its tab(s) open as regular tabs. With `place`, the tab in
  // `windowId` is moved into `spaceId` before `beforeTabId` (drag from pins into the tab list).
  async unpin({ pinId, windowId, spaceId, beforeTabId = null, place = false }) {
    const pin = config.pins[pinId];
    if (!pin) return;
    const tabs = await boundTabs(pinId);
    detachPin(pinId);
    delete config.pins[pinId];
    touchConfig();
    let here = null;
    for (const t of tabs) {
      unbindTab(t.id);
      const target = (t.windowId === windowId && spaceById(spaceId) && spaceId) || pin.spaceId || windowSpace(t.windowId);
      if (t.pinned || tabSpaceOf(t) !== target) await putTabInSpace(t, target);
      if (t.windowId === windowId) here = { tabId: t.id, target };
    }
    if (!place || windowId == null) return;
    if (!here && spaceById(spaceId)) {
      const t = await createTabInSpace(windowId, spaceId, { url: pin.url });
      here = { tabId: t.id, target: spaceId };
    }
    if (here) await handlers.moveTab({ tabId: here.tabId, spaceId: here.target, beforeTabId });
  },

  async removePin({ pinId }) {
    const pin = config.pins[pinId];
    if (!pin) return;
    const tabs = await boundTabs(pinId);
    detachPin(pinId);
    delete config.pins[pinId];
    touchConfig();
    for (const wid of new Set(tabs.map(t => t.windowId))) {
      await handlers.closeTabs({ windowId: wid, tabIds: tabs.filter(t => t.windowId === wid).map(t => t.id) });
    }
  },

  async renamePin({ pinId, title }) {
    const pin = config.pins[pinId];
    if (!pin) return;
    pin.title = (title ?? '').trim();
    touchConfig();
  },

  async setPinUrl({ pinId, url, title }) {
    const pin = config.pins[pinId];
    if (!pin || !url) return;
    pin.url = redactUrl(url, { keepHash: true }) || url;
    pin.aliases = [];
    if (title) pin.defaultTitle = title;
    touchConfig();
  },

  async moveTab({ tabId, spaceId, beforeTabId = null }) {
    let tab = await getTab(tabId);
    if (!tab || !spaceById(spaceId)) return;
    const pinId = rt.tabPin[tabId];
    if (pinId && config.pins[pinId]) {
      return handlers.unpin({ pinId, windowId: tab.windowId, spaceId, beforeTabId, place: true });
    }
    if (tab.pinned || tabSpaceOf(tab) !== spaceId) await putTabInSpace(tab, spaceId);
    tab = await getTab(tabId);
    if (!tab) return;
    const groupId = tab.groupId;
    const before = beforeTabId != null ? await getTab(beforeTabId) : null;
    let index;
    if (before && before.windowId === tab.windowId && before.groupId === groupId) {
      index = before.index > tab.index ? before.index - 1 : before.index;
    } else {
      const groupTabs = await chrome.tabs.query({ windowId: tab.windowId, groupId });
      index = Math.max(...groupTabs.map(t => t.index));
    }
    if (index !== tab.index) {
      await safe(() => chrome.tabs.move(tabId, { index }));
      const moved = await getTab(tabId);
      if (moved && moved.groupId !== groupId) await safe(() => chrome.tabs.group({ tabIds: [tabId], groupId }));
    }
    if (tab.active) setWindowSpace(tab.windowId, spaceId);
    await pruneTabTree();
    collapseSoon(tab.windowId);
  },

  // The archive and search memory are local history, not setup, so they aren't exported.
  exportConfig() {
    const { spaces, essentials, pins, folders, settings } = config;
    return {
      format: SETUP_FORMAT,
      version: 2,
      exportedAt: new Date().toISOString(),
      config: normalizeConfig(structuredClone({ spaces, essentials, pins, folders, settings })),
    };
  },

  // Replaces spaces, pins, Essentials and settings, then rebuilds runtime state from the open
  // tabs: groups are matched to spaces by name and tabs re-bound to pins by URL, exactly like
  // after a browser restart. This is also how a setup moves between installs.
  async importConfig({ data }) {
    config = parseSetup(data);
    touchConfig();
    rt = emptyRt();
    touchRt();
    await reconcile();
    for (const s of config.spaces) await syncGroupsForSpace(s);
    broadcastPeekPrefs();
    return { spaces: config.spaces.length, pins: Object.keys(config.pins).length };
  },

  async updateSettings({ patch }) {
    Object.assign(config.settings, patch);
    touchConfig();
    if ('peekFromEssentials' in patch) for (const id of Object.keys(rt.tabPin)) syncEssentialFlag(+id);
    if ('peekOnAltClick' in patch) broadcastPeekPrefs();
    if (!('collapseInactive' in patch)) return;
    if (patch.collapseInactive) {
      for (const w of await chrome.windows.getAll({ windowTypes: ['normal'] })) await applyCollapse(w.id);
    } else {
      for (const g of await chrome.tabGroups.query({ collapsed: true })) {
        if (rt.groupSpace[g.id]) await safe(() => chrome.tabGroups.update(g.id, { collapsed: false })).catch(() => {});
      }
    }
  },
};

// ---------------------------------------------------------------------------------------
// Folders: nested groups of a space's pinned tabs. Adapted from a contribution by Julio
// Orozco (drewcoble/cove#1).

function validateFolder(folderId, spaceId) {
  if (folderId == null) return;
  const folder = config.folders[folderId];
  if (!folder || spaceId == null || folder.spaceId !== spaceId) throw new Error('Choose a folder in the same space.');
}

// The folder and every folder nested inside it.
function folderSubtree(folderId) {
  const ids = new Set([folderId]);
  let size;
  do {
    size = ids.size;
    for (const f of Object.values(config.folders)) if (ids.has(f.parentId)) ids.add(f.id);
  } while (ids.size !== size);
  return ids;
}

// Opening a pin expands every folder above it, so the selected row is visible.
function revealPinFolders(pinId) {
  const pin = config.pins[pinId];
  const seen = new Set();
  for (let f = config.folders[pin?.folderId]; f && !seen.has(f.id); f = config.folders[f.parentId]) {
    seen.add(f.id);
    if (f.collapsed) {
      f.collapsed = false;
      touchConfig();
    }
  }
}

Object.assign(handlers, {
  async createFolder({ spaceId, name, parentId = null }) {
    if (!spaceById(spaceId)) throw new Error('That space no longer exists.');
    validateFolder(parentId, spaceId);
    const id = newId();
    config.folders[id] = { id, spaceId, parentId, name: name?.trim().slice(0, 100) || 'New folder', collapsed: false };
    touchConfig();
    return id;
  },

  // `parentId: undefined` leaves the parent alone; null moves the folder to the top level.
  async updateFolder({ folderId, name, collapsed, parentId }) {
    const folder = config.folders[folderId];
    if (!folder) return;
    if (parentId !== undefined) {
      validateFolder(parentId, folder.spaceId);
      if (parentId != null && folderSubtree(folderId).has(parentId)) throw new Error('A folder can’t go inside itself.');
      folder.parentId = parentId;
    }
    if (name?.trim()) folder.name = name.trim().slice(0, 100);
    if (typeof collapsed === 'boolean') folder.collapsed = collapsed;
    touchConfig();
  },

  // Removing a folder keeps its pins and subfolders; they move up one level.
  async deleteFolder({ folderId }) {
    const folder = config.folders[folderId];
    if (!folder) return;
    for (const pin of Object.values(config.pins)) if (pin.folderId === folderId) pin.folderId = folder.parentId;
    for (const child of Object.values(config.folders)) if (child.parentId === folderId) child.parentId = folder.parentId;
    delete config.folders[folderId];
    touchConfig();
  },

  // Opens every pin in the folder and its subfolders without resetting ones you navigated.
  async openFolder({ windowId, folderId }) {
    const folder = config.folders[folderId];
    if (!folder) return;
    const inside = folderSubtree(folderId);
    for (const id of spaceById(folder.spaceId).pins) {
      if (inside.has(config.pins[id]?.folderId)) await handlers.openPin({ windowId, pinId: id, reset: false });
    }
    await handlers.switchSpace({ windowId, spaceId: folder.spaceId });
  },
});

// ---------------------------------------------------------------------------------------
// Archive: closed tabs you can search and restore. Adapted from a contribution by Julio
// Orozco (drewcoble/cove#1). Pinned tabs, Essentials, Peeks, closed windows and deleted
// spaces aren't archived; only web pages are kept, with sign-in parameters stripped.

const archivable = tab => !tab.pinned && !rt.tabPin[tab.id] && !isPeekTab(tab.id);

function snapshotTab(tab) {
  return {
    tabId: tab.id, parentTabId: rt.tabParent[tab.id] ?? null, parentPinId: rt.tabPin[rt.tabParent[tab.id]] ?? null,
    url: redactUrl(tab.pendingUrl || tab.url, { keepHash: true }),
    title: tab.title || '',
    favIconUrl: isWebUrl(tab.favIconUrl) ? tab.favIconUrl : '',
    windowId: tab.windowId,
    spaceId: tabSpaceOf(tab),
    active: !!tab.active,
  };
}

let snapshotTimer;
function saveSnapshotsSoon() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => chrome.storage.session.set({ tabSnapshots: Object.fromEntries(tabSnapshots) }), 1500);
}
function forgetTab(tabId) {
  if (tabSnapshots.delete(tabId)) saveSnapshotsSoon();
}
// Called straight from tabs.onUpdated (not through the queue): only url/title/favicon
// changes matter, and nothing is written unless one of them actually changed.
function rememberTab(tab) {
  tabWindows.set(tab.id, tab.windowId);
  const url = redactUrl(tab.pendingUrl || tab.url, { keepHash: true });
  if (tab.pinned || !isWebUrl(url)) return forgetTab(tab.id);
  const old = tabSnapshots.get(tab.id);
  const favIconUrl = isWebUrl(tab.favIconUrl) ? tab.favIconUrl : old?.favIconUrl || '';
  const title = tab.title || old?.title || '';
  if (old && old.url === url && old.title === title && old.favIconUrl === favIconUrl) return;
  tabSnapshots.set(tab.id, { url, title, favIconUrl });
  saveSnapshotsSoon();
}

function archiveTabs(snapshots, { notify = false } = {}) {
  if (!config.settings.archiveClosedTabs) return;
  const batchId = newId();
  const closedAt = Date.now();
  const entries = snapshots.filter(s => isWebUrl(s.url)).map(s => ({ ...s, id: newId(), batchId, closedAt }));
  if (!entries.length) return;
  archive = [...entries, ...archive].slice(0, MAX_ARCHIVE);
  touchArchive();
  if (notify) {
    chrome.runtime.sendMessage({ target: 'panel', type: 'archived', windowId: entries[0].windowId, count: entries.length }).catch(() => {});
  }
}

Object.assign(handlers, {
  async restoreArchive({ windowId, entryIds }) {
    const entries = [...new Set(entryIds)].map(id => archive.find(e => e.id === id)).filter(Boolean);
    let focus = null;
    const treeEntries = [];
    for (const entry of entries) {
      const spaceId = spaceById(entry.spaceId) ? entry.spaceId : windowSpace(windowId);
      const tab = await createTabInSpace(windowId, spaceId, { url: entry.url, active: false });
      // Remove each entry only once its tab exists, so a failure keeps the rest restorable.
      archive = archive.filter(e => e.id !== entry.id);
      touchArchive();
      treeEntries.push({ entry, tab });
      if (entry.active || !focus) focus = { tab, spaceId };
    }
    const restoredIds = new Map(treeEntries.map(({ entry, tab }) => [entry.tabId, tab.id]));
    for (const { entry, tab } of treeEntries) {
      const parentId = restoredIds.get(entry.parentTabId) ?? (entry.parentPinId ? (await boundTab(entry.parentPinId, windowId))?.id : entry.windowId === windowId ? entry.parentTabId : null);
      const parent = parentId != null ? await getTab(parentId) : null;
      if (validParent(tab, parent, rt)) rt.tabParent[tab.id] = parent.id;
    }
    touchTree();
    if (focus) {
      revealTabParents(focus.tab);
      setWindowSpace(windowId, focus.spaceId);
      await safe(() => chrome.tabs.update(focus.tab.id, { active: true }));
      await applyCollapse(windowId);
    }
    return entries.length;
  },

  // Restores this window's most recent close (a whole Clear comes back together).
  async undoArchive({ windowId }) {
    const latest = archive.find(e => e.windowId === windowId);
    if (!latest) return 0;
    return handlers.restoreArchive({ windowId, entryIds: archive.filter(e => e.batchId === latest.batchId).map(e => e.id) });
  },

  async deleteArchive({ entryIds }) {
    const drop = new Set(entryIds);
    archive = archive.filter(e => !drop.has(e.id));
    touchArchive();
  },

  async clearArchive() {
    archive = [];
    touchArchive();
  },

  async clearSearchMemory() {
    await chrome.storage.local.remove('searchMemory');
  },
});

// ---------------------------------------------------------------------------------------
// Search. Adapted from a contribution by Julio Orozco (drewcoble/cove#1).
//
// The launcher is an extension page (src/launcher.html) that reads tabs, pins, the archive
// and history itself, so none of that ever enters a web page. On an ordinary page it shows
// in a frame on top of the page: src/overlay-host.js is injected only when you open search
// (so a site's own Cmd/Ctrl+K keeps working), and a page can't read a cross-origin extension
// frame or the keys typed into it. Where nothing can be injected (chrome:// pages, the Web
// Store, PDFs) the launcher opens as a tab instead. Each opening gets a one-time token; a
// launcher without a live token, such as one a page embedded on its own, shows nothing.

const LAUNCHER = 'src/launcher.html';

// One of our extension pages (not a content script, whose url is the web page's). Compared
// by protocol and path because launcher.html is web-accessible with use_dynamic_url, so its
// address can use either the extension id or the per-session dynamic id.
function extensionPagePath(sender) {
  try {
    const u = new URL(sender?.url);
    return sender.id === chrome.runtime.id && u.protocol === 'chrome-extension:' ? u.pathname : null;
  } catch {
    return null;
  }
}

function searchSession(token, sender) {
  const session = token && rt.searches[token];
  const fromLauncher = extensionPagePath(sender) === '/' + LAUNCHER;
  const tabId = sender?.tab?.id;
  const ok = session && fromLauncher &&
    (session.overlay ? tabId === session.tabId && sender.frameId !== 0 : tabId === session.launcherTabId);
  if (!ok) throw new Error('This search has closed. Open it again.');
  return session;
}

async function closeSearch(token) {
  const session = rt.searches[token];
  if (!session) return;
  delete rt.searches[token];
  touchRt();
  if (session.overlay) {
    await chrome.tabs.sendMessage(session.tabId, { type: 'coveCloseSearch' }, { frameId: 0 }).catch(() => {});
    return;
  }
  const launcherTab = await getTab(session.launcherTabId);
  if (!launcherTab) return;
  expectedRemovals.add(launcherTab.id);
  if (launcherTab.active && (await getTab(session.returnTabId))) {
    await safe(() => chrome.tabs.update(session.returnTabId, { active: true })).catch(() => {});
  }
  await chrome.tabs.remove(launcherTab.id).catch(() => expectedRemovals.delete(launcherTab.id));
}

async function rememberSearchChoice({ kind, id, text, query, url }) {
  if (!config.settings.searchHistory) return;
  const stored = await chrome.storage.local.get('searchMemory');
  const memory = normalizeSearchMemory(stored.searchMemory);
  const now = Date.now();
  if (kind === 'search' && text?.trim()) {
    const phrase = searchMemoryText(text);
    const searches = (memory.searches || []).filter(e => e.text.toLocaleLowerCase() !== phrase.toLocaleLowerCase());
    const previous = (memory.searches || []).find(e => e.text.toLocaleLowerCase() === phrase.toLocaleLowerCase());
    memory.searches = [{ text: phrase, count: (previous?.count || 0) + 1, lastUsed: now }, ...searches].slice(0, MAX_SEARCH_MEMORY.searches);
  }
  const typed = typeof query === 'string' ? searchMemoryText(query).toLocaleLowerCase() : '';
  if (typed && !typed.startsWith('>')) {
    const key = url ? destinationKey(searchMemoryText(url)) : `search-${searchMemoryText(text).toLocaleLowerCase()}`;
    const previous = (memory.selections || []).find(e => e.query === typed && e.key === key);
    const rest = (memory.selections || []).filter(e => e !== previous);
    memory.selections = [{ query: typed, key, count: (previous?.count || 0) + 1, lastUsed: now }, ...rest].slice(0, MAX_SEARCH_MEMORY.selections);
  }
  await chrome.storage.local.set({ searchMemory: memory });
}

// Opens the launcher as a temporary tab next to where search was opened; closing it returns
// to that tab. Used where nothing can be injected, and when the overlay can't get focus.
async function openLauncherTab(token, session) {
  session.overlay = false;
  session.returnTabId = session.tabId;
  const hash = new URLSearchParams({ token, mode: session.mode, view: 'tab' });
  const launcherTab = await createTabInSpace(session.windowId, windowSpace(session.windowId), {
    url: chrome.runtime.getURL(`${LAUNCHER}#${hash}`),
  });
  session.launcherTabId = launcherTab.id;
  touchRt();
}

Object.assign(handlers, {
  // Opens search over the active tab of `windowId`, or closes it if it's already open there.
  async openSearch({ windowId, mode = 'all' }) {
    const [tab] = await chrome.tabs.query({ windowId, active: true });
    if (!tab) return;
    const open = Object.entries(rt.searches).find(([, s]) => s.tabId === tab.id || s.launcherTabId === tab.id);
    if (open) return closeSearch(open[0]);
    for (const [token, s] of Object.entries(rt.searches)) if (s.windowId === windowId) await closeSearch(token);
    const token = newId() + newId();
    const session = { tabId: tab.id, windowId, overlay: true, mode: mode === 'archive' ? 'archive' : 'all' };
    rt.searches[token] = session;
    touchRt();
    const page = tab.pendingUrl || tab.url || '';
    try {
      if (isLauncherOrNewTab(page, chrome.runtime.getURL(''))) throw new Error('use a tab');
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['src/overlay-host.js'] });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        func: (t, m) => globalThis.__coveSearch?.open(t, m) === true,
        args: [token, session.mode],
      });
      if (!result) throw new Error('overlay unavailable');
    } catch {
      await openLauncherTab(token, session);
    }
  },

  // From an overlay launcher that couldn't get keyboard focus: Chrome's own UI (e.g. the
  // address bar after closing a New Tab) still holds it, and a page can't take it back.
  // Swap the overlay for the tab launcher, which does get focus, keeping the same token.
  async launcherFallback({ token }, sender) {
    const session = searchSession(token, sender);
    if (!session.overlay) return;
    await chrome.tabs.sendMessage(session.tabId, { type: 'coveCloseSearch' }, { frameId: 0 }).catch(() => {});
    await openLauncherTab(token, session);
  },

  async launcherHello({ token }, sender) {
    const session = searchSession(token, sender);
    return { windowId: session.windowId, sourceTabId: session.tabId, spaceId: windowSpace(session.windowId), mode: session.mode };
  },

  async launcherClose({ token }, sender) {
    searchSession(token, sender);
    await closeSearch(token);
  },

  // Everything a launcher result can do. Archive deletes and new folders keep search open;
  // everything else closes it.
  async launcherAction({ token, kind, id, text, query }, sender) {
    const { windowId } = searchSession(token, sender);
    const spaceId = windowSpace(windowId);
    let url;
    if (kind === 'tab') {
      const target = await getTab(id);
      if (!target || target.windowId !== windowId) throw new Error('That tab has closed. Search again.');
      url = target.pendingUrl || target.url;
      const targetSpace = tabSpaceOf(target);
      if (targetSpace) setWindowSpace(windowId, targetSpace);
      await safe(() => chrome.tabs.update(target.id, { active: true }));
      await applyCollapse(windowId);
    } else if (kind === 'pin') {
      const pin = config.pins[id];
      if (!pin) throw new Error('That pinned tab was removed.');
      url = pin.url;
      await handlers.openPin({ windowId, pinId: id, reset: false });
      if (pin.spaceId != null) setWindowSpace(windowId, pin.spaceId);
      await applyCollapse(windowId);
    } else if (kind === 'space') {
      await handlers.switchSpace({ windowId, spaceId: id });
    } else if (kind === 'navigate' || kind === 'search') {
      if (!text?.trim()) return;
      url = kind === 'search' ? undefined : navigationUrl(text) || undefined;
      const tab = await createTabInSpace(windowId, spaceId, { url });
      if (!url) await chrome.search.query({ text: text.trim(), tabId: tab.id });
    } else if (kind === 'archive') {
      await handlers.restoreArchive({ windowId, entryIds: [id] });
    } else if (kind === 'undo') {
      await handlers.undoArchive({ windowId });
    } else if (kind === 'deleteArchive') {
      return handlers.deleteArchive({ entryIds: [id] });
    } else if (kind === 'folder') {
      if (!text?.trim()) throw new Error('Enter a folder name.');
      return handlers.createFolder({ spaceId, name: text });
    } else {
      throw new Error('Unknown search action.');
    }
    if (['tab', 'pin', 'navigate', 'search'].includes(kind)) await rememberSearchChoice({ kind, id, text, query, url });
    await closeSearch(token);
  },

  // From overlay-host.js (a content script) when the overlay was dismissed on the page side.
  async overlayClosed(_msg, sender) {
    for (const [token, s] of Object.entries(rt.searches)) {
      if (s.overlay && s.tabId === sender?.tab?.id) {
        delete rt.searches[token];
        touchRt();
      }
    }
  },
});

// Content scripts run on every site, so they may only reach the Peek handlers and tell us an
// overlay was dismissed (which returns nothing and only affects their own tab).
const CONTENT_SCRIPT_HANDLERS = new Set(['peek', 'peekClose', 'peekExpand', 'overlayClosed']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return;
  const fromExtensionPage = extensionPagePath(sender) != null;
  if (!fromExtensionPage && !CONTENT_SCRIPT_HANDLERS.has(msg.type)) return;
  // A content script only ever acts on its own tab: drop any window/tab ids it passes.
  const args = fromExtensionPage ? msg : { type: msg.type, url: msg.url };
  enqueue(() => handler(args, sender)).then(
    result => sendResponse({ ok: true, result }),
    error => sendResponse({ ok: false, error: String(error?.message ?? error) }),
  );
  return true;
});

// ---------------------------------------------------------------------------------------
// Tab / group / window events

chrome.tabs.onCreated.addListener(tab => {
  const createdUrl = tab.pendingUrl || tab.url;
  enqueue(() => onTabCreated(tab.id, createdUrl));
});

async function onTabCreated(tabId, createdUrl) {
  const tab = await getTab(tabId);
  if (!tab || !(await isNormalWindow(tab.windowId))) return;
  rememberTab(tab);
  // Preserve the creation intent even if the user submits a URL before this queued handler runs.
  if (rt.tabParent[tabId] == null && isNewTabUrl(createdUrl, chrome.runtime.getURL(''))) { rt.treeDetached[tabId] = true; touchTree(); }
  if (rt.tabPeeks[tab.id]?.split) return;
  if (tab.pinned) {
    if (!rt.tabPin[tab.id]) bindTab(tab.id, createPin(tab, null).id);
    return;
  }
  const openerPin = config.pins[rt.tabPin[tab.openerTabId]];
  const fromEssential = !!openerPin && openerPin.spaceId == null;
  const grouped = !fromEssential && rt.groupSpace[tab.groupId];
  if (grouped) {
    // Chrome already put it in a space's group (e.g. link opened from a grouped tab).
    rt.tabSpace[tab.id] = grouped;
    if (tab.active) revealTabParents(tab);
    rememberTab(tab);
    touchRt();
    return;
  }
  const spaceId =
    (spaceById(rt.tabSpace[tab.id]) && rt.tabSpace[tab.id]) ||
    (!fromEssential && tab.openerTabId != null && rt.tabSpace[tab.openerTabId]) ||
    windowSpace(tab.windowId);
  await putTabInSpace(tab, spaceId);
  if (tab.active) revealTabParents(tab);
  rememberTab(tab);
  if (tab.active) setWindowSpace(tab.windowId, spaceId);
}

function updateMatters(tabId, ci) {
  if ('pinned' in ci || 'groupId' in ci || 'splitViewId' in ci) return true;
  if (!rt) return true;
  return tabId in rt.tabPin && ('url' in ci || 'title' in ci || 'favIconUrl' in ci || 'status' in ci);
}

chrome.tabs.onUpdated.addListener((tabId, ci, tab) => {
  if (tab && ('url' in ci || 'title' in ci || 'favIconUrl' in ci || 'pinned' in ci)) rememberTab(tab);
  // A reload or new document removes an open search overlay along with the old page.
  if (ci.status === 'loading' && rt && Object.values(rt.searches).some(x => x.overlay && x.tabId === tabId)) {
    enqueue(() => handlers.overlayClosed({}, { tab: { id: tabId } }));
  }
  if (ci.status === 'complete' && isPeekTab(tabId)) injectPeekUi(tabId);
  if (ci.status === 'complete' && rt?.tabPin[tabId]) syncEssentialFlag(tabId);
  if (updateMatters(tabId, ci)) enqueue(() => onTabUpdated(tabId, ci));
});

async function onTabUpdated(tabId, ci) {
  const tab = await getTab(tabId);
  if (!tab || !(await isNormalWindow(tab.windowId))) return;
  if (rt.tabPeeks[tabId]?.split) {
    // Unsplit from Chrome's own UI: treat it like ⤢ (keep the Peek as a tab).
    if (ci.splitViewId === chrome.tabs.SPLIT_VIEW_ID_NONE) await handlers.peekExpand({ tabId });
    return;
  }
  if ('url' in ci && tab.active) revealTabParents(tab);
  const pinId = rt.tabPin[tabId];
  const pin = pinId ? config.pins[pinId] : null;
  if (pinId && !pin) unbindTab(tabId);
  if (pin && tab.active && ci.url) revealPinFolders(pinId);

  if ('pinned' in ci) {
    if (tab.pinned) { delete rt.tabParent[tabId]; rt.treeDetached[tabId] = true; touchTree(); }
    await pruneTabTree();
    if (tab.pinned) {
      // Pinned via Chrome's tab strip: treat it as "add to Essentials".
      delete rt.tabSpace[tabId];
      touchRt();
      if (pin && pin.spaceId != null) await handlers.movePin({ pinId, spaceId: null });
      else if (!pin) bindTab(tabId, createPin(tab, null).id);
    } else {
      // Unpinned via Chrome: the tab becomes a regular tab; the Essential stays (unloaded here).
      if (pin && pin.spaceId == null) unbindTab(tabId);
      if (!rt.groupSpace[tab.groupId]) await putTabInSpace(tab, rt.tabSpace[tabId] ?? windowSpace(tab.windowId));
    }
    return;
  }

  if ('groupId' in ci && !tab.pinned) {
    const spaceId = rt.groupSpace[tab.groupId];
    if (spaceId) {
      if (rt.tabSpace[tabId] !== spaceId) {
        rt.tabSpace[tabId] = spaceId;
        touchRt();
      }
      // A pinned tab dragged into another space's group in the strip becomes a normal tab there.
      if (pin && pin.spaceId !== spaceId) unbindTab(tabId);
      if (tab.active && spaceId !== rt.activeSpace[tab.windowId]) {
        setWindowSpace(tab.windowId, spaceId);
        collapseSoon(tab.windowId);
      }
    } else if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      // Dragged out of its group: every regular tab belongs to a space.
      await putTabInSpace(tab, rt.tabSpace[tabId] ?? windowSpace(tab.windowId));
    } else {
      scheduleReconcile();
    }
  }

  if ('groupId' in ci) await pruneTabTree();
  if (!pin) return;
  const url = tab.url || tab.pendingUrl;
  if ('url' in ci && url && pin.lastUrl !== redactUrl(url, { keepHash: true })) {
    pin.lastUrl = redactUrl(url, { keepHash: true });
    touchConfig();
  }
  const s = settling.get(tabId);
  if (s) {
    if (s.completedAt && Date.now() - s.completedAt > SETTLE_GRACE_MS) settling.delete(tabId);
    else if (ci.url) addAlias(pin, ci.url);
    if (ci.status === 'complete') s.completedAt = Date.now();
  }
  if (!isDrifted(pin, url)) {
    if (ci.title && ci.title !== pin.defaultTitle) {
      pin.defaultTitle = ci.title;
      touchConfig();
    }
    const fav = goodFavicon(ci.favIconUrl);
    if (fav && fav !== pin.favIconUrl) {
      pin.favIconUrl = fav;
      touchConfig();
    }
  }
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const at = Date.now();
  enqueue(async () => {
    if (!(await isNormalWindow(windowId))) return;
    const prev = lastActivation.get(windowId)?.curr ?? rt.mru[windowId]?.[0];
    lastActivation.set(windowId, { prev, curr: tabId, at });
    rt.mru[windowId] = [tabId, ...(rt.mru[windowId] ?? []).filter(id => id !== tabId)].slice(0, 200);
    touchRt();
    // Switching away from a temporary-tab Peek dismisses it, like clicking outside it.
    // Split-view Peeks stay put; clicking the other pane must not close them.
    await closeTabPeeks(windowId, tabId, { splits: false });
    // Switching tabs dismisses an open search, which belongs to the tab it was opened over.
    for (const [token, x] of Object.entries(rt.searches)) {
      if (x.windowId === windowId && (x.overlay ? x.tabId : x.launcherTabId) !== tabId) await closeSearch(token);
    }
    const tab = await getTab(tabId);
    if (!tab) return;
    revealPinFolders(rt.tabPin[tabId]);
    revealTabParents(tab);
    if (tab.pinned) return;
    const spaceId = tabSpaceOf(tab);
    if (!spaceId || spaceId === rt.activeSpace[windowId]) return;
    // If the previous tab is gone, this activation is Chrome's pick after a close; the
    // onRemoved handler will move us back into the right space, so don't follow it.
    if (prev != null && prev !== tabId && !(await getTab(prev))) return;
    setWindowSpace(windowId, spaceId);
    await applyCollapse(windowId);
  });
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  const at = Date.now();
  enqueue(async () => {
    const { windowId, isWindowClosing } = info;
    const spaceId = rt.tabSpace[tabId];
    const wasActive = wasActiveTab(windowId, tabId, at);
    // Closed from Chrome's own UI (Cmd+W, the strip): archive the last page it showed.
    // Our own closes (sidebar, Clear) archive themselves as one batch in closeTabs.
    const snapshot = tabSnapshots.get(tabId);
    const archiveIt = !!snapshot && !(tabId in rt.tabPin) && !isPeekTab(tabId);
    const parent = rt.tabParent[tabId];
    for (const [child, id] of Object.entries(rt.tabParent)) if (id === tabId) {
      if (parent != null) rt.tabParent[child] = parent; else { delete rt.tabParent[child]; rt.treeDetached[child] = true; const current = await getTab(+child); if (current) rememberTab(current); }
    }
    delete rt.tabParent[tabId]; delete rt.treeDetached[tabId];
    for (const [child, id] of Object.entries(rt.tabParent)) if (id === parent) { const current = await getTab(+child); if (current) rememberTab(current); }
    for (const key of Object.keys(rt.treeCollapsed)) if (key.endsWith(`:${tabId}`)) delete rt.treeCollapsed[key];
    touchTree();
    tabWindows.delete(tabId);
    forgetTab(tabId);
    for (const [token, x] of Object.entries(rt.searches)) if (x.tabId === tabId || x.launcherTabId === tabId) delete rt.searches[token];
    delete rt.tabSpace[tabId];
    delete rt.tabPeeks[tabId];
    unbindTab(tabId);
    if (rt.mru[windowId]) rt.mru[windowId] = rt.mru[windowId].filter(id => id !== tabId);
    touchRt();
    for (const [id, p] of Object.entries(rt.tabPeeks)) {
      if (!p.split || p.returnTabId !== tabId) continue;
      delete rt.tabPeeks[id];
      expectedRemovals.add(+id);
      await chrome.tabs.remove(+id).catch(() => {});
    }
    const expected = expectedRemovals.delete(tabId);
    if (!expected && !isWindowClosing && archiveIt) archiveTabs([{ ...snapshot, tabId, parentTabId: parent ?? null, parentPinId: rt.tabPin[parent] ?? null, windowId, spaceId, active: wasActive }]);
    if (expected || isWindowClosing || !wasActive) return;
    await replaceLostActiveTab(windowId, tabId, spaceId);
  });
});

chrome.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
  const at = Date.now();
  enqueue(async () => {
    const spaceId = rt.tabSpace[tabId];
    if (rt.mru[oldWindowId]) rt.mru[oldWindowId] = rt.mru[oldWindowId].filter(id => id !== tabId);
    touchRt();
    if (!spaceId || !wasActiveTab(oldWindowId, tabId, at)) return;
    const remaining = await chrome.tabs.query({ windowId: oldWindowId }).catch(() => []);
    if (remaining.length) await replaceLostActiveTab(oldWindowId, tabId, spaceId);
  });
});

chrome.tabs.onAttached.addListener((tabId, { newWindowId }) =>
  enqueue(async () => {
    const tab = await getTab(tabId);
    if (!tab || tab.pinned || !(await isNormalWindow(newWindowId))) return;
    const known = rt.groupSpace[tab.groupId] ?? (spaceById(rt.tabSpace[tabId]) ? rt.tabSpace[tabId] : null);
    if (known && !spaceById(rt.activeSpace[newWindowId])) setWindowSpace(newWindowId, known);
    const spaceId = known ?? windowSpace(newWindowId);
    if (rt.groupSpace[tab.groupId] !== spaceId) await putTabInSpace(tab, spaceId);
    rememberTab(tab);
    if (rt.tabParent[tabId] != null || Object.values(rt.tabParent).includes(tabId) || rt.treeDetached[tabId]) {
      lastTreeShape = null; // Moving a live tree changes its window identity.
      touchTree();
    }
    await pruneTabTree();
  }),
);

chrome.tabs.onReplaced.addListener((added, removed) =>
  enqueue(async () => {
    for (const map of [rt.tabSpace, rt.tabPin, rt.tabParent, rt.treeDetached]) {
      if (removed in map) {
        map[added] = map[removed];
        delete map[removed];
      }
    }
    for (const [child, parent] of Object.entries(rt.tabParent)) if (parent === removed) rt.tabParent[child] = added;
    for (const key of Object.keys(rt.treeCollapsed)) if (key.endsWith(`:${removed}`)) { rt.treeCollapsed[key.slice(0, key.lastIndexOf(':') + 1) + added] = rt.treeCollapsed[key]; delete rt.treeCollapsed[key]; }
    const replacement = await getTab(added); if (replacement) rememberTab(replacement);
    for (const list of Object.values(rt.mru)) {
      const i = list.indexOf(removed);
      if (i !== -1) list[i] = added;
    }
    touchTree();
  }),
);

chrome.tabGroups.onCreated.addListener(() => scheduleReconcile());

chrome.tabGroups.onRemoved.addListener(group =>
  enqueue(async () => {
    delete rt.groupSpace[group.id];
    touchRt();
  }),
);

// Renaming / recoloring a space's group in Chrome's tab strip renames the space too.
chrome.tabGroups.onUpdated.addListener(group =>
  enqueue(async () => {
    const spaceId = rt.groupSpace[group.id];
    if (!spaceId) return scheduleReconcile();
    const space = spaceById(spaceId);
    const g = await chrome.tabGroups.get(group.id).catch(() => null);
    if (!space || !g?.title) return;
    if (g.title !== space.name || g.color !== space.color) {
      space.name = g.title;
      space.color = g.color;
      touchConfig();
      await syncGroupsForSpace(space);
    }
  }),
);

chrome.windows.onRemoved.addListener(windowId =>
  enqueue(async () => {
    delete rt.peeks[windowId];
    await closePeeksFor(windowId);
    delete rt.activeSpace[windowId];
    delete rt.mru[windowId];
    lastActivation.delete(windowId);
    windowTypes.delete(windowId);
    touchRt();
  }),
);

chrome.commands.onCommand.addListener((command, tab) =>
  enqueue(async () => {
    const windowId = tab?.windowId ?? (await chrome.windows.getLastFocused()).id;
    if (command === 'next-space') await handlers.stepSpace({ windowId, delta: 1 });
    if (command === 'prev-space') await handlers.stepSpace({ windowId, delta: -1 });
    const spaceNumber = command.match(/^space-(\d)$/)?.[1];
    if (spaceNumber) await handlers.goToSpace({ windowId, index: spaceNumber - 1 });
    if (command === 'reset-pinned-tab') {
      const [active] = await chrome.tabs.query({ windowId, active: true });
      const pinId = active && rt.tabPin[active.id];
      if (pinId) await handlers.resetPin({ windowId, pinId });
    }
    if (command === 'copy-url') await handlers.copyUrl({ windowId });
    if (command === 'search') await handlers.openSearch({ windowId });
    if (command === 'undo-close') await handlers.undoArchive({ windowId });
  }),
);

// Service workers have no clipboard access; an offscreen document does the copy.
async function copyToClipboard(text) {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Copy the current tab URL to the clipboard',
    });
  }
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text });
  return !!res?.ok;
}

let badgeTimer;
function flashBadge(text, color) {
  clearTimeout(badgeTimer);
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500);
}

handlers.copyUrl = async ({ windowId }) => {
  const [active] = await chrome.tabs.query({ windowId, active: true });
  const url = active?.url || active?.pendingUrl;
  if (!url) return false;
  const ok = await copyToClipboard(url);
  flashBadge(ok ? '✓' : '!', ok ? '#3c8c5a' : '#c5221f');
  // Toast in the sidebar, if one is open in this window. No receiver is fine.
  chrome.runtime.sendMessage({ target: 'panel', type: 'toast', windowId, text: ok ? 'Copied URL' : 'Couldn’t copy URL' }).catch(() => {});
  return ok;
};

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------------------------------------------------------------------------------------
// Peek: Option-click a link to open it in a popup window centered over the
// current one. Esc / ✕ / clicking back into the main window closes it; ⤢ or ⌘↩ turns it
// into a regular tab in the space it was opened from. A popup window (not an iframe overlay)
// keeps logins working and isn't blocked by sites that refuse to be framed.

async function peekInsteadOfTab(tab, sourceTabId, targetUrl) {
  const opener = config.pins[rt.tabPin[sourceTabId]];
  if (!config.settings.peekFromEssentials || !tab.active || !opener || opener.spaceId != null) return false;
  const url = tab.pendingUrl || tab.url || targetUrl;
  const openerTab = await getTab(sourceTabId);
  // A duplicate of the Essential itself isn't "following a link".
  if (!isWebUrl(url) || !openerTab || sameUrl(url, openerTab.url)) return false;
  const fullscreen = (await chrome.windows.get(tab.windowId).catch(() => null))?.state === 'fullscreen';
  if (fullscreen && !(await canSplitWith(openerTab))) {
    // No split possible: the new tab itself becomes a temporary-tab Peek, so no reload.
    await closeTabPeeks(tab.windowId, tab.id);
    registerTabPeek(tab.id, tab.windowId, openerTab.id);
    return false;
  }
  expectedRemovals.add(tab.id);
  await safe(() => chrome.tabs.update(openerTab.id, { active: true })).catch(() => {});
  await chrome.tabs.remove(tab.id).catch(() => {});
  await handlers.peek({ url, windowId: tab.windowId }, { tab: openerTab });
  return true;
}

// Pushes the Option-click setting to the content script in every open page (it reads the
// peekOnAltClick key on load, and gets live changes this way rather than via storage events,
// which would hand it the whole config).
async function broadcastPeekPrefs() {
  const msg = { type: 'peekPrefs', peekOnAltClick: !!config.settings.peekOnAltClick };
  for (const t of await chrome.tabs.query({})) chrome.tabs.sendMessage(t.id, msg).catch(() => {});
}

const isPeekTab = tabId => !!rt && (tabId in rt.tabPeeks || Object.values(rt.peeks).some(p => p.tabId === tabId));

function registerTabPeek(tabId, parentWindowId, returnTabId, split = false) {
  rt.tabPeeks[tabId] = { parentWindowId, returnTabId, split };
  touchRt();
  injectPeekUi(tabId);
}

async function closeTabPeeks(windowId, keepTabId, { splits = true } = {}) {
  for (const [id, p] of Object.entries(rt.tabPeeks)) {
    if (p.parentWindowId !== windowId || +id === keepTabId || (p.split && !splits)) continue;
    delete rt.tabPeeks[id];
    touchRt();
    expectedRemovals.add(+id);
    await chrome.tabs.remove(+id).catch(() => {});
  }
}

// Chrome's native split view (extension API since Chrome 155). Only a tab that isn't already
// in a split can get a Peek beside it.
async function canSplitWith(tab) {
  if (typeof chrome.tabs.unsplit !== 'function' || !tab) return false;
  const fresh = await getTab(tab.id);
  return !!fresh && (fresh.splitViewId ?? chrome.tabs.SPLIT_VIEW_ID_NONE) === chrome.tabs.SPLIT_VIEW_ID_NONE;
}

// Opens `url` in a split pane beside `source` (to its right). Returns the Peek tab id, or null
// if Chrome refused, so the caller can fall back.
async function openSplitPeek(source, url) {
  if (!(await canSplitWith(source))) return null;
  try {
    const tab = await safe(() => chrome.tabs.create({ splitWithTabId: source.id, url, active: true }));
    registerTabPeek(tab.id, source.windowId, source.id, true);
    return tab.id;
  } catch (e) {
    console.warn('[cove] split view failed, falling back', e);
    return null;
  }
}

// The tab-based Peek that a message refers to, if any.
const tabPeekFor = (tabId, sender) => {
  const id = tabId ?? sender?.tab?.id;
  return id != null && rt.tabPeeks[id] ? id : null;
};

function injectPeekUi(tabId) {
  chrome.scripting.executeScript({ target: { tabId }, files: ['src/peek-ui.js'] }).catch(() => {});
}

async function closePeeksFor(parentWindowId) {
  for (const [id, p] of Object.entries(rt.peeks)) {
    if (p.parentWindowId !== parentWindowId) continue;
    delete rt.peeks[id];
    touchRt();
    await chrome.windows.remove(+id).catch(() => {});
  }
}

Object.assign(handlers, {
  async peek({ url, windowId }, sender) {
    if (!isWebUrl(url)) return;
    const fromTabPeek = tabPeekFor(null, sender);
    if (fromTabPeek != null) {
      await safe(() => chrome.tabs.update(fromTabPeek, { url }));
      return fromTabPeek;
    }
    let parentWindowId = windowId ?? sender?.tab?.windowId;
    // Peeking from inside a peek replaces it rather than stacking windows.
    if (rt.peeks[parentWindowId]) parentWindowId = rt.peeks[parentWindowId].parentWindowId;
    const parent = await chrome.windows.get(parentWindowId).catch(() => null);
    if (!parent) return;
    await closePeeksFor(parentWindowId);
    await closeTabPeeks(parentWindowId);
    const [current] = await chrome.tabs.query({ windowId: parentWindowId, active: true });
    const source = sender?.tab?.windowId === parentWindowId ? sender.tab : current;
    // macOS puts every new window opened from a full-screen window on its own full-screen
    // desktop, so in full screen the Peek goes into a split pane beside the tab you came from
    // (or, if that can't split, a temporary tab that closes back to it).
    const fullscreen = parent.state === 'fullscreen';
    if (fullscreen || config.settings.peekInSplitView) {
      const split = await openSplitPeek(source, url);
      if (split != null) return split;
    }
    if (fullscreen) {
      const tab = await createTabInSpace(parentWindowId, windowSpace(parentWindowId), { url });
      registerTabPeek(tab.id, parentWindowId, current?.id);
      return tab.id;
    }
    const width = Math.round(parent.width * 0.8);
    const height = Math.round(parent.height * 0.86);
    const win = await chrome.windows.create({
      url,
      type: 'popup',
      focused: true,
      width,
      height,
      left: parent.left + Math.round((parent.width - width) / 2),
      top: parent.top + Math.round((parent.height - height) / 2),
    });
    rt.peeks[win.id] = { tabId: win.tabs[0].id, parentWindowId, spaceId: windowSpace(parentWindowId) };
    touchRt();
    return win.id;
  },

  async peekClose({ windowId, tabId }, sender) {
    const tabPeek = tabPeekFor(tabId, sender);
    if (tabPeek != null) {
      const { parentWindowId, returnTabId } = rt.tabPeeks[tabPeek];
      delete rt.tabPeeks[tabPeek];
      touchRt();
      const back = returnTabId != null ? await getTab(returnTabId) : null;
      if (back?.windowId !== parentWindowId) return handlers.closeTabs({ windowId: parentWindowId, tabIds: [tabPeek] });
      expectedRemovals.add(tabPeek);
      await safe(() => chrome.tabs.update(back.id, { active: true })).catch(() => {});
      await chrome.tabs.remove(tabPeek).catch(() => {});
      return;
    }
    const id = windowId ?? sender?.tab?.windowId;
    const peek = rt.peeks[id];
    if (!peek) return;
    delete rt.peeks[id];
    touchRt();
    await chrome.windows.remove(id).catch(() => {});
    await chrome.windows.update(peek.parentWindowId, { focused: true }).catch(() => {});
  },

  // Popup tabs can't be moved into a normal window, so the page is reopened by URL.
  async peekExpand({ windowId, tabId }, sender) {
    const tabPeek = tabPeekFor(tabId, sender);
    if (tabPeek != null) {
      // Already a real tab: stop treating it as a Peek. A split Peek leaves the split and joins
      // the current space as a normal, full-width tab ("mount" it).
      const { parentWindowId, split } = rt.tabPeeks[tabPeek];
      delete rt.tabPeeks[tabPeek];
      touchRt();
      let tab = await getTab(tabPeek);
      if (split && tab) {
        if ((tab.splitViewId ?? -1) !== chrome.tabs.SPLIT_VIEW_ID_NONE) await safe(() => chrome.tabs.unsplit(tab.splitViewId)).catch(() => {});
        tab = await getTab(tabPeek);
        if (tab && (tab.pinned || !rt.groupSpace[tab.groupId])) await putTabInSpace(tab, windowSpace(parentWindowId));
        await safe(() => chrome.tabs.update(tabPeek, { active: true })).catch(() => {});
      }
      await chrome.scripting
        .executeScript({ target: { tabId: tabPeek }, func: () => window.__covePeek?.dismiss() })
        .catch(() => {});
      return tabPeek;
    }
    const id = windowId ?? sender?.tab?.windowId;
    const peek = rt.peeks[id];
    if (!peek) return;
    const tab = await getTab(peek.tabId);
    const url = tab?.url || tab?.pendingUrl;
    delete rt.peeks[id];
    touchRt();
    await chrome.windows.remove(id).catch(() => {});
    if (!url || !(await chrome.windows.get(peek.parentWindowId).catch(() => null))) return;
    const spaceId = spaceById(peek.spaceId) ? peek.spaceId : windowSpace(peek.parentWindowId);
    setWindowSpace(peek.parentWindowId, spaceId);
    const created = await createTabInSpace(peek.parentWindowId, spaceId, { url });
    await chrome.windows.update(peek.parentWindowId, { focused: true }).catch(() => {});
    return created.id;
  },
});

// Clicking back into another Chrome window dismisses the peek. Switching apps
// (WINDOW_ID_NONE) leaves it open.
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  enqueue(async () => {
    for (const id of Object.keys(rt.peeks)) {
      if (+id === windowId) continue;
      delete rt.peeks[id];
      touchRt();
      await chrome.windows.remove(+id).catch(() => {});
    }
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'peek-link', title: 'Open link in Peek', contexts: ['link'] }, () => void chrome.runtime.lastError);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'peek-link' && tab) enqueue(() => handlers.peek({ url: info.linkUrl, windowId: tab.windowId }));
});

// ---------------------------------------------------------------------------------------
// Reconcile: make runtime state match the real tabs. Runs on every service-worker start and
// whenever an unknown group shows up. On the first run of a browser session it also re-binds
// restored tabs to their pins by URL and adopts existing tab groups as spaces (which is also
// how groups left behind by another tab-group extension get picked up).

let reconcileTimer;
function scheduleReconcile() {
  clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => enqueue(reconcile), 400);
}

async function reconcile() {
  const initial = !rt.initialized;
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const windowIds = new Set(windows.map(w => w.id));
  for (const id of windowIds) windowTypes.set(id, 'normal');
  const liveTabs = new Map(windows.flatMap(w => w.tabs.map(t => [t.id, t])));

  if (treeRestoreIdentity) {
    const matches = id => {
      const tab = liveTabs.get(+id), saved = treeRestoreIdentity[id];
      return !browserStarting && tab && saved && tab.windowId === saved.windowId &&
        (saved.url == null || redactUrl(tab.pendingUrl || tab.url, { keepHash: true }) === saved.url);
    };
    for (const [child, parent] of Object.entries(rt.tabParent)) if (!matches(child) || !matches(parent)) delete rt.tabParent[child];
    for (const id of Object.keys(rt.treeDetached)) if (!matches(id)) delete rt.treeDetached[id];
    for (const key of Object.keys(rt.treeCollapsed)) if (!matches(key.slice(key.lastIndexOf(':') + 1))) delete rt.treeCollapsed[key];
    treeRestoreIdentity = null;
    dirtyTree = true;
  }
  const groups = (await chrome.tabGroups.query({})).filter(g => windowIds.has(g.windowId));
  const liveGroups = new Set(groups.map(g => g.id));
  for (const [gid, sid] of Object.entries(rt.groupSpace)) {
    if (!liveGroups.has(+gid) || !spaceById(sid)) delete rt.groupSpace[gid];
  }
  for (const g of groups) {
    if (rt.groupSpace[g.id]) continue;
    let space = g.title ? config.spaces.find(s => s.name === g.title) : null;
    if (!space) {
      space = {
        id: newId(),
        name: g.title || `Space ${config.spaces.length + 1}`,
        icon: '',
        color: COLORS[g.color] ? g.color : 'grey',
        pins: [],
      };
      config.spaces.push(space);
      touchConfig();
      if (!g.title) await safe(() => chrome.tabGroups.update(g.id, { title: space.name })).catch(() => {});
    }
    rt.groupSpace[g.id] = space.id;
  }

  const bound = new Set(); // `${pinId}:${windowId}`
  for (const [id, pid] of Object.entries(rt.tabPin)) {
    const t = liveTabs.get(+id);
    if (!t || !config.pins[pid]) delete rt.tabPin[id];
    else bound.add(`${pid}:${t.windowId}`);
  }
  for (const id of Object.keys(rt.tabSpace)) if (!liveTabs.has(+id)) delete rt.tabSpace[id];
  for (const id of Object.keys(rt.tabPeeks)) if (!liveTabs.has(+id)) delete rt.tabPeeks[id];
  for (const [token, x] of Object.entries(rt.searches)) {
    if (!liveTabs.has(x.overlay ? x.tabId : x.launcherTabId)) delete rt.searches[token];
  }
  // Rebuild the last-known page of every open tab (the archive uses it when a tab closes).
  for (const id of tabSnapshots.keys()) if (!liveTabs.has(id)) tabSnapshots.delete(id);
  for (const t of liveTabs.values()) rememberTab(t);
  saveSnapshotsSoon();
  for (const wid of Object.keys(rt.activeSpace)) if (!windowIds.has(+wid)) delete rt.activeSpace[wid];
  for (const wid of Object.keys(rt.mru)) {
    if (!windowIds.has(+wid)) delete rt.mru[wid];
    else rt.mru[wid] = rt.mru[wid].filter(id => liveTabs.has(id));
  }

  const tryBind = (t, spaceId, exactOnly) => {
    if (!initial || rt.tabPin[t.id]) return;
    const url = t.url || t.pendingUrl;
    const exact = value => value && destinationKey(url) === destinationKey(value);
    const available = (pinList(spaceId) ?? []).filter(pid => !bound.has(`${pid}:${t.windowId}`));
    const pinId = available.find(pid => exact(config.pins[pid].url)) || (!exactOnly && available.find(pid => {
      const p = config.pins[pid];
      // A saved hash route must never adopt a different route on the same page.
      if (new URL(p.url).hash && sameUrl(url, p.url)) return false;
      return exact(p.lastUrl) || (p.aliases || []).some(exact) || !isDrifted(p, url);
    }));
    if (pinId) {
      rt.tabPin[t.id] = pinId;
      bound.add(`${pinId}:${t.windowId}`);
    }
  };

  for (const w of windows) {
    const active = w.tabs.find(t => t.active);
    if (!spaceById(rt.activeSpace[w.id])) {
      rt.activeSpace[w.id] = (active && (rt.groupSpace[active.groupId] || rt.tabSpace[active.id])) ||
        (spaceById(rt.lastSpace) ? rt.lastSpace : config.spaces[0].id);
    }
    // Keep broad redirect/last-URL matches from stealing another tab's exact pin.
    for (const exactOnly of [true, false]) for (const t of w.tabs) {
      if (rt.tabPeeks[t.id]?.split) continue;
      const spaceId = t.pinned ? null : rt.groupSpace[t.groupId] || rt.tabSpace[t.id] || rt.activeSpace[w.id];
      tryBind(t, spaceId, exactOnly);
    }
    const ungrouped = [];
    for (const t of w.tabs) {
      if (rt.tabPeeks[t.id]?.split) continue;
      if (t.pinned) {
        delete rt.tabSpace[t.id];
        if (!rt.tabPin[t.id]) {
          const pin = createPin(t, null);
          rt.tabPin[t.id] = pin.id;
          bound.add(`${pin.id}:${w.id}`);
        }
        continue;
      }
      const spaceId = rt.groupSpace[t.groupId];
      if (!spaceId) {
        ungrouped.push(t);
        continue;
      }
      rt.tabSpace[t.id] = spaceId;
      const pid = rt.tabPin[t.id];
      if (pid && config.pins[pid].spaceId !== spaceId) delete rt.tabPin[t.id];
    }
    for (const t of ungrouped) {
      const spaceId = spaceById(rt.tabSpace[t.id]) ? rt.tabSpace[t.id] : rt.activeSpace[w.id];
      await putTabInSpace(t, spaceId).catch(e => console.warn('[cove] group failed', e));
    }
    if (!rt.mru[w.id]) {
      rt.mru[w.id] = [...w.tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)).map(t => t.id);
    }
  }

  await pruneTabTree();
  for (const tab of liveTabs.values()) if (tab.active) { revealTabParents(tab); revealPinFolders(rt.tabPin[tab.id]); }

  // First install: drop the placeholder "Main" space if existing groups were adopted instead.
  if (config.fresh) {
    delete config.fresh;
    const main = config.spaces[0];
    const used = Object.values(rt.tabSpace).includes(main.id) || Object.values(rt.groupSpace).includes(main.id);
    if (config.spaces.length > 1 && !main.pins.length && !used) config.spaces.shift();
    touchConfig();
  }

  rt.initialized = true;
  touchRt();
  for (const w of windows) await applyCollapse(w.id);
}
