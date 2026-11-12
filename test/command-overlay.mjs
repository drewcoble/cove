import fs from 'node:fs';

export async function run({ cdp, sessionId: control, base }) {
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
    const sourceId = await send('newTab', { windowId: W, spaceId: main, url: base + '/overlay-source' });
    await wait(async () => (await tab(sourceId))?.status === 'complete');
    const source = await attach('/overlay-source');
    await cdp('Runtime.enable', {}, source);
    await evaluate(source, "document.body.innerHTML = '<input id=editor value=Draft><h1>My working page</h1><p>This page stays behind the command bar.</p>'; document.querySelector('#editor').focus()");
    const initialCount = await api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.length)`);
    // Untrusted key events from a site cannot open extension UI.
    await evaluate(source, "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))");
    await sleep(100);
    ok(await evaluate(source, "!document.querySelector('cove-command')"), 'synthetic page shortcuts cannot open the command overlay');
    // CDP sends a trusted keyboard event through Chrome's renderer input path.
    await key(source, 'k', 4); // Meta / Command on macOS
    await wait(() => panel(source, "return !!root.querySelector('[role=option]');").catch(() => false));
    ok(true, 'trusted Command+K opens a floating panel on the current page');
    ok((await tab(sourceId)).url.endsWith('/overlay-source') && await api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.length)`) === initialCount,
      'opening the overlay leaves the source URL and tab count unchanged');
    ok(await evaluate(source, "document.querySelector('cove-command').shadowRoot === null"), 'overlay styles and controls are isolated in a closed shadow root');
    ok(await panel(source, "return root.activeElement === root.querySelector('#search')"), 'search receives keyboard focus');
    await key(source, 'k', 4);
    ok(await evaluate(source, "document.querySelectorAll('cove-command').length === 1"), 'repeated Command+K focuses one overlay without duplicating it');
    await evaluate(source, "window.__typed = []; window.addEventListener('input', e => window.__typed.push(e.data), true)");
    await cdp('Input.insertText', { text: 'local query' }, source);
    ok(await panel(source, "return root.querySelector('#search').value === 'local query'"), 'trusted typing updates the floating search');
    ok(await evaluate(source, "window.__typed.length === 0"), 'overlay typing does not reach the page input handlers');
    await panel(source, "root.querySelector('#clear').click(); return true");
    await evaluate(source, "const overlayHost = document.querySelector('cove-command'); for (const key of ['Escape','Enter']) overlayHost.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles:true, composed:true }));");
    await sleep(80);
    ok(await evaluate(source, "!!document.querySelector('cove-command')") && (await tab(sourceId)).active, 'host page cannot activate or close the overlay with synthetic keys');
    const denied = await api(`chrome.scripting.executeScript({ target: { tabId: ${sourceId} }, func: () => chrome.runtime.sendMessage({ type: 'commandAction', token: 'forged', kind: 'navigate', text: 'example.com' }) }).then(r => r[0].result)`);
    ok(denied.ok === false, 'overlay actions reject a forged capability token');
    await key(source, 'Escape');
    await closed(source);
    ok(await evaluate(source, "document.activeElement.id === 'editor' && document.querySelector('#editor').value === 'Draft'"), 'Escape dismisses the overlay and restores editor focus and draft');

    const targetId = await send('newTab', { windowId: W, spaceId: main, url: base + '/open-target' });
    await wait(async () => (await tab(targetId))?.status === 'complete');
    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    await search(source, 'open-target');
    ok(await panel(source, "return ![...root.querySelectorAll('.result-kind')].some(node => node.textContent === 'Switch to tab') && root.querySelectorAll('.result-kind')[1].textContent === 'Search web'"), 'ordinary tabs are excluded and search stays second');
    const first = await panel(source, "return root.querySelector('[role=option]').getAttribute('aria-selected')");
    await key(source, 'ArrowDown');
    ok(first === 'true' && await panel(source, "return root.querySelectorAll('[role=option]')[1].getAttribute('aria-selected') === 'true'"), 'arrow keys change the selected result');
    await key(source, 'ArrowUp');
    await key(source, 'Enter');
    await wait(() => api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.filter(t => (t.pendingUrl || t.url) === ${JSON.stringify(base + '/open-target')}).length === 2)`));
    await closed(source);
    ok(!!(await tab(sourceId)) && (await tab(sourceId)).url.endsWith('/overlay-source'), 'history opens a destination without switching to an ordinary open tab');

    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    await search(source, base + '/from-floating-search');
    await key(source, 'Enter');
    await wait(() => api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.some(t => (t.pendingUrl || t.url) === ${JSON.stringify(base + '/from-floating-search')}))`));
    await closed(source);
    ok((await tab(sourceId)).url.endsWith('/overlay-source'), 'URL entry opens a new tab and keeps the current page');
    const created = await api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.find(t => t.url === ${JSON.stringify(base + '/from-floating-search')}))`);
    ok((await runtime()).tabSpace[created.id] === main, 'new URL opens in the current space');

    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    await search(source, 'floating search query 67291');
    await key(source, 'Enter');
    await wait(() => api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.some(t => /67291/.test(t.pendingUrl || t.url)))`));
    await closed(source);
    ok((await tab(sourceId)).url.endsWith('/overlay-source'), 'web search opens separately without navigating the source');
    const savedSearches = await api("chrome.storage.local.get('searchMemory').then(r => r.searchMemory.searches)");
    ok(savedSearches.some(entry => entry.text === 'floating search query 67291'), 'submitted searches are saved locally');
    await api(`chrome.history.addUrl({ url: ${JSON.stringify(base + '/frequent-destination')} })`);
    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    await search(source, 'frequent-destination');
    ok(await panel(source, "return root.querySelector('[role=option] .result-kind').textContent === 'History'"), 'closed history destinations appear in floating search');
    await wait(() => panel(source, "const img = root.querySelector('[role=option] .result-icon img'); return img?.complete && img.naturalWidth > 0"));
    ok(await panel(source, "return root.querySelectorAll('[role=option]')[1].querySelector('.search-result-icon svg') && !root.querySelectorAll('[role=option]')[1].querySelector('img')"), 'history uses browser-cached favicons while search has a magnifying glass');
    await key(source, 'Enter');
    await wait(() => api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.some(t => (t.pendingUrl || t.url) === ${JSON.stringify(base + '/frequent-destination')}))`));
    await closed(source);
    const historyTab = await api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.find(t => (t.pendingUrl || t.url) === ${JSON.stringify(base + '/frequent-destination')}))`);
    ok((await runtime()).tabSpace[historyTab.id] === main, 'history destinations open in the current space');
    const learned = await api("chrome.storage.local.get('searchMemory').then(r => r.searchMemory.selections)");
    ok(learned.some(entry => entry.query === 'frequent-destination'), 'chosen destinations are learned locally for the typed query');
    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    await search(source, 'floating search query');
    ok(await panel(source, "return [...root.querySelectorAll('.result-kind')].some(node => node.textContent === 'Recent search') && root.querySelectorAll('.result-kind')[1].textContent === 'Search web'"), 'recent searches remain available with explicit web search second');
    await key(source, 'Escape'); await key(source, 'Escape'); await closed(source);


    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    await search(source, '> New folder');
    await key(source, 'Enter');
    await wait(() => panel(source, "return !root.querySelector('#folder-view').hidden"));
    await panel(source, "root.querySelector('#folder-name').value = 'Floating projects'; root.querySelector('#folder-view').requestSubmit(); return true;");
    await wait(async () => Object.values((await config()).folders).some(f => f.name === 'Floating projects'));
    ok(true, 'New folder command works within the floating panel');
    await wait(() => panel(source, "return root.querySelector('#folder-view').hidden"));
    await search(source, 'discard this query');
    await key(source, 'Escape');
    ok(await panel(source, "return root.querySelector('#search').value === '' && root.querySelector('dialog').open"), 'first Escape clears the query without dismissing');
    await key(source, 'Escape'); await closed(source);

    await open(sourceId, source);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 }, source);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 }, source);
    await closed(source);
    ok(true, 'clicking outside dismisses the floating panel');

    for (let i = 0; i < 8; i++) await api(`chrome.history.addUrl({ url: ${JSON.stringify(base)} + '/scroll-result-' + ${i} })`);
    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    await search(source, 'scroll-result');
    ok(await panel(source, "const list = root.querySelector('#results'); return list.children.length > 4 && list.clientHeight === 240 && list.scrollHeight > list.clientHeight"), 'four visible rows retain additional scrollable results');
    const rect = await panel(source, "const r = root.querySelector('#results').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }");
    await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: rect.x, y: rect.y, deltaX: 0, deltaY: 180 }, source);
    await wait(() => panel(source, "return root.querySelector('#results').scrollTop > 0"));
    ok(true, 'mouse wheel scrolls the result list');
    await search(source, 'scroll-result');
    for (let i = 0; i < 5; i++) await key(source, 'ArrowDown');
    ok(await panel(source, "return root.querySelector('#results').scrollTop > 0 && root.querySelector('[aria-selected=true]').getBoundingClientRect().bottom <= root.querySelector('#results').getBoundingClientRect().bottom + 1"), 'keyboard selection scrolls hidden results into view');
    await key(source, 'Escape'); await key(source, 'Escape'); await closed(source);

    const research = await send('createSpace', { name: 'Research', color: 'green' });
    const pinTab = await send('newTab', { windowId: W, spaceId: research, url: base + '/research-pin' });
    await wait(async () => (await tab(pinTab))?.status === 'complete');
    await send('pinTab', { tabId: pinTab, spaceId: research });
    const pinId = (await runtime()).tabPin[pinTab];
    await send('renamePin', { pinId, title: 'Saved research' });
    const parentFolder = await send('createFolder', { spaceId: research, name: 'Projects' });
    const nestedFolder = await send('createFolder', { spaceId: research, parentId: parentFolder, name: 'Research folder' });
    await send('movePin', { pinId, spaceId: research, folderId: nestedFolder });
    await send('updateFolder', { folderId: nestedFolder, collapsed: true });
    await send('updateFolder', { folderId: parentFolder, collapsed: true });
    await send('unloadPin', { windowId: W, pinId });
    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    await search(source, 'Saved research');
    ok(await panel(source, "return !root.querySelector('[data-key=\"pin-${pinId}\"]')".replace('${pinId}', pinId)), 'other-space pins are excluded');
    await key(source, 'Escape'); await key(source, 'Escape'); await closed(source);
    await send('moveTab', { tabId: sourceId, spaceId: research });
    await open(sourceId, source);
    await search(source, 'Saved research');
    ok(await panel(source, "return root.querySelector('[role=option] .result-kind').textContent === 'Switch to tab'"), 'pin suggestions follow the current space');
    await key(source, 'Enter');
    await wait(async () => (await runtime()).activeSpace[W] === research);
    await closed(source);
    ok(!!(await tab(sourceId)), 'unloaded pins open in their space without closing the source');
    const pinConfig = await config();
    ok(!pinConfig.folders[parentFolder].collapsed && !pinConfig.folders[nestedFolder].collapsed && pinConfig.pins[pinId].folderId === nestedFolder, 'selecting a nested pin reveals its collapsed ancestors and keeps folder membership');
    const livePinId = +(Object.entries((await runtime()).tabPin).find(([, id]) => id === pinId)[0]);
    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await send('updateFolder', { folderId: nestedFolder, collapsed: true });
    await send('updateFolder', { folderId: parentFolder, collapsed: true });
    await open(sourceId, source);
    await search(source, 'Saved research');
    ok(await panel(source, "return root.querySelector('[role=option] .switch-to-tab')?.textContent === 'Switch to tab' && root.querySelector('[role=option] .result-detail').textContent.includes('Projects / Research folder') && !!root.querySelector('[role=option] img')"), 'loaded folder pins have a favicon, folder path, and Switch to tab badge');
    const beforePinSwitch = await api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.length)`);
    await key(source, 'Enter');
    await closed(source);
    await wait(async () => (await tab(livePinId)).active);
    ok(await api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.length)`) === beforePinSwitch, 'selecting a loaded folder pin switches to its existing tab without duplicating it');
    const revealedAgain = await config();
    ok(!revealedAgain.folders[parentFolder].collapsed && !revealedAgain.folders[nestedFolder].collapsed, 'switching to a loaded pin reveals its folder ancestors');
    await send('moveTab', { tabId: sourceId, spaceId: main });
    const emptySpace = await send('createSpace', { name: 'Empty workspace' });
    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    await search(source, '> Switch to Empty workspace');
    await key(source, 'Enter');
    await wait(async () => (await runtime()).activeSpace[W] === emptySpace);
    await closed(source);
    ok((await api(`chrome.tabs.query({ windowId: ${W}, active: true }).then(t => t[0].url)`)).includes('newtab'), 'switching to an empty space opens its New Tab page');
    await send('closeTabs', { windowId: W, tabIds: [targetId] });
    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    await panel(source, "root.querySelector('#archive').click(); return true");
    await search(source, 'open-target');
    await key(source, 'Enter');
    await wait(async () => !(await config()).archive.some(e => e.tabId === targetId));
    await closed(source);
    ok(true, 'archive result restores a closed tab from the overlay');
    const undoTab = await send('newTab', { windowId: W, spaceId: main, url: base + '/undo-floating' });
    await wait(async () => (await tab(undoTab))?.status === 'complete');
    await send('closeTabs', { windowId: W, tabIds: [undoTab] });
    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    await search(source, '> Undo last close');
    await key(source, 'Enter');
    await wait(async () => !(await config()).archive.some(e => e.tabId === undoTab));
    await closed(source);
    ok(true, 'undo command restores the latest closed tab from the overlay');

    const cspId = await send('newTab', { windowId: W, spaceId: main, url: base + '/strict-csp' });
    await wait(async () => (await tab(cspId))?.status === 'complete');
    const cspPage = await attach('/strict-csp');
    await open(cspId, cspPage);
    ok(await panel(cspPage, "return root.activeElement === root.querySelector('#search')"), 'overlay works under restrictive page CSP and Trusted Types');
    await key(cspPage, 'Escape'); await closed(cspPage);

    // Restricted Chrome pages must fall back without trying to inject an overlay.
    const restricted = await api(`chrome.tabs.create({ windowId: ${W}, url: 'chrome://settings/', active: true }).then(t => t.id)`);
    const fallback = await send('openCommandOverlay', { tabId: restricted });
    ok(fallback.newTab === true && !!(await tab(restricted)), 'restricted pages fall back to New Tab without closing their source');
    const manifestCommands = await api('chrome.commands.getAll()');
    ok(manifestCommands.some(c => c.name === 'command-bar'), 'floating command registered with Chrome');

    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await open(sourceId, source);
    if (process.env.SHOT) {
      for (const [scheme, width, height] of [['dark', 1440, 900], ['light', 1440, 900], ['dark', 600, 460]]) {
        await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, source);
        await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, source);
        await sleep(180);
        ok(await panel(source, "const r = root.querySelector('.surface').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight"), `${scheme} ${width}px overlay fits the viewport`);
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, source);
        fs.writeFileSync(`${process.env.SHOT}-${scheme}-${width}.png`, Buffer.from(data, 'base64'));
      }
    }
    await key(source, 'Escape'); await closed(source);
    await wait(async () => !(await runtime()).commandSessions[sourceId]);
    ok(true, 'dismissal revokes the overlay session');
  } catch (error) { log.push('FAIL exception: ' + error.stack); }
  return log.join('\n');
}
