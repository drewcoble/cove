import fs from 'node:fs';

export async function run({ cdp, sessionId: control, extId, base }) {
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
  const wait = async predicate => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await sleep(60); }
    throw new Error('Timed out waiting for browser state');
  };
  const tab = id => api(`chrome.tabs.get(${id}).catch(() => null)`);
  const config = () => api("chrome.storage.local.get('config').then(r => r.config)");
  const runtime = () => api("chrome.storage.session.get('rt').then(r => r.rt)");
  const search = (session, text) => evaluate(session, `(() => { const input = document.querySelector('#search'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const key = (session, value) => evaluate(session, `document.querySelector('#search').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(value)}, bubbles: true, cancelable: true }))`);
  // Dispatch trusted Enter through CDP so the browser exercises form submission.
  const enter = async session => {
    await evaluate(session, "document.querySelector('#search').focus()");
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, session);
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, session).catch(() => {});
  };
  const main = (await config()).spaces[0].id;
  const W = await api('chrome.windows.getCurrent().then(w => w.id)');
  const make = async (path, spaceId = main) => {
    const id = await send('newTab', { windowId: W, spaceId, url: base + path });
    await wait(async () => (await tab(id))?.status === 'complete');
    return id;
  };
  const newtab = async () => {
    // Exercise the standalone search fallback; native New Tabs are not overridden.
    const { targetId } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/src/newtab.html` });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Runtime.enable', {}, sessionId);
    await wait(() => evaluate(sessionId, "!!document.querySelector('#results .result') && !!document.querySelector('#space-name').textContent").catch(() => false));
    const id = await evaluate(sessionId, 'chrome.tabs.getCurrent().then(t => t.id)');
    return { session: sessionId, id, targetId };
  };
  const dismiss = async page => {
    await key(page.session, 'Escape');
    await wait(async () => !(await tab(page.id)));
  };
  try {
    const source = await make('/planning');
    let page = await newtab();
    ok(await evaluate(page.session, "location.href.includes('/src/newtab.html')"), 'standalone search fallback loads');
    ok((await runtime()).tabSpace[page.id] === main, 'New Tab joins the active space');
    ok(await evaluate(page.session, "document.title === 'Search — Cove' && !!document.querySelector('#search[role=combobox]')"), 'standalone fallback renders the accessible search panel');
    ok(!(await evaluate(page.session, "document.querySelector('#results').textContent.includes('Cove')")), 'launcher excludes extension UI and itself from suggestions');
    await search(page.session, 'planning');
    ok(await evaluate(page.session, "document.querySelector('#results .result').dataset.kind === 'navigate' && document.querySelectorAll('#results .result')[1].dataset.kind === 'search'"), 'history ranks before second-row web search without ordinary-tab suggestions');
    const before = await evaluate(page.session, "document.querySelector('#search').getAttribute('aria-activedescendant')");
    await key(page.session, 'ArrowDown');
    ok(await evaluate(page.session, `document.querySelector('#search').getAttribute('aria-activedescendant') !== ${JSON.stringify(before)}`), 'arrow keys move the accessible selection');
    await key(page.session, 'ArrowUp');
    await enter(page.session);
    await wait(async () => (await tab(page.id))?.url === base + '/planning');
    ok(!!(await tab(source)) && page.id !== source, 'history navigation reuses the launcher and preserves the ordinary source tab');
    ok(!(await config()).archive.some(e => e.tabId === page.id), 'dismissed New Tab does not pollute the archive');

    page = await newtab();
    const initialCount = await api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.length)`);
    await search(page.session, base + '/opened-in-place');
    await enter(page.session);
    await wait(async () => (await tab(page.id))?.url === base + '/opened-in-place');
    ok((await api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.length)`)) === initialCount, 'URL navigation reuses the launcher instead of creating another tab');
    ok((await runtime()).tabSpace[page.id] === main, 'URL navigation keeps its original space');
    const refused = await api(`chrome.runtime.sendMessage({ type: 'dismissNewTab', tabId: ${page.id} })`);
    ok(!refused.ok && !!(await tab(page.id)), 'stale launcher commands cannot close a navigated page');

    page = await newtab();
    await search(page.session, 'zen tabs query 92813');
    await enter(page.session);
    await wait(async () => /^https?:/.test((await tab(page.id))?.pendingUrl || (await tab(page.id))?.url || ''));
    const searchTab = await tab(page.id);
    const searchUrl = new URL(searchTab.pendingUrl || searchTab.url);
    ok([...searchUrl.searchParams.values()].some(value => value.includes('zen tabs query 92813')), 'web search uses the configured search engine in the same tab');
    await api(`chrome.tabs.remove(${page.id})`);

    const other = await send('createSpace', { name: 'Design', color: 'pink' });
    const pinned = await make('/design-guide', other);
    await send('pinTab', { tabId: pinned, spaceId: other });
    const pinId = (await runtime()).tabPin[pinned];
    const folder = await send('createFolder', { spaceId: other, name: 'Resources' });
    await send('movePin', { pinId, spaceId: other, folderId: folder });
    await send('renamePin', { pinId, title: 'Design handbook' });
    await send('unloadPin', { windowId: W, pinId });
    await send('switchSpace', { windowId: W, spaceId: main });
    page = await newtab();
    await search(page.session, 'Design handbook');
    ok(await evaluate(page.session, "![...document.querySelectorAll('#results .result')].some(n => n.dataset.kind === 'pin')"), 'other-space pins are excluded from fallback search');
    await key(page.session, 'Escape');
    await dismiss(page);
    await send('switchSpace', { windowId: W, spaceId: other });
    page = await newtab();
    await search(page.session, 'Design handbook');
    ok(await evaluate(page.session, "document.querySelector('#results .result').dataset.kind === 'pin'"), 'search finds unloaded pins in the selected space');
    ok(await evaluate(page.session, "document.querySelector('#results .result').textContent.includes('Resources')"), 'pin search displays its folder path');
    await enter(page.session);
    await wait(async () => !(await tab(page.id)));
    ok((await runtime()).activeSpace[W] === other, 'opening a pin switches to its space');
    const livePin = Number(Object.entries((await runtime()).tabPin).find(([, value]) => value === pinId)[0]);
    await wait(async () => (await tab(livePin))?.status === 'complete');
    await api(`chrome.tabs.update(${livePin}, { url: ${JSON.stringify(base + '/design-guide/drifted')} })`);
    await wait(async () => (await tab(livePin))?.status === 'complete');
    page = await newtab();
    await search(page.session, 'Design handbook');
    await enter(page.session);
    await wait(async () => !(await tab(page.id)));
    ok((await tab(livePin)).url.endsWith('/drifted'), 'selecting a loaded pin preserves its current page');

    const empty = await send('createSpace', { name: 'Quiet', color: 'cyan' });
    page = await newtab();
    await search(page.session, '> Switch to Quiet');
    await enter(page.session);
    await wait(async () => (await runtime()).tabSpace[page.id] === empty);
    ok(!!(await tab(page.id)), 'switching to an empty space keeps the launcher ready');
    await wait(() => evaluate(page.session, "document.querySelector('#space-name').textContent === 'Quiet'"));
    ok(true, 'space name and theme update after switching');
    await key(page.session, 'Escape'); // clear query
    ok(await evaluate(page.session, "document.querySelector('#search').value === ''"), 'Escape clears the query before dismissing');
    await dismiss(page);
    ok((await tab(livePin)).active, 'Escape returns to the previous tab');

    page = await newtab();
    await search(page.session, '> New folder');
    await enter(page.session);
    await wait(() => evaluate(page.session, "document.querySelector('#folder-dialog').open"));
    await evaluate(page.session, "document.querySelector('#folder-name').value = 'Reading list'; document.querySelector('#folder-form').requestSubmit()");
    await wait(async () => Object.values((await config()).folders).some(f => f.name === 'Reading list'));
    ok(true, 'New folder command saves a folder from the New Tab page');
    await wait(() => evaluate(page.session, "!document.querySelector('#folder-dialog').open"));
    await api(`chrome.tabs.remove(${source})`);
    await wait(async () => (await config()).archive.some(entry => entry.tabId === source));
    await evaluate(page.session, "document.querySelector('#archive-toggle').click()");
    await search(page.session, 'planning');
    await wait(() => evaluate(page.session, "document.querySelector('#results .result')?.dataset.kind === 'archive'"));
    ok(true, 'archive mode searches closed tabs');
    await enter(page.session);
    await wait(async () => !(await tab(page.id)));
    ok(!(await config()).archive.some(entry => entry.tabId === source), 'archive result restores its tab and consumes the entry');

    page = await newtab();
    const moduleChecks = await evaluate(page.session, `(async () => {
      const { navigationUrl, searchScore } = await import('./search.js');
      return [navigationUrl('localhost:3000/a') === 'http://localhost:3000/a', navigationUrl('example.com') === 'https://example.com', navigationUrl('two words') === null, navigationUrl('javascript:alert(1)') === null, searchScore('Design handbook', '', 'design') > searchScore('Unrelated', 'design', 'design')];
    })()`);
    ok(moduleChecks.every(Boolean), 'shared URL detection and search ranking handle local addresses, searches, and unsafe schemes');
    // IME input must not execute a half-composed query.
    await evaluate(page.session, "document.querySelector('#search').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))");
    await search(page.session, '日本');
    await enter(page.session);
    ok(!!(await tab(page.id)), 'IME composition does not trigger premature navigation');
    await evaluate(page.session, "document.querySelector('#search').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))");
    await search(page.session, '');

    const isolated = await api("chrome.windows.create({ url: 'chrome://newtab/', focused: false })");
    const onlyTab = isolated.tabs[0].id;
    const cancelled = await send('dismissNewTab', { tabId: onlyTab });
    ok(cancelled === false && !!(await tab(onlyTab)), 'Escape on the only tab keeps the window open');
    await api(`chrome.windows.remove(${isolated.id})`);
    await send('pinTab', { tabId: page.id, spaceId: null });
    const launcherPinId = (await runtime()).tabPin[page.id];
    await send('dismissNewTab', { tabId: page.id, previousTabId: livePin });
    ok((await tab(page.id)).pinned, 'dismissing a pinned launcher keeps its Essential');
    await send('navigateNewTab', { tabId: page.id, text: base + '/essential-newtab' });
    ok((await tab(page.id)).pinned && ((await tab(page.id)).pendingUrl || (await tab(page.id)).url).endsWith('/essential-newtab'), 'a pinned New Tab can still navigate normally');
    await send('removePin', { pinId: launcherPinId });
    page = await newtab();

    if (process.env.SHOT) {
      for (const [scheme, width, height] of [['light', 1440, 1000], ['dark', 1440, 1000], ['light', 390, 760], ['dark', 600, 460]]) {
        await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, page.session);
        await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, page.session);
        await sleep(220);
        const overflow = await evaluate(page.session, "document.documentElement.scrollWidth > innerWidth || document.querySelector('.search-panel').getBoundingClientRect().bottom > innerHeight");
        ok(!overflow, `${scheme} ${width}px layout fits the viewport`);
        const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, page.session);
        fs.writeFileSync(`${process.env.SHOT}-${scheme}-${width}.png`, Buffer.from(data, 'base64'));
      }
    }
    // A closed, unused launcher should never occupy a slot in the archive.
    const closedId = page.id;
    await api(`chrome.tabs.remove(${closedId})`);
    await sleep(150);
    ok(!(await config()).archive.some(entry => entry.tabId === closedId), 'closing an unused New Tab does not create an archive entry');
  } catch (error) { log.push('FAIL exception: ' + error.stack); }
  return log.join('\n');
}
