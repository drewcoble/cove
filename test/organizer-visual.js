(async () => {
  const send = async (type, payload) => {
    const r = await chrome.runtime.sendMessage({ type, ...payload });
    if (!r.ok) throw new Error(r.error);
    return r.result;
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const W = (await chrome.windows.getCurrent()).id;
  const { config } = await chrome.storage.local.get('config');
  const spaceId = config.spaces[0].id;
  await send('updateSpace', { spaceId, name: 'Work', color: 'purple' });
  const folderId = await send('createFolder', { spaceId, name: 'Projects' });
  const child = await send('createFolder', { spaceId, name: 'Code reviews', parentId: folderId });
  for (const [path, name, folder] of [['/docs', 'Documentation', folderId], ['/reviews', 'Review dashboard', child], ['/design', 'Design system', null]]) {
    const tab = await chrome.tabs.create({ windowId: W, url: '__BASE__' + path, active: false });
    await sleep(150);
    await send('pinTab', { tabId: tab.id, spaceId, folderId: folder });
    const { rt } = await chrome.storage.session.get('rt');
    await send('renamePin', { pinId: rt.tabPin[tab.id], title: name });
  }
  for (const path of ['/release-checklist', '/api-reference', '/research-notes']) {
    const tab = await chrome.tabs.create({ windowId: W, url: '__BASE__' + path, active: false });
    await sleep(150);
    await send('closeTabs', { windowId: W, tabIds: [tab.id] });
  }
  await send('createSpace', { name: 'Personal', color: 'green' });
  await sleep(250);
  return 'PASS populated folder and archive visual fixtures';
})()
