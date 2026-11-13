export async function run({ cdp, sessionId: control, base, extId }) {
  const log = [];
  const ok = (condition, message) => { log.push(`${condition ? 'PASS' : 'FAIL'} ${message}`); if (process.env.TRACE) console.log(log.at(-1)); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function evaluate(session, expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  const api = expression => evaluate(control, expression);
  const send = (type, payload = {}) => api(`chrome.runtime.sendMessage(${JSON.stringify({ type, ...payload })}).then(r => { if (!r.ok) throw new Error(r.error); return r.result; })`);
  const config = () => api("chrome.storage.local.get('config').then(r => r.config)");
  const runtime = () => api("chrome.storage.session.get('rt').then(r => r.rt)");
  const tab = id => api(`chrome.tabs.get(${id}).catch(() => null)`);
  const wait = async predicate => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await sleep(60); }
    throw new Error('Timed out waiting for overlay/browser state');
  };
  async function attach(path) {
    const { targetInfos } = await cdp('Target.getTargets');
    const target = targetInfos.find(t => t.type === 'page' && t.url.includes(path));
    if (!target) throw new Error('Missing target: ' + path);
    return (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  }
  async function panel(session, code) {
    const { root } = await cdp('DOM.getDocument', { depth: -1, pierce: true }, session);
    const find = node => {
      if (node.nodeName === 'COVE-COMMAND') return node;
      for (const child of node.children || []) { const match = find(child); if (match) return match; }
    };
    const host = find(root);
    if (!host?.shadowRoots?.[0]) return null;
    const { object } = await cdp('DOM.resolveNode', { nodeId: host.shadowRoots[0].nodeId }, session);
    const result = await cdp('Runtime.callFunctionOn', {
      objectId: object.objectId, functionDeclaration: `function() { const root = this; ${code} }`, returnByValue: true, awaitPromise: true,
    }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  const search = (session, text) => panel(session, `const input = root.querySelector('#search'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return root.querySelectorAll('[role=option]').length;`);
  async function key(session, value, modifiers = 0) {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value.length === 1 ? 'Key' + value.toUpperCase() : value, modifiers, windowsVirtualKeyCode: value === 'Enter' ? 13 : value === 'Escape' ? 27 : value.toUpperCase().charCodeAt(0) }, session);
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value.length === 1 ? 'Key' + value.toUpperCase() : value, modifiers }, session).catch(() => {});
  }
  const open = async (id, session) => {
    await send('openCommandOverlay', { tabId: id });
    await wait(() => panel(session, "return !!root.querySelector('[role=option]');").catch(() => false));
  };
  const closed = session => wait(() => evaluate(session, "!document.querySelector('cove-command')"));
  try {
    const main = (await config()).spaces[0].id;
    const W = await api('chrome.windows.getCurrent().then(w => w.id)');
    const sourceId = await send('newTab', { windowId: W, spaceId: main, url: base + '/regression-source' });
    await wait(async () => (await tab(sourceId))?.status === 'complete');
    await send('pinTab', { tabId: sourceId, spaceId: null });
    const source = await attach('/regression-source');
    const parent = await send('createFolder', { spaceId: main, name: 'Apps' });
    const folder = await send('createFolder', { spaceId: main, parentId: parent, name: 'Views' });
    const makePin = async (route, title) => {
      const id = await send('newTab', { windowId: W, spaceId: main, url: base + '/app#/' + route });
      await wait(async () => (await tab(id))?.status === 'complete');
      await send('pinTab', { tabId: id, spaceId: main, folderId: folder });
      const pinId = (await runtime()).tabPin[id];
      await send('renamePin', { pinId, title });
      return { id, pinId };
    };
    await makePin('dashboard', 'Dashboard');
    const reports = await makePin('reports', 'Reports');
    // Same URL but a distinct saved pin must also remain individually searchable.
    const secondReports = await makePin('reports', 'Financial review');
    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await send('updateFolder', { folderId: folder, collapsed: true });
    await send('updateFolder', { folderId: parent, collapsed: true });
    await open(sourceId, source);
    await search(source, 'Reports');
    ok(await panel(source, `return root.querySelector('[role=option]').dataset.key === ${JSON.stringify('pin-' + reports.pinId)}`), 'hash-route pin remains searchable inside nested collapsed folders');
    await key(source, 'Enter'); await closed(source);
    await wait(async () => (await tab(reports.id)).active);
    ok((await tab(reports.id)).url.endsWith('#/reports'), 'search activates the correct hash-route pin');
    const cfg = await config();
    ok(!cfg.folders[parent].collapsed && !cfg.folders[folder].collapsed, 'hash-route pin activation reveals both folder ancestors');
    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    await search(source, 'Financial review');
    ok(await panel(source, `return root.querySelector('[role=option]').dataset.key === ${JSON.stringify('pin-' + secondReports.pinId)}`), 'distinct same-URL pins retain their own search results');
    await key(source, 'Enter'); await closed(source);
    await wait(async () => (await tab(secondReports.id)).active);
    ok(true, 'same-URL search activates the requested saved pin');

    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    await search(source, 'Page /app');
    ok(await panel(source, `return !!root.querySelector('[data-key="pin-${reports.pinId}"]')`), 'renamed hash-route pins remain searchable by their history page title');
    await key(source, 'Escape'); await key(source, 'Escape'); await closed(source);
    const empty = await send('createSpace', { name: 'Empty regression space' });
    await send('switchSpace', { windowId: W, spaceId: empty });
    const blank = await api(`chrome.tabs.query({ windowId: ${W}, active: true }).then(t => t[0])`);
    ok((await runtime()).tabSpace[blank.id] === empty && /newtab/.test(blank.pendingUrl || blank.url), 'sidebar switch to an empty space activates its own native New Tab');
    await send('switchSpace', { windowId: W, spaceId: main });
    await send('switchSpace', { windowId: W, spaceId: empty });
    ok(await api(`chrome.tabs.query({ windowId: ${W}, active: true }).then(t => t[0].id)`) === blank.id, 'switching back to the empty space reuses its New Tab');
    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    ok(await panel(source, "return root.querySelector('#space').textContent === 'Empty regression space'"), 'search opened from an Essential uses the selected empty space');
    await search(source, 'Reports');
    ok(await panel(source, "return ![...root.querySelectorAll('[role=option]')].some(n => n.dataset.key.startsWith('pin-'))"), 'empty-space suggestions exclude pins belonging to the previous space');
    const dummy = base + '/dummy-callback?code=dummy-sensitive-code&view=inbox#access_token=dummy-sensitive-token';
    await search(source, dummy);
    await key(source, 'Enter'); await closed(source);
    let created;
    await wait(async () => { created = await api(`chrome.tabs.query({ windowId: ${W}, active: true }).then(t => t[0])`); return (created.pendingUrl || created.url).includes('/dummy-callback'); });
    ok((await runtime()).tabSpace[created.id] === empty, 'a search destination opens in the selected space');
    const memory = await api("chrome.storage.local.get('searchMemory').then(r => r.searchMemory)");
    ok(!JSON.stringify(memory).includes('dummy-sensitive-') && JSON.stringify(memory).includes('view=inbox'), 'saved ranking preferences remove sensitive URL parameters and fragments but keep harmless ones');

    // Seed the previous format to verify startup cleans data already written by older builds.
    await api(`chrome.storage.local.set({ searchMemory: { searches: [{ text: ${JSON.stringify(dummy)}, count: 2 }], selections: [{ query: ${JSON.stringify(dummy)}, key: 'search-' + ${JSON.stringify(dummy)}, count: 2 }] } })`);
    await cdp('Extensions.loadUnpacked', { path: new URL('../', import.meta.url).pathname });
    const { targetId } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/src/sidepanel.html` });
    control = (await cdp('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    await wait(async () => { try { return await api("chrome.storage.local.get('searchMemory').then(r => r.searchMemory && !JSON.stringify(r.searchMemory).includes('dummy-sensitive-'))"); } catch { return false; } });
    ok(true, 'extension reload migrates existing search memory to remove stored URL tokens');
  } catch (error) { log.push('FAIL exception: ' + error.stack); }
  return log.join('\n');
}
