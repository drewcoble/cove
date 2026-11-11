// Regression: Enter in "Edit pinned URL…" must not re-run an earlier space editor's save
// (which used to recreate the last created space).
(async () => {
  const log = [];
  const ok = (cond, msg) => log.push((cond ? 'PASS ' : 'FAIL ') + msg);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = (type, p = {}) => chrome.runtime.sendMessage({ type, ...p });
  const cfg = async () => (await chrome.storage.local.get('config')).config;
  const enter = el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  try {
    await sleep(800);
    // Create a space through the real "New space…" popover.
    document.getElementById('add-space').click();
    await sleep(100);
    document.querySelector('#popover [name=name]').value = 'Last';
    enter(document.querySelector('#popover [name=name]'));
    await sleep(800);
    const before = (await cfg()).spaces.map(s => s.name);
    ok(before.at(-1) === 'Last', 'space created via the popover: ' + before);

    // Pin a tab in this window, then edit its pinned URL and press Enter.
    const W = (await chrome.windows.getCurrent()).id;
    const t = await chrome.tabs.create({ windowId: W, url: '__BASE__/pin-me', active: false });
    await sleep(800);
    await send('pinTab', { tabId: t.id, spaceId: (await chrome.storage.session.get('rt')).rt.activeSpace[W] });
    await sleep(800);
    const row = document.querySelector('#pins .row');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 200 }));
    await sleep(100);
    [...document.querySelectorAll('#menu .item')].find(b => b.textContent.includes('Edit pinned URL')).click();
    await sleep(100);
    const input = document.querySelector('#popover input');
    input.value = '__BASE__/new-url';
    enter(input);
    await sleep(800);
    const c = await cfg();
    ok(JSON.stringify(c.spaces.map(s => s.name)) === JSON.stringify(before), 'Enter in Edit pinned URL does not add a space: ' + c.spaces.map(s => s.name));
    ok(Object.values(c.pins).some(p => p.url === '__BASE__/new-url'), 'pinned URL was updated');
  } catch (e) {
    log.push('FAIL exception: ' + e.stack);
  }
  return log.join('\n');
})()
