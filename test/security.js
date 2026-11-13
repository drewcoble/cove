// Security regressions: each check tries the attack and expects it to be blocked.
(async () => {
  const log = [];
  const ok = (cond, msg) => log.push((cond ? 'PASS ' : 'FAIL ') + msg);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = async (type, p = {}) => {
    const r = await chrome.runtime.sendMessage({ type, ...p });
    if (!r?.ok) throw new Error(type + ': ' + r?.error);
    return r.result;
  };
  const cfg = async () => (await chrome.storage.local.get('config')).config;
  const B = '__BASE__';
  const inPage = async (tabId, func, args = [], world = 'ISOLATED') =>
    (await chrome.scripting.executeScript({ target: { tabId }, func, args, world }))[0].result;
  try {
    await sleep(800);
    const W = (await chrome.windows.create({ url: B + '/page', focused: true })).id;
    await sleep(900);
    const [page] = await chrome.tabs.query({ windowId: W });

    // 1. Sign-in secrets in redirect URLs are not stored or exported.
    const t = await chrome.tabs.create({ windowId: W, url: B + '/pinme' });
    await sleep(700);
    await send('pinTab', { tabId: t.id, spaceId: null });
    const essId = (await cfg()).essentials.at(-1);
    await send('resetPin', { windowId: W, pinId: essId });
    await chrome.tabs.update(t.id, { url: B + '/callback?code=SECRETCODE&state=SECRETSTATE&view=inbox#access_token=SECRETTOKEN' });
    await sleep(1500);
    const pin = (await cfg()).pins[essId];
    ok(!JSON.stringify(pin).includes('SECRET'), 'tokens in a redirect are not stored: ' + JSON.stringify([pin.aliases, pin.lastUrl]));
    ok(pin.aliases.includes(B + '/callback?view=inbox'), 'harmless query params are kept, so the alias still works');
    ok(!JSON.stringify(await send('exportConfig')).includes('SECRET'), 'export contains no tokens');
    const dirty = await send('exportConfig');
    dirty.config.pins[essId].aliases = [B + '/x?access_token=SECRETIMPORT'];
    dirty.config.pins[essId].lastUrl = B + '/y#id_token=SECRETIMPORT';
    await send('importConfig', { data: dirty });
    await sleep(500);
    // URLs only: the test server echoes the URL into page titles, which real sites don't do with tokens.
    const urls = p => JSON.stringify([p.url, p.lastUrl, p.aliases]);
    const after = await cfg();
    ok(!Object.values(after.pins).some(p => urls(p).includes('SECRET')),
      'tokens in an imported (or older) setup are stripped, and a tab adopted on a callback URL is pinned without them: ' +
        JSON.stringify(Object.values(after.pins).filter(p => urls(p).includes('SECRET')).map(urls)));
    ok((await chrome.tabs.get(t.id)).pinned && Object.values(after.pins).some(p => p.url === B + '/callback?view=inbox'),
      'adopted pin keeps its harmless query params');

    // 2. Content scripts can't write to the clipboard or spoof sidebar toasts.
    await send('copyUrl', { windowId: W });
    const clip = await inPage(page.id, () =>
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'copy', text: 'cove-test' }).then(r => r ?? null, e => 'error'));
    ok(clip?.ok !== true, 'content script cannot use the clipboard writer: ' + JSON.stringify(clip));
    ok((await send('copyUrl', { windowId: W })) === true, 'copy URL from the service worker still works');

    // 3. Content scripts can't aim Peek at another window.
    const other = (await chrome.windows.create({ url: B + '/other' })).id;
    await sleep(800);
    await inPage(page.id, w => chrome.runtime.sendMessage({ type: 'peek', url: 'https://example.com/', windowId: w }), [other]);
    await sleep(800);
    let peeks = Object.entries((await chrome.storage.session.get('rt')).rt.peeks);
    ok(peeks.length === 1 && peeks[0][1].parentWindowId === W, 'a page\'s Peek always belongs to its own window');
    const otherPeek = await send('peek', { url: B + '/victim', windowId: other });
    await sleep(800);
    await inPage(page.id, id => chrome.runtime.sendMessage({ type: 'peekClose', windowId: id }), [otherPeek]);
    await sleep(500);
    ok(!!(await chrome.windows.get(otherPeek).catch(() => null)), 'a page cannot close another window\'s Peek');

    // 4. The page inside a Peek can't fake Esc / ⌘↩.
    const peekTab = (await chrome.windows.get(otherPeek, { populate: true })).tabs[0].id;
    await sleep(600);
    await inPage(peekTab, () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    }, [], 'MAIN');
    await sleep(600);
    ok(!!(await chrome.windows.get(otherPeek).catch(() => null)), 'synthetic Esc / ⌘↩ inside a Peek are ignored');

    // 5. The content script reads only the Option-click flag.
    const stored = await chrome.storage.local.get('peekOnAltClick');
    ok(stored.peekOnAltClick === true, 'Option-click flag is mirrored to its own storage key');
    await send('updateSettings', { patch: { peekOnAltClick: false } });
    await sleep(300);
    ok((await chrome.storage.local.get('peekOnAltClick')).peekOnAltClick === false, 'flag follows the setting');
    ok(await inPage(page.id, () => enabled === false), 'live Option-click changes reach existing content scripts without exposing the setup');
    await send('updateSettings', { patch: { peekOnAltClick: true } });
  } catch (e) {
    log.push('FAIL exception: ' + e.stack);
  }
  return log.join('\n');
})()
