// Migration, part 1: build a setup, export it, then wipe storage so the reload that follows
// looks like a brand-new install (e.g. after renaming the extension folder).
(async () => {
  const log = [];
  const ok = (cond, msg) => log.push((cond ? 'PASS ' : 'FAIL ') + msg);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = async (type, p = {}) => {
    const r = await chrome.runtime.sendMessage({ type, ...p });
    if (!r.ok) throw new Error(type + ': ' + r.error);
    return r.result;
  };
  const cfg = async () => (await chrome.storage.local.get('config')).config;
  const B = '__BASE__';
  const open = async (W, path) => {
    const t = await chrome.tabs.create({ windowId: W, url: B + path, active: false });
    await sleep(500);
    return t;
  };
  let payload = null;
  try {
    await sleep(600);
    const W = (await chrome.windows.create({ url: B + '/start', focused: true })).id;
    await sleep(800);
    const main = (await cfg()).spaces[0].id;
    await send('updateSpace', { spaceId: main, name: 'Work', icon: '💼', color: 'green' });
    const prs = await open(W, '/prs');
    await send('pinTab', { tabId: prs.id, spaceId: main });
    const prsPin = (await cfg()).spaces[0].pins[0];
    await send('renamePin', { pinId: prsPin, title: 'Team PRs' });
    const folder = await send('createFolder', { spaceId: main, name: 'Projects' });
    const child = await send('createFolder', { spaceId: main, parentId: folder, name: 'Reviews' });
    await send('movePin', { pinId: prsPin, spaceId: main, folderId: child });
    await chrome.tabs.update(prs.id, { url: B + '/prs/123' }); // drifted
    const mail = await open(W, '/mail');
    await send('pinTab', { tabId: mail.id, spaceId: null });
    await send('renamePin', { pinId: (await cfg()).essentials[0], title: 'Inbox' });
    const cal = await open(W, '/calendar');
    await send('pinTab', { tabId: cal.id, spaceId: null });
    const personal = await send('createSpace', { windowId: W, name: 'Personal', color: 'pink' });
    const news = await open(W, '/news');
    await send('pinTab', { tabId: news.id, spaceId: personal });
    await send('updateSettings', { patch: { collapseInactive: false, peekInSplitView: true } });
    await sleep(800);

    payload = await send('exportConfig');
    ok(payload.format === 'cove-setup' && payload.config.spaces.length === 2 && payload.config.essentials.length === 2,
      'export contains 2 spaces and 2 Essentials');
    ok(Object.keys(payload.config.folders).length === 2 && payload.config.pins[prsPin].folderId === child, 'export includes nested folders and pin membership');
    ok(JSON.stringify(payload).length < 50000, 'export is small: ' + JSON.stringify(payload).length + ' bytes');
    await chrome.storage.local.clear();
  } catch (e) {
    log.push('FAIL exception: ' + e.stack);
  }
  return JSON.stringify({ log: log.join('\n'), payload });
})()
