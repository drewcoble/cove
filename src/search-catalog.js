// Everything search can find, as plain items. Pure: callers pass in the data, so it runs
// only in extension pages and never sees a web page. Adapted from a contribution by Julio
// Orozco (drewcoble/cove#1).

import { hostname, pinTitle } from './shared.js';

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
  for (const pin of Object.values(config.pins)) {
    if (pin.spaceId != null && pin.spaceId !== spaceId) continue;
    const tab = tabs.find(t => t.windowId === windowId && rt.tabPin?.[t.id] === pin.id);
    items.push({
      key: `pin-${pin.id}`, kind: 'pin', id: pin.id, label: pinTitle(pin),
      detail: [hostname(pin.url), spaceName(pin.spaceId), pathOf(pin)].filter(Boolean).join(' · '),
      searchDetail: `${pin.url} ${spaceName(pin.spaceId)} ${pathOf(pin)}`,
      badge: tab ? 'Switch to tab' : 'Pinned', url: pin.url, spaceId: pin.spaceId,
      lastAccessed: tab?.lastAccessed,
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
