import { hostname, pinTitle } from './shared.js';
import { isNewTabUrl } from './search.js';

// Pure catalog shared by New Tab and the in-page command overlay.
export function searchCatalog({ config, rt, tabs, windowId, excludeTabId, spaceId, mode, root }) {
  const spaceName = id => config.spaces.find(space => space.id === id)?.name || (id == null ? 'Essentials' : 'Previous space');
  const folderPath = pin => {
    const names = [];
    const seen = new Set();
    let folder = config.folders?.[pin.folderId];
    while (folder && !seen.has(folder.id)) {
      names.unshift(folder.name);
      seen.add(folder.id);
      folder = config.folders[folder.parentId];
    }
    return names.join(' / ');
  };
  if (mode === 'archive') return config.archive.map(entry => ({
    key: entry.id, kind: 'archive', id: entry.id, label: entry.title || hostname(entry.url) || entry.url,
    detail: `${spaceName(entry.spaceId)} · ${hostname(entry.url)} · ${new Date(entry.closedAt).toLocaleDateString()}`,
    searchDetail: `${entry.url} ${spaceName(entry.spaceId)}`, badge: 'Restore', icon: 'archive', url: entry.url,
  }));
  const items = [];
  const mru = rt.mru?.[windowId] || [];
  const rank = tab => mru.indexOf(tab.id) === -1 ? Infinity : mru.indexOf(tab.id);
  const live = tabs.filter(tab => {
    const url = tab.pendingUrl || tab.url || '';
    return tab.id !== excludeTabId && !isNewTabUrl(url, root) && !url.startsWith(root);
  }).sort((a, b) => rank(a) - rank(b) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const tab of live) {
    const pin = config.pins[rt.tabPin?.[tab.id]];
    const id = tab.pinned ? null : rt.groupSpace?.[tab.groupId] || rt.tabSpace?.[tab.id];
    const url = tab.pendingUrl || tab.url || '';
    items.push({ key: `tab-${tab.id}`, kind: 'tab', id: tab.id,
      label: pin ? pinTitle(pin, tab) : tab.title || hostname(url) || 'Untitled tab',
      detail: [hostname(url), spaceName(id), pin && folderPath(pin)].filter(Boolean).join(' · '),
      searchDetail: `${url} ${spaceName(id)} ${pin ? folderPath(pin) : ''}`,
      badge: 'Switch to tab', url,
    });
  }
  for (const pin of Object.values(config.pins)) {
    if (tabs.some(tab => rt.tabPin?.[tab.id] === pin.id)) continue;
    items.push({ key: `pin-${pin.id}`, kind: 'pin', id: pin.id, label: pinTitle(pin),
      detail: [hostname(pin.url), spaceName(pin.spaceId), folderPath(pin)].filter(Boolean).join(' · '),
      searchDetail: `${pin.url} ${spaceName(pin.spaceId)} ${folderPath(pin)}`, badge: 'Pinned', url: pin.url,
    });
  }
  for (const space of config.spaces) items.push({ key: `space-${space.id}`, kind: 'space', id: space.id,
    label: `Switch to ${space.name}`, detail: 'Space', badge: 'Switch space', icon: 'space', searchDetail: space.name,
  });
  items.push(
    { key: 'folder', kind: 'action', id: 'folder', label: 'New folder', detail: `Organize pins in ${spaceName(spaceId)}`, badge: 'Create', icon: 'folder' },
    { key: 'archive', kind: 'action', id: 'archive', label: 'View archive', detail: 'Find and restore closed tabs', badge: 'Open', icon: 'archive' },
  );
  if (config.archive.some(entry => entry.windowId === windowId)) items.push({ key: 'undo', kind: 'action', id: 'undo', label: 'Undo last close',
    detail: 'Restore the last closed tab or cleared batch', badge: 'Restore', icon: 'undo',
  });
  return items;
}
