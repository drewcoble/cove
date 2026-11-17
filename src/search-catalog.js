// Everything search can find, as plain items. Pure: callers pass in the data, so it runs
// only in extension pages and never sees a web page. Adapted from a contribution by Julio
// Orozco (drewcoble/cove#1).

import { hostname, pinTitle } from './shared.js';
import { isLauncherOrNewTab } from './search.js';

export function folderPath(folders, folderId) {
  const names = [];
  const seen = new Set();
  let folder = folders?.[folderId];
  while (folder && !seen.has(folder.id)) {
    names.unshift(folder.name);
    seen.add(folder.id);
    folder = folders[folder.parentId];
  }
  return names.join(' / ');
}

const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export function searchCatalog({ config, archive = [], rt, tabs, windowId, excludeTabId, spaceId, mode, root }) {
  const spaceName = id => config.spaces.find(space => space.id === id)?.name || (id == null ? 'Essentials' : 'Removed space');
  const pathOf = pin => folderPath(config.folders, pin.folderId);

  if (mode === 'archive') {
    return archive.map(entry => ({
      key: `archive-${entry.id}`, kind: 'archive', id: entry.id,
      label: entry.title || hostname(entry.url) || entry.url,
      detail: `${spaceName(entry.spaceId)} · ${hostname(entry.url)} · ${dateFormat.format(entry.closedAt)}`,
      searchDetail: `${entry.url} ${spaceName(entry.spaceId)}`, badge: 'Restore', icon: 'archive', url: entry.url,
    }));
  }

  const items = [];
  const mru = new Map((rt.mru?.[windowId] ?? []).map((id, i) => [id, i]));
  const rank = tab => mru.get(tab.id) ?? Infinity;
  const boundPins = new Set();
  const live = tabs
    .filter(tab => tab.id !== excludeTabId && !isLauncherOrNewTab(tab.pendingUrl || tab.url, root))
    .sort((a, b) => rank(a) - rank(b) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const tab of live) {
    const pin = config.pins[rt.tabPin?.[tab.id]];
    if (pin) boundPins.add(pin.id);
    const id = tab.pinned ? null : rt.groupSpace?.[tab.groupId] ?? rt.tabSpace?.[tab.id];
    const url = tab.pendingUrl || tab.url || '';
    items.push({
      key: `tab-${tab.id}`, kind: 'tab', id: tab.id,
      label: pin ? pinTitle(pin, tab) : tab.title || hostname(url) || 'Untitled tab',
      detail: [hostname(url), spaceName(id), pin && pathOf(pin)].filter(Boolean).join(' · '),
      searchDetail: `${url} ${spaceName(id)} ${pin ? pathOf(pin) : ''}`,
      badge: 'Switch to tab', url, spaceId: id, lastAccessed: tab.lastAccessed, mruRank: rank(tab),
    });
  }
  for (const pin of Object.values(config.pins)) {
    if (boundPins.has(pin.id)) continue;
    items.push({
      key: `pin-${pin.id}`, kind: 'pin', id: pin.id, label: pinTitle(pin),
      detail: [hostname(pin.url), spaceName(pin.spaceId), pathOf(pin)].filter(Boolean).join(' · '),
      searchDetail: `${pin.url} ${spaceName(pin.spaceId)} ${pathOf(pin)}`, badge: 'Pinned', url: pin.url, spaceId: pin.spaceId,
    });
  }
  for (const space of config.spaces) {
    items.push({ key: `space-${space.id}`, kind: 'space', id: space.id, label: `Switch to ${space.name}`,
      detail: 'Space', badge: 'Switch space', icon: 'space', searchDetail: space.name });
  }
  items.push(
    { key: 'action-folder', kind: 'action', id: 'folder', label: 'New folder', detail: `Organize pins in ${spaceName(spaceId)}`, badge: 'Create', icon: 'folder' },
    { key: 'action-archive', kind: 'action', id: 'archive', label: 'View archive', detail: 'Find and restore closed tabs', badge: 'Open', icon: 'archive' },
  );
  if (archive.some(entry => entry.windowId === windowId)) {
    items.push({ key: 'action-undo', kind: 'action', id: 'undo', label: 'Undo last close',
      detail: 'Restore the last closed tab or cleared batch', badge: 'Restore', icon: 'undo' });
  }
  return items;
}
