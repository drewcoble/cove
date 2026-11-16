export async function run({ cdp, sessionId: control, base }) {
  const log = [];
  const ok = (condition, message) => log.push(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ev = async (session, expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const api = expression => ev(control, expression);
  const send = (type, payload = {}) => api(`chrome.runtime.sendMessage(${JSON.stringify({ type, ...payload })}).then(r => { if (!r.ok) throw new Error(r.error); return r.result })`);
  const config = () => api("chrome.storage.local.get('config').then(r => r.config)");
  const wait = async predicate => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await sleep(60); } throw new Error('Timed out waiting for browser/sidebar state'); };
  const row = id => api(`(() => { const row = document.querySelector('#pins [data-id="${id}"]'); if (!row) return null; const r = row.getBoundingClientRect(), container = document.querySelector('#space').getBoundingClientRect(); return { active: row.classList.contains('active'), visible: r.top >= container.top && r.bottom <= container.bottom }; })()`);
  try {
    const { W, controlTab } = await api('Promise.all([chrome.windows.getCurrent(), chrome.tabs.getCurrent()]).then(([w,t]) => ({W:w.id,controlTab:t.id}))');
    const main = (await config()).spaces[0].id;
    ok(await api('!chrome.runtime.getManifest().chrome_url_overrides?.newtab'), 'manifest no longer overrides New Tab');
    const { targetId } = await cdp('Target.createTarget', { url: 'chrome://newtab/' });
    const { sessionId: native } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await wait(() => ev(native, "/^(chrome|helium):/.test(location.href)").catch(() => false));
    ok(await ev(native, "location.protocol !== 'chrome-extension:'"), 'native New Tab loads the browser page, not extension search');
    await api("document.querySelector('#new-tab').click()");
    await wait(() => api(`chrome.tabs.query({windowId:${W},active:true}).then(([t]) => ['chrome://newtab/', 'chrome://new-tab-page/', 'helium://newtab/', 'helium://new-tab-page/'].includes(t?.pendingUrl || t?.url))`));
    ok(true, 'sidebar New Tab button also opens the browser New Tab');
    const nativeTab = await api(`chrome.tabs.query({windowId:${W},active:true}).then(([t]) => t.id)`);
    const fallback = await send('openCommandOverlay', { tabId: nativeTab });
    await wait(() => api(`chrome.tabs.query({windowId:${W},active:true}).then(([t]) => t?.url === chrome.runtime.getURL('src/newtab.html'))`));
    ok(fallback.newTab === true, 'Command+K on native New Tab opens the standalone search fallback');

    await api(`chrome.tabs.update(${controlTab}, {active:true})`);
    const root = await send('createFolder', { spaceId: main, name: 'Projects' });
    const nested = await send('createFolder', { spaceId: main, parentId: root, name: 'Reviews' });
    const unrelated = await send('createFolder', { spaceId: main, name: 'Unrelated' });
    const tabId = await api(`chrome.tabs.create({windowId:${W},url:${JSON.stringify(base + '/folder-pin')},active:false}).then(t => t.id)`);
    await wait(() => api(`chrome.tabs.get(${tabId}).then(t => t.status === 'complete')`));
    await send('pinTab', { tabId, spaceId: main, folderId: nested });
    const pinId = await api(`chrome.storage.session.get('rt').then(r => r.rt.tabPin[${tabId}])`);
    for (const folderId of [root, nested, unrelated]) await send('updateFolder', { folderId, collapsed: true });
    await wait(async () => !(await row(pinId)));
    await api(`chrome.tabs.update(${tabId}, {active:true})`);
    await wait(async () => {
      const c = await config(); const r = await row(pinId);
      return !c.folders[root].collapsed && !c.folders[nested].collapsed && r?.active && r.visible;
    });
    ok(true, 'activating a pin expands every ancestor, highlights it, and scrolls it into view');
    ok((await config()).folders[unrelated].collapsed, 'unrelated folders stay collapsed');
    await send('updateFolder', { folderId: root, collapsed: true });
    await wait(async () => !(await row(pinId)));
    ok((await config()).folders[root].collapsed, 'manual collapse remains possible while viewing its tab');
    await send('openPin', { windowId: W, pinId, reset: false });
    await wait(async () => (await row(pinId))?.active);
    ok(!(await config()).folders[root].collapsed, 'selecting the already-active pin reveals its folder again');
    await send('updateFolder', { folderId: root, collapsed: true });
    await send('updateFolder', { folderId: nested, collapsed: true });
    await send('unloadPin', { windowId: W, pinId });
    await send('openPin', { windowId: W, pinId });
    await wait(async () => (await row(pinId))?.active);
    ok(!(await config()).folders[root].collapsed && !(await config()).folders[nested].collapsed, 'reopening an unloaded pin reveals nested ancestors');
    await send('updateFolder', { folderId: root, collapsed: true });
    const live = await api(`chrome.storage.session.get('rt').then(r => Number(Object.entries(r.rt.tabPin).find(([,id]) => id === ${JSON.stringify(pinId)})[0]))`);
    await api(`chrome.tabs.update(${live}, {url:${JSON.stringify(base + '/folder-pin/navigated')}})`);
    await wait(async () => !(await config()).folders[root].collapsed && !!(await row(pinId)));
    ok(true, 'navigation within an active pin reveals its folder');
    // Reconciliation after a browser/extension restart must reveal the selected pin too.
    await send('updateFolder', { folderId: root, collapsed: true });
    await send('updateFolder', { folderId: nested, collapsed: true });
    await api(`chrome.storage.local.set({__folderRevealExpect:${JSON.stringify({ root, nested, unrelated, pinId })}})`);
  } catch (error) { log.push('FAIL ' + error.stack); }
  return log.join('\n');
}
