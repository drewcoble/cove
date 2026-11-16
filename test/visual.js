(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = (type, p = {}) => chrome.runtime.sendMessage({ type, ...p });
  const B = '__BASE__';
  const W = (await chrome.windows.getCurrent()).id;
  const mk = async (path, active = false) => { const t = await chrome.tabs.create({ windowId: W, url: B + path, active }); await sleep(250); return t; };
  await sleep(500);
  const c = (await chrome.storage.local.get('config')).config;
  await send('updateSpace', { spaceId: c.spaces[0].id, name: 'Main', icon: '' });
  for (const p of ['/gmail', '/calendar', '/slack', '/github', '/devops']) { const t = await mk(p); await sleep(300); await send('pinTab', { tabId: t.id, spaceId: null }); }
  const pr = await mk('/prs'); await sleep(300);
  await send('pinTab', { tabId: pr.id, spaceId: c.spaces[0].id });
  const pid = (await chrome.storage.local.get('config')).config.spaces[0].pins[0];
  await send('renamePin', { pinId: pid, title: 'Team PRs' });
  await chrome.tabs.update(pr.id, { url: B + '/prs/12345' });
  const lucide = await mk('/lucide'); await sleep(300);
  await send('pinTab', { tabId: lucide.id, spaceId: c.spaces[0].id });
  const reports = (await send('createFolder', { spaceId: c.spaces[0].id, name: 'Reports' })).result;
  const q3 = (await send('createFolder', { spaceId: c.spaces[0].id, name: 'Q3', parentId: reports })).result;
  for (const [path, folderId] of [['/weekly', reports], ['/q3-board', q3], ['/q3-budget', q3]]) {
    const t = await mk(path);
    await sleep(300);
    await send('pinTab', { tabId: t.id, spaceId: c.spaces[0].id, folderId });
  }
  await send('createFolder', { spaceId: c.spaces[0].id, name: 'Reading list' });
  await mk('/search?q=best+lightweight+llm+local+coding');
  const wiki = await mk('/Wikipedia');
  const article = await chrome.tabs.create({ windowId: W, url: B + '/Article', openerTabId: wiki.id, active: false });
  await sleep(300);
  await chrome.tabs.create({ windowId: W, url: B + '/Related-article', openerTabId: article.id, active: false });
  await mk('/docs', true);
  await send('createSpace', { name: 'local', icon: '🧪', color: 'cyan' });
  await send('createSpace', { name: 'dev', icon: '', color: 'purple' });
  await sleep(1500);
  return 'ok';
})()
