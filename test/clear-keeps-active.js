(async () => {
  const log = [];
  const ok = (pass, message) => log.push(`${pass ? 'PASS' : 'FAIL'} ${message}`);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const send = async (type, args = {}) => {
    const result = await chrome.runtime.sendMessage({ type, ...args });
    if (!result?.ok) throw new Error(result?.error);
    return result.result;
  };
  const cfg = async () => (await chrome.storage.local.get('config')).config;
  const rt = async () => (await chrome.storage.session.get('rt')).rt;
  const wait = async predicate => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await sleep(60); } throw new Error('Timed out waiting for Clear'); };
  try {
    const windowId = (await chrome.windows.getCurrent()).id;
    // Keep the test controller out of the ordinary-tab list.
    await send('pinTab', { tabId: (await chrome.tabs.getCurrent()).id, spaceId: null });
    const spaceId = await send('createSpace', { name: 'Clear regression' });
    const make = async path => {
      const id = await send('newTab', { windowId, spaceId, url: '__BASE__' + path });
      await wait(async () => (await chrome.tabs.get(id)).status === 'complete');
      return id;
    };
    const other = await make('/clear-other');
    const pinned = await make('/clear-pinned');
    await send('pinTab', { tabId: pinned, spaceId });
    const active = await make('/clear-keep');
    const before = await chrome.tabs.query({ windowId });
    await send('clearSpace', { windowId, spaceId });
    let tabs = await chrome.tabs.query({ windowId });
    ok(tabs.some(t => t.id === active && t.active && t.url.endsWith('/clear-keep')), 'Clear keeps the current tab, URL, and selection');
    ok(tabs.some(t => t.id === pinned) && !tabs.some(t => t.id === other), 'Clear preserves pins and archives other ordinary tabs');
    ok(tabs.length === before.length - 1, 'Clear does not create a replacement New Tab');
    let archive = (await cfg()).archive;
    ok(archive.some(e => e.tabId === other) && !archive.some(e => e.tabId === active), 'only the removed tab enters the archive');
    const archiveCount = archive.length;
    await send('clearSpace', { windowId, spaceId });
    tabs = await chrome.tabs.query({ windowId });
    ok(tabs.some(t => t.id === active && t.active) && (await cfg()).archive.length === archiveCount, 'Clear with only the active tab and pins is a no-op');
    const restored = await send('undoArchive', { windowId });
    ok(restored.length === 1 && (await rt()).tabSpace[restored[0]] === spaceId, 'Undo restores the other tab to its space');
    ok(!!(await chrome.tabs.get(active)), 'Undo preserves the tab kept by Clear');
  } catch (error) { log.push('FAIL ' + error.stack); }
  return log.join('\n');
})()
