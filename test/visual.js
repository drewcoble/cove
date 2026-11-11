(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = (type, p = {}) => chrome.runtime.sendMessage({ type, ...p });
  const B = '__BASE__';
  const W = (await chrome.windows.getCurrent()).id;
  const mk = async (path, active = false) => { const t = await chrome.tabs.create({ windowId: W, url: B + path, active }); await sleep(250); return t; };
  await sleep(500);
  const c = (await chrome.storage.local.get('config')).config;
  await send('updateSpace', { spaceId: c.spaces[0].id, name: 'Main', icon: '' });
  for (const p of ['/gmail', '/calendar', '/slack', '/github', '/devops', '/docs-e']) { const t = await mk(p); await sleep(300); await send('pinTab', { tabId: t.id, spaceId: null }); }
  const pr = await mk('/prs'); await sleep(300);
  await send('pinTab', { tabId: pr.id, spaceId: c.spaces[0].id });
  const pid = (await chrome.storage.local.get('config')).config.spaces[0].pins[0];
  await send('renamePin', { pinId: pid, title: 'Team PRs' });
  await chrome.tabs.update(pr.id, { url: B + '/prs/12345' });
  const lucide = await mk('/lucide'); await sleep(300);
  await send('pinTab', { tabId: lucide.id, spaceId: c.spaces[0].id });
  await mk('/search?q=best+lightweight+llm+local+coding');
  await mk('/docs', true);
  await send('createSpace', { name: 'local', icon: '🧪', color: 'cyan' });
  await send('createSpace', { name: 'dev', icon: '', color: 'purple' });
  await sleep(1500);
  return 'ok';
})()
