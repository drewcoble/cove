// Cove service worker.
//
// Model:
//   - A space is backed by one Chrome tab group per window (group title = space name), so
//     space-mates stay contiguous in the tab strip and inactive spaces can be collapsed.
//   - Essentials are Chrome-pinned tabs (shared by every space, never grouped).
//   - Pinned tabs are entries in a space's `pins` list. A pin is "bound" to at most one live
//     tab per window; closing that tab leaves the pin in the sidebar, unloaded.
//
// Persistent config (spaces, pins, settings) lives in storage.local. Runtime bookkeeping
// keyed by tab/group/window ids lives in storage.session, which survives service-worker
// restarts but not browser restarts; on a fresh browser session `reconcile()` rebuilds it
// from the restored tab groups and tab URLs.

import { COLORS, newId, sameUrl, isDrifted, isWebUrl, redactUrl } from './shared.js';

const SETTLE_GRACE_MS = 1500;
const ACTIVATION_RACE_MS = 300;
const MAX_ALIASES = 4;

let config;
let rt;
const lastActivation = new Map(); // windowId -> { prev, curr, at }
const expectedRemovals = new Set(); // tabs we close ourselves (we pick the successor up front)
const settling = new Map(); // tabId -> { completedAt } while a freshly opened pin may still redirect
const windowTypes = new Map();

function defaultConfig() {
  return {
    version: 1,
    fresh: true,
    spaces: [{ id: newId(), name: 'Main', icon: '', color: 'blue', pins: [] }],
    essentials: [],
    pins: {},
    settings: { collapseInactive: true, resetOnReclick: true, peekOnAltClick: true, peekFromEssentials: true, peekInSplitView: false },
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
    pin.lastUrl = pin.lastUrl && redactUrl(pin.lastUrl);
    pin.aliases = [...new Set((pin.aliases ?? []).map(redactUrl).filter(Boolean))];
  }
  return cfg;
}

// ---------------------------------------------------------------------------------------
// Serialized execution: every event and message runs through one queue so async handlers
// never interleave, and state is flushed to storage once per task.

let dirtyConfig = false;
let dirtyRt = false;
const touchConfig = () => (dirtyConfig = true);
const touchRt = () => (dirtyRt = true);

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
  await Promise.all(writes);
}

const ready = (async () => {
  const [{ config: c }, { rt: r }] = await Promise.all([
    chrome.storage.local.get('config'),
    chrome.storage.session.get('rt'),
  ]);
  const stored = JSON.stringify(c);
  config = normalizeConfig(c);
  rt = { ...emptyRt(), ...r };
  if (!c || JSON.stringify(config) !== stored) touchConfig();
  await chrome.storage.local.set({ peekOnAltClick: !!config.settings.peekOnAltClick });
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

async function createTabInSpace(windowId, spaceId, { url, active = true } = {}) {
  const tab = await safe(() => chrome.tabs.create({ windowId, url, active }));
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
    lastUrl: redactUrl(url),
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
// other sites can open in Peek instead of navigating the Essential away. Re-sent on every
// page load because the flag lives on the document.
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
  url = redactUrl(url);
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
  const settings = {};
  for (const key of Object.keys(defaultConfig().settings)) {
    if (typeof c.settings?.[key] === 'boolean') settings[key] = c.settings[key];
  }
  return normalizeConfig({ version: 1, spaces, essentials, pins, settings });
}

// ---------------------------------------------------------------------------------------
// Message handlers (called from the side panel)

const handlers = {
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

  async newTab({ windowId, spaceId }) {
    const target = spaceById(spaceId) ? spaceId : windowSpace(windowId);
    setWindowSpace(windowId, target);
    await createTabInSpace(windowId, target);
  },

  async closeTabs({ windowId, tabIds }) {
    const [active] = await chrome.tabs.query({ windowId, active: true });
    for (const id of tabIds) expectedRemovals.add(id);
    if (active && tabIds.includes(active.id)) {
      // Pick the successor ourselves before Chrome does, so there's no flash of another space.
      const spaceId = active.pinned ? windowSpace(windowId) : tabSpaceOf(active) ?? windowSpace(windowId);
      const next = await pickSuccessor(windowId, spaceId, active.id);
      if (next) await safe(() => chrome.tabs.update(next.id, { active: true }));
      else if (!active.pinned) await createTabInSpace(windowId, spaceId);
    }
    await safe(() => chrome.tabs.remove(tabIds)).catch(() => {});
  },

  async clearSpace({ windowId, spaceId }) {
    const tabs = await chrome.tabs.query({ windowId });
    const tabIds = tabs.filter(t => tabSpaceOf(t) === spaceId && !rt.tabPin[t.id]).map(t => t.id);
    if (tabIds.length) await handlers.closeTabs({ windowId, tabIds });
  },

  // Click a pin to switch to it; click it again while it's active and has
  // navigated away to send it back to its pinned URL.
  async openPin({ windowId, pinId }) {
    const pin = config.pins[pinId];
    if (!pin) return;
    const tab = await boundTab(pinId, windowId);
    if (tab) {
      if (!tab.active) await safe(() => chrome.tabs.update(tab.id, { active: true }));
      else if (config.settings.resetOnReclick && isDrifted(pin, tab.url || tab.pendingUrl)) {
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

  async pinTab({ tabId, spaceId = null, index }) {
    const tab = await getTab(tabId);
    if (!tab || (spaceId != null && !spaceById(spaceId))) return;
    const existing = rt.tabPin[tabId];
    if (existing && config.pins[existing]) return handlers.movePin({ pinId: existing, spaceId, index });
    const pin = createPin(tab, spaceId, index);
    bindTab(tabId, pin.id);
    await placePinTab(tab, spaceId);
  },

  async movePin({ pinId, spaceId = null, index }) {
    const pin = config.pins[pinId];
    if (!pin || !pinList(spaceId)) return;
    detachPin(pinId);
    insertAt(pinList(spaceId), pinId, index);
    const changed = pin.spaceId !== spaceId;
    pin.spaceId = spaceId;
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
    collapseSoon(tab.windowId);
  },

  exportConfig() {
    const { spaces, essentials, pins, settings } = config;
    return {
      format: SETUP_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      config: normalizeConfig(structuredClone({ spaces, essentials, pins, settings })),
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

// Content scripts run on every site, so they may only reach the Peek handlers.
const CONTENT_SCRIPT_HANDLERS = new Set(['peek', 'peekClose', 'peekExpand']);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return;
  const fromExtensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
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

chrome.tabs.onCreated.addListener(tab => enqueue(() => onTabCreated(tab.id)));

async function onTabCreated(tabId) {
  const tab = await getTab(tabId);
  if (!tab || !(await isNormalWindow(tab.windowId))) return;
  if (rt.tabPeeks[tab.id]?.split) return;
  if (tab.pinned) {
    if (!rt.tabPin[tab.id]) bindTab(tab.id, createPin(tab, null).id);
    return;
  }
  const grouped = rt.groupSpace[tab.groupId];
  if (grouped) {
    // Chrome already put it in a space's group (e.g. link opened from a grouped tab).
    rt.tabSpace[tab.id] = grouped;
    touchRt();
    return;
  }
  const spaceId =
    (spaceById(rt.tabSpace[tab.id]) && rt.tabSpace[tab.id]) ||
    (tab.openerTabId != null && rt.tabSpace[tab.openerTabId]) ||
    windowSpace(tab.windowId);
  await putTabInSpace(tab, spaceId);
  if (tab.active) setWindowSpace(tab.windowId, spaceId);
}

function updateMatters(tabId, ci) {
  if ('pinned' in ci || 'groupId' in ci || 'splitViewId' in ci) return true;
  if (!rt) return true;
  return tabId in rt.tabPin && ('url' in ci || 'title' in ci || 'favIconUrl' in ci || 'status' in ci);
}

chrome.tabs.onUpdated.addListener((tabId, ci) => {
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
  const pinId = rt.tabPin[tabId];
  const pin = pinId ? config.pins[pinId] : null;
  if (pinId && !pin) unbindTab(tabId);

  if ('pinned' in ci) {
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

  if (!pin) return;
  const url = tab.url || tab.pendingUrl;
  if ('url' in ci && url && pin.lastUrl !== redactUrl(url)) {
    pin.lastUrl = redactUrl(url);
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
    const tab = await getTab(tabId);
    if (!tab || tab.pinned) return;
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
    if (expectedRemovals.delete(tabId) || isWindowClosing || !wasActive) return;
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
  }),
);

chrome.tabs.onReplaced.addListener((added, removed) =>
  enqueue(async () => {
    for (const map of [rt.tabSpace, rt.tabPin]) {
      if (removed in map) {
        map[added] = map[removed];
        delete map[removed];
      }
    }
    for (const list of Object.values(rt.mru)) {
      const i = list.indexOf(removed);
      if (i !== -1) list[i] = added;
    }
    touchRt();
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

// Links from Essentials open in Peek: a foreground tab the Essential's page opened itself
// (email links, target=_blank, window.open) becomes a Peek, leaving the Essential where it was.
// Background tabs (⌘-click) are left alone.
//
// "Opened by the Essential" comes from webNavigation, not tab.openerTabId: Chrome can also give
// a tab the active tab as its opener when a link arrives from another app (Slack, Mail), and
// those must open as normal tabs. webNavigation only reports a source tab when a page opened it.
chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId, url }) =>
  enqueue(async () => {
    const tab = await getTab(tabId);
    if (tab && (await isNormalWindow(tab.windowId))) await peekInsteadOfTab(tab, sourceTabId, url);
  }),
);

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
  for (const wid of Object.keys(rt.activeSpace)) if (!windowIds.has(+wid)) delete rt.activeSpace[wid];
  for (const wid of Object.keys(rt.mru)) {
    if (!windowIds.has(+wid)) delete rt.mru[wid];
    else rt.mru[wid] = rt.mru[wid].filter(id => liveTabs.has(id));
  }

  const tryBind = (t, spaceId) => {
    if (!initial || rt.tabPin[t.id]) return;
    const url = t.url || t.pendingUrl;
    const pinId = (pinList(spaceId) ?? []).find(pid => {
      const p = config.pins[pid];
      return !bound.has(`${pid}:${t.windowId}`) && (sameUrl(url, p.lastUrl) || !isDrifted(p, url));
    });
    if (pinId) {
      rt.tabPin[t.id] = pinId;
      bound.add(`${pinId}:${t.windowId}`);
    }
  };

  for (const w of windows) {
    const ungrouped = [];
    for (const t of w.tabs) {
      if (rt.tabPeeks[t.id]?.split) continue;
      if (t.pinned) {
        delete rt.tabSpace[t.id];
        tryBind(t, null);
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
      tryBind(t, spaceId);
    }
    const active = w.tabs.find(t => t.active);
    if (!spaceById(rt.activeSpace[w.id])) {
      rt.activeSpace[w.id] =
        (active && rt.tabSpace[active.id]) || (spaceById(rt.lastSpace) ? rt.lastSpace : config.spaces[0].id);
    }
    for (const t of ungrouped) {
      const spaceId = spaceById(rt.tabSpace[t.id]) ? rt.tabSpace[t.id] : rt.activeSpace[w.id];
      await putTabInSpace(t, spaceId).catch(e => console.warn('[cove] group failed', e));
      tryBind(t, spaceId);
    }
    if (!rt.mru[w.id]) {
      rt.mru[w.id] = [...w.tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)).map(t => t.id);
    }
  }

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
