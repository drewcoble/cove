(async () => {
  const log = [];
  const ok = (condition, message) => { log.push(`${condition ? 'PASS' : 'FAIL'} ${message}`); console.log(log.at(-1)); };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = async (type, payload = {}) => {
    const result = await chrome.runtime.sendMessage({ type, ...payload });
    if (!result?.ok) throw new Error(type + ': ' + result?.error);
    return result.result;
  };
  const cfg = async () => (await chrome.storage.local.get('config')).config;
  const rt = async () => (await chrome.storage.session.get('rt')).rt;
  const W = (await chrome.windows.getCurrent()).id;
  const B = '__BASE__';
  const wait = async predicate => {
    for (let i = 0; i < 60; i++) { if (await predicate()) return; await sleep(50); }
    throw new Error('Timed out waiting for UI or Chrome state');
  };
  const mk = async path => {
    const tab = await chrome.tabs.create({ windowId: W, url: B + path, active: false });
    await wait(async () => (await chrome.tabs.get(tab.id)).status === 'complete');
    await wait(async () => !!(await rt()).tabSpace[tab.id]);
    return tab;
  };
  const closeDialog = () => document.querySelector('#organizer-dialog').close();
  const search = value => {
    const input = document.querySelector('#organizer-search');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const key = value => document.querySelector('#organizer-search').dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  try {
    await sleep(500);
    // Keep the harness page open while Clear operates on this window's normal tabs.
    await send('pinTab', { tabId: (await chrome.tabs.getCurrent()).id, spaceId: null });
    const main = (await cfg()).spaces[0].id;
    ok((await cfg()).version === 2, 'version 2 schema initialized');
    const folder = await send('createFolder', { spaceId: main, name: 'Projects' });
    const nested = await send('createFolder', { spaceId: main, name: 'Reviews', parentId: folder });
    const pinTab = await mk('/pinned-review');
    await send('pinTab', { tabId: pinTab.id, spaceId: main, folderId: nested });
    const pinId = (await rt()).tabPin[pinTab.id];
    await send('renamePin', { pinId, title: 'Review dashboard' });
    await wait(() => !!document.querySelector(`[data-kind=pin][data-id="${pinId}"]`));
    ok((await cfg()).pins[pinId].folderId === nested, 'pin saved inside nested folder');
    ok(!!document.querySelector(`[data-kind=pin][data-id="${pinId}"]`), 'nested pin rendered');
    await send('updateFolder', { folderId: folder, collapsed: true });
    await wait(() => !document.querySelector(`[data-folder="${nested}"]`) && !document.querySelector(`[data-kind=pin][data-id="${pinId}"]`));
    ok(!document.querySelector(`[data-folder="${nested}"]`), 'collapsing folder hides descendants');
    await send('updateFolder', { folderId: folder, collapsed: false });
    const invalid = await chrome.runtime.sendMessage({ type: 'updateFolder', folderId: folder, parentId: nested });
    ok(invalid.ok === false, 'cycle rejected without corrupting hierarchy');
    const other = await send('createSpace', { name: 'Personal' });
    const mismatch = await chrome.runtime.sendMessage({ type: 'movePin', pinId, spaceId: other, folderId: nested });
    ok(mismatch.ok === false && (await cfg()).pins[pinId].spaceId === main, 'cross-space folder rejected before mutation');
    await send('movePin', { pinId, spaceId: other });
    ok((await cfg()).pins[pinId].folderId === null, 'moving to another space clears folder membership');
    await send('movePin', { pinId, spaceId: main, folderId: nested });
    await send('deleteFolder', { folderId: folder });
    ok((await cfg()).folders[nested].parentId === null && !!(await cfg()).pins[pinId], 'removing parent preserves child folder and pin');
    await send('updateFolder', { folderId: nested, name: 'Code reviews' });
    await send('switchSpace', { windowId: W, spaceId: main });
    await wait(() => !!document.querySelector(`[data-folder="${nested}"]`));
    // Drop a normal tab on a folder using the real DOM handlers.
    const drop = await mk('/drag-into-folder');
    await wait(() => !!document.querySelector(`[data-kind=tab][data-id="${drop.id}"]`));
    const transfer = new DataTransfer();
    document.querySelector(`[data-kind=tab][data-id="${drop.id}"]`).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    document.querySelector(`[data-folder="${nested}"]`).dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    await wait(async () => !!(await rt()).tabPin[drop.id]);
    ok((await cfg()).pins[(await rt()).tabPin[drop.id]].folderId === nested, 'dragging a tab onto a folder pins it there');
    // Command search finds custom names even inside collapsed folders.
    await send('updateFolder', { folderId: nested, collapsed: true });
    document.querySelector('#command-launch').click();
    search('Review dashboard');
    ok(document.querySelector('#organizer-results').textContent.includes('Review dashboard'), 'command bar finds custom pin title in collapsed folder');
    key('Enter');
    await wait(async () => (await chrome.tabs.get(pinTab.id)).active);
    ok(!document.querySelector('#organizer-dialog').open, 'Enter activates result and dismisses command bar');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    ok(document.querySelector('#organizer-dialog').open, 'Ctrl+K opens command bar from sidebar');
    search(B + '/new-command-tab');
    key('ArrowUp'); key('Enter');
    await sleep(300);
    ok(!document.querySelector('#organizer-dialog').open, 'keyboard selects URL fallback');
    // Close/undo preserves batch semantics and protects pins.
    const a = await mk('/archive-a');
    const b = await mk('/archive-b');
    await chrome.tabs.update(a.id, { active: true });
    await send('closeTabs', { windowId: W, tabIds: [a.id, b.id] });
    let archive = (await cfg()).archive;
    const batch = archive.filter(e => e.url === B + '/archive-a' || e.url === B + '/archive-b');
    ok(batch.length === 2 && batch[0].batchId === batch[1].batchId, 'one close operation archives a single batch');
    const restored = await send('undoArchive', { windowId: W });
    ok(restored.length === 2, 'undo restores whole batch');
    const restoredRt = await rt();
    ok(restored.every(id => restoredRt.tabSpace[id] === main), 'undo restores original space');
    ok(!(await cfg()).archive.some(e => batch.some(b => b.id === e.id)), 'successful restore consumes entries');
    const beforeUnload = (await cfg()).archive.length;
    await send('unloadPin', { windowId: W, pinId });
    ok((await cfg()).archive.length === beforeUnload && !!(await cfg()).pins[pinId], 'unloading pin does not archive or delete it');
    await send('openPin', { windowId: W, pinId });
    const native = await mk('/native-close');
    await chrome.tabs.remove(native.id);
    await wait(async () => (await cfg()).archive.some(e => e.url === B + '/native-close'));
    ok(true, 'Chrome tab-strip close archives last-known URL');
    // Clear skips pins; restoring from the archive UI works with its search filter.
    await send('clearSpace', { windowId: W, spaceId: main });
    archive = (await cfg()).archive;
    ok(archive.some(e => e.url === B + '/archive-a') && !archive.some(e => e.url === B + '/pinned-review'), 'Clear archives normal tabs and preserves pins');
    document.querySelector('#archive-launch').click();
    search('/native-close');
    ok(document.querySelectorAll('#organizer-results [role=option]').length === 1, 'archive searches closed URLs');
    key('Enter');
    await wait(async () => !(await cfg()).archive.some(e => e.url === B + '/native-close'));
    await wait(() => !document.querySelector('#organizer-results').textContent.includes(B + '/native-close'));
    ok(document.querySelector('#organizer-dialog').open, 'archive stays open after restoring a result');
    closeDialog();
    // Failed restores leave recovery data intact.
    const retained = (await cfg()).archive[0];
    const failedRestore = await chrome.runtime.sendMessage({ type: 'restoreArchive', windowId: 2147483647, entryIds: [retained.id] });
    ok(!failedRestore.ok && (await cfg()).archive.some(e => e.id === retained.id), 'failed restore retains the archive entry');
    // Duplicate restore requests consume a given entry only once.
    const entry = (await cfg()).archive[0];
    const twice = await send('restoreArchive', { windowId: W, entryIds: [entry.id, entry.id] });
    ok(twice.length === 1, 'duplicate IDs cannot restore the same archive entry twice');
    const ghost = await send('createSpace', { name: 'Temporary' });
    await send('switchSpace', { windowId: W, spaceId: ghost });
    const ghostTab = await mk('/deleted-space');
    await send('closeTabs', { windowId: W, tabIds: [ghostTab.id] });
    const ghostEntry = (await cfg()).archive.find(e => e.url === B + '/deleted-space');
    await send('deleteSpace', { spaceId: ghost });
    const fallback = await send('restoreArchive', { windowId: W, entryIds: [ghostEntry.id] });
    ok(fallback.length === 1 && !!(await rt()).tabSpace[fallback[0]], 'deleted-space archive restores to a surviving space');
    await chrome.storage.local.set({ __organizerExpect: { folderId: nested, pinId, archiveIds: (await cfg()).archive.map(e => e.id) } });
  } catch (e) { log.push('FAIL exception: ' + e.stack); }
  return log.join('\n');
})()
