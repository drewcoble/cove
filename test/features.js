// Folders, setup import repair, and the closed-tab archive.
(async () => {
  const log = [];
  const ok = (cond, msg) => log.push((cond ? 'PASS ' : 'FAIL ') + msg);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const raw = (type, p = {}) => chrome.runtime.sendMessage({ type, ...p });
  const send = async (type, p = {}) => {
    const r = await raw(type, p);
    if (!r?.ok) throw new Error(type + ': ' + r?.error);
    return r.result;
  };
  const cfg = async () => (await chrome.storage.local.get('config')).config;
  const archive = async () => (await chrome.storage.local.get('archive')).archive ?? [];
  const rt = async () => (await chrome.storage.session.get('rt')).rt;
  const B = '__BASE__';
  const waitLoad = async id => {
    for (let i = 0; i < 50; i++) {
      const t = await chrome.tabs.get(id).catch(() => null);
      if (!t || t.status === 'complete') return t;
      await sleep(100);
    }
  };
  const open = async (windowId, path, active = false) => {
    const t = await chrome.tabs.create({ windowId, url: B + path, active });
    await waitLoad(t.id);
    await sleep(150);
    return t;
  };

  try {
    await sleep(800);
    const panelWindow = (await chrome.windows.getCurrent()).id;
    const W = (await chrome.windows.create({ url: B + '/start', focused: true })).id;
    await sleep(800);
    const main = (await cfg()).spaces[0].id;
    const other = await send('createSpace', { name: 'Other' });

    // ---------------- Folders ----------------
    const work = await send('createFolder', { spaceId: main, name: 'Work' });
    const reports = await send('createFolder', { spaceId: main, name: 'Reports', parentId: work });
    const deep = await send('createFolder', { spaceId: main, name: 'Q3', parentId: reports });
    const t1 = await open(W, '/doc-1');
    await send('pinTab', { tabId: t1.id, spaceId: main, folderId: deep });
    let c = await cfg();
    const p1 = c.spaces[0].pins.at(-1);
    ok(c.pins[p1].folderId === deep, 'pinning a tab into a nested folder');

    let r = await raw('updateFolder', { folderId: work, parentId: deep });
    ok(!r.ok && (await cfg()).folders[work].parentId === null, 'moving a folder inside its own subfolder is refused');
    r = await raw('pinTab', { tabId: (await open(W, '/x')).id, spaceId: other, folderId: work });
    ok(!r.ok, 'a folder from another space is refused');

    const t2 = await open(W, '/doc-2');
    await send('pinTab', { tabId: t2.id, spaceId: main, folderId: reports });
    const p2 = (await cfg()).spaces[0].pins.at(-1);
    await send('updateFolder', { folderId: work, collapsed: true });
    await send('updateFolder', { folderId: reports, collapsed: true });
    await send('unloadPin', { windowId: W, pinId: p1 });
    await send('unloadPin', { windowId: W, pinId: p2 });
    await sleep(300);
    await send('openPin', { windowId: W, pinId: p1 });
    await sleep(500);
    c = await cfg();
    ok(!c.folders[work].collapsed && !c.folders[reports].collapsed, 'opening a pin expands every folder above it');

    // openFolder: opens the whole subtree, doesn't reset a drifted pin, switches space.
    const p1Tab = Object.entries((await rt()).tabPin).find(([, pid]) => pid === p1)[0];
    await waitLoad(+p1Tab);
    await chrome.tabs.update(+p1Tab, { url: B + '/doc-1/edited' });
    await waitLoad(+p1Tab);
    const outside = await open(W, '/outside');
    await send('pinTab', { tabId: outside.id, spaceId: main });
    const pOut = (await cfg()).spaces[0].pins.at(-1);
    await send('unloadPin', { windowId: W, pinId: pOut });
    await send('switchSpace', { windowId: W, spaceId: other });
    await send('openFolder', { windowId: W, folderId: work });
    await sleep(800);
    r = await rt();
    const bound = new Set(Object.values(r.tabPin));
    ok(bound.has(p1) && bound.has(p2) && !bound.has(pOut), 'Open all tabs opens every pin in the folder tree and nothing else');
    ok((await chrome.tabs.get(+p1Tab)).url === B + '/doc-1/edited', 'Open all tabs keeps a pin you navigated');
    ok(r.activeSpace[W] === main, 'Open all tabs switches to the folder’s space');

    await send('deleteFolder', { folderId: reports });
    c = await cfg();
    ok(!c.folders[reports] && c.folders[deep].parentId === work && c.pins[p2].folderId === work,
      'removing a folder keeps its subfolders and pins, one level up');

    // Panel: counts include subfolders (the test page is this window's sidebar).
    await send('switchSpace', { windowId: panelWindow, spaceId: main });
    await sleep(600);
    const workRow = document.querySelector(`#pins .folder-row[data-id="${work}"]`);
    ok(workRow?.querySelector('.count').textContent === '2', 'folder count includes pins in subfolders: ' + workRow?.querySelector('.count').textContent);

    const tmp = await send('createSpace', { name: 'Temp' });
    const tmpFolder = await send('createFolder', { spaceId: tmp, name: 'Gone' });
    await send('deleteSpace', { spaceId: tmp });
    ok(!(await cfg()).folders[tmpFolder], 'deleting a space deletes its folders');

    // ---------------- Export / import ----------------
    const exported = await send('exportConfig');
    ok(exported.config.folders[deep]?.parentId === work && !('archive' in exported.config), 'export includes folders, not the archive');
    const bad = structuredClone(exported);
    const f = bad.config.folders;
    f.a = { id: 'a', spaceId: main, parentId: 'b', name: 'A' };
    f.b = { id: 'b', spaceId: main, parentId: 'a', name: 'B' };
    f.x = { id: 'x', spaceId: other, parentId: work, name: 'Cross' };
    f.ghost = { id: 'ghost', spaceId: 'nope', parentId: null, name: 'Ghost' };
    f.long = { id: 'long', spaceId: main, parentId: null, name: 'L'.repeat(500) };
    bad.config.pins[p1].folderId = 'x';
    await send('importConfig', { data: bad });
    await sleep(400);
    c = await cfg();
    ok(c.folders.a.parentId === null || c.folders.b.parentId === null, 'import breaks folder cycles');
    ok(c.folders.x.parentId === null, 'import detaches a parent from another space');
    ok(!c.folders.ghost, 'import drops folders of unknown spaces');
    ok(c.pins[p1].folderId === null, 'import clears a pin’s folder from another space');
    ok(c.folders.long.name.length === 100, 'import trims long folder names');
    ok(c.folders[deep].parentId === work && c.pins[p2].folderId === work, 'import keeps valid folders');

    // ---------------- Archive ----------------
    await send('switchSpace', { windowId: W, spaceId: main });
    const a1 = await open(W, '/close-me-1', true);
    const a2 = await open(W, '/close-me-2');
    const before = (await archive()).length;
    await send('closeTabs', { windowId: W, tabIds: [a1.id, a2.id] });
    await sleep(500);
    let arc = await archive();
    ok(arc.length === before + 2 && arc[0].batchId === arc[1].batchId, 'closing two tabs from the sidebar archives one batch');
    ok(!('archive' in (await cfg())), 'the archive is stored apart from the setup');

    const native = await open(W, '/native', true);
    await chrome.tabs.update(native.id, { url: B + '/callback?code=SECRET1&view=x#access_token=SECRET2' });
    await waitLoad(native.id);
    await sleep(300);
    await chrome.tabs.remove(native.id);
    await sleep(600);
    arc = await archive();
    ok(arc[0].url === B + '/callback?view=x', 'a tab closed from Chrome is archived at its last page, tokens stripped: ' + arc[0].url);
    ok(arc[0].spaceId === main, 'the archive remembers the space');

    const count = (await archive()).length;
    const pinnedTab = Object.entries((await rt()).tabPin).find(([, pid]) => pid === p2)?.[0];
    if (pinnedTab) await chrome.tabs.remove(+pinnedTab);
    const ess = await open(W, '/essential');
    await send('pinTab', { tabId: ess.id, spaceId: null });
    await chrome.tabs.remove(ess.id);
    const W2 = (await chrome.windows.create({ url: B + '/window-close' })).id;
    await sleep(800);
    await chrome.windows.remove(W2);
    await sleep(700);
    ok((await archive()).length === count, 'pinned tabs, Essentials and closed windows are not archived');

    // Per-window undo.
    const W3 = (await chrome.windows.create({ url: B + '/w3-keep' })).id;
    await sleep(800);
    const inW3 = await open(W3, '/w3-closed');
    await send('closeTabs', { windowId: W3, tabIds: [inW3.id] });
    const inW = await open(W, '/w-closed', true);
    await send('closeTabs', { windowId: W, tabIds: [inW.id] });
    await sleep(400);
    await send('undoArchive', { windowId: W3 });
    await sleep(600);
    const w3Urls = (await chrome.tabs.query({ windowId: W3 })).map(t => t.pendingUrl || t.url);
    const wUrls = (await chrome.tabs.query({ windowId: W })).map(t => t.pendingUrl || t.url);
    ok(w3Urls.includes(B + '/w3-closed') && !wUrls.includes(B + '/w-closed'), 'undo restores only this window’s last close');

    // Restore into the original space, or the current one if that space is gone.
    const gone = await send('createSpace', { windowId: W, name: 'Gone soon' });
    const g = await open(W, '/in-gone', true);
    await sleep(300);
    await send('closeTabs', { windowId: W, tabIds: [g.id] });
    await send('switchSpace', { windowId: W, spaceId: main });
    await send('deleteSpace', { spaceId: gone });
    const entry = (await archive()).find(e => e.url === B + '/in-gone');
    await send('restoreArchive', { windowId: W, entryIds: [entry.id] });
    await sleep(500);
    const restored = (await chrome.tabs.query({ windowId: W })).find(t => (t.pendingUrl || t.url) === B + '/in-gone');
    ok(restored && (await rt()).tabSpace[restored.id] === main && !(await archive()).some(e => e.id === entry.id),
      'restoring a tab from a deleted space puts it in the current space and removes the entry');

    await send('deleteArchive', { entryIds: [(await archive())[0].id] });
    ok((await archive()).length >= 1, 'one entry can be removed');
    await send('updateSettings', { patch: { archiveClosedTabs: false } });
    const n0 = (await archive()).length;
    await send('closeTabs', { windowId: W, tabIds: [(await open(W, '/not-kept')).id] });
    await sleep(300);
    ok((await archive()).length === n0, 'with the archive turned off, closed tabs are not kept');
    await send('updateSettings', { patch: { archiveClosedTabs: true } });
    await send('clearArchive');
    ok((await archive()).length === 0, 'the archive can be cleared');

    // Sidebar toast: closing from this window's sidebar offers Undo.
    const mine = await open(panelWindow, '/undo-me', false);
    await sleep(300);
    await send('closeTabs', { windowId: panelWindow, tabIds: [mine.id] });
    await sleep(400);
    const undo = document.querySelector('#toast.show button');
    ok(undo?.textContent === 'Undo', 'the sidebar shows an Undo toast after a close');
    undo?.click();
    await sleep(700);
    ok((await chrome.tabs.query({ windowId: panelWindow })).some(t => (t.pendingUrl || t.url) === B + '/undo-me'), 'Undo in the toast reopens the tab');
  } catch (e) {
    log.push('FAIL exception: ' + e.stack);
  }
  return log.join('\n');
})()
