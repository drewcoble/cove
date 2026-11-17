// A live, per-window tree. Chrome still owns the tabs; collapsing only changes the sidebar.
export const tabSpace = (tab, rt) => tab.pinned ? null : rt.groupSpace?.[tab.groupId] ?? rt.tabSpace?.[tab.id] ?? null;
export function validParent(child, parent, rt) {
  return !!child && !!parent && child.id !== parent.id && child.windowId === parent.windowId &&
    !(child.pendingUrl || child.url || '').startsWith('chrome-extension:') &&
    !child.pinned && !rt.tabPin?.[child.id] && !rt.tabPeeks?.[child.id] && !rt.tabPeeks?.[parent.id] &&
    (parent.pinned || tabSpace(child, rt) === tabSpace(parent, rt));
}
export function descendants(id, parents) {
  const children = new Map();
  for (const [child, parent] of Object.entries(parents || {})) {
    const list = children.get(parent) || []; list.push(+child); children.set(parent, list);
  }
  const found = new Set(); const pending = [id];
  while (pending.length) for (const child of children.get(pending.pop()) || []) {
    if (child !== id && !found.has(child)) { found.add(child); pending.push(child); }
  }
  return [...found];
}
export function buildTabTree(tabs, rt, spaceId) {
  const byId = new Map(tabs.map(tab => [tab.id, tab]));
  const children = new Map();
  const parents = {};
  for (const tab of tabs) {
    const parent = byId.get(rt.tabParent?.[tab.id]);
    if (!validParent(tab, parent, rt) || tabSpace(tab, rt) !== spaceId) continue;
    const seen = new Set([tab.id]); let cursor = parent.id; let cycle = false;
    while (cursor != null) { if (seen.has(cursor)) { cycle = true; break; } seen.add(cursor); cursor = rt.tabParent?.[cursor]; }
    if (cycle) continue;
    parents[tab.id] = parent.id;
    const list = children.get(parent.id) || []; list.push(tab); children.set(parent.id, list);
  }
  const counts = new Map();
  const count = id => {
    if (!counts.has(id)) counts.set(id, (children.get(id) || []).reduce((sum, child) => sum + 1 + count(child.id), 0));
    return counts.get(id);
  };
  const info = id => ({ childCount: count(id), collapsed: !!rt.treeCollapsed?.[`${spaceId}:${id}`] });
  const rows = (roots, depth = 0) => {
    const output = [];
    function visit(tab, level) {
      const state = info(tab.id);
      output.push({ tab, depth: level, parentId: parents[tab.id] ?? null, ...state });
      if (!state.collapsed) for (const child of children.get(tab.id) || []) visit(child, level + 1);
    }
    for (const root of roots) visit(root, depth);
    return output;
  };
  return { info, parents,
    children: (id, depth) => rows(info(id).collapsed ? [] : children.get(id) || [], depth),
    rows: rows(tabs.filter(tab => !tab.pinned && !rt.tabPin?.[tab.id] && tabSpace(tab, rt) === spaceId && parents[tab.id] == null)),
    essentials: tabs.filter(tab => tab.pinned && children.has(tab.id)),
  };
}
