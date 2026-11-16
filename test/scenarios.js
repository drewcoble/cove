(async () => {
  const log = [];
  const ok = (cond, msg) => log.push((cond ? 'PASS ' : 'FAIL ') + msg);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = async (type, p = {}) => {
    const r = await chrome.runtime.sendMessage({ type, ...p });
    if (!r.ok) throw new Error(type + ': ' + r.error);
    return r.result;
  };
  const rt = async () => (await chrome.storage.session.get('rt')).rt;
  const cfg = async () => (await chrome.storage.local.get('config')).config;
  const B = '__BASE__';
  const waitLoad = async id => {
    for (let i = 0; i < 50; i++) {
      const t = await chrome.tabs.get(id);
      if (t.status === 'complete') return t;
      await sleep(100);
    }
  };
  const active = async W => (await chrome.tabs.query({ windowId: W, active: true }))[0];

  try {
    await sleep(500);
    let c = await cfg();
    ok(c && c.spaces.length === 1, 'default config has one space');
    const main = c.spaces[0].id;

    const win = await chrome.windows.create({ url: B + '/a1', focused: true });
    const W = win.id;
    await sleep(700);
    const [a1] = await chrome.tabs.query({ windowId: W });
    let r = await rt();
    ok(r.tabSpace[a1.id] === main, 'first tab of new window joins active space');
    ok((await chrome.tabs.get(a1.id)).groupId !== -1, 'tab is in a group');

    await send('updateSettings', { patch: { collapseInactive: false } });
    const a2 = await chrome.tabs.create({ windowId: W, url: B + '/a2' });
    const a3 = await chrome.tabs.create({ windowId: W, url: B + '/a3' });
    await sleep(400);
    const spaceB = await send('createSpace', { windowId: W, name: 'Work', color: 'green' });
    await sleep(300);
    r = await rt();
    ok(r.activeSpace[W] === spaceB, 'createSpace switches to the new space');
    const b1 = await chrome.tabs.create({ windowId: W, url: B + '/b1' });
    const b2 = await chrome.tabs.create({ windowId: W, url: B + '/b2' });
    await sleep(600);
    r = await rt();
    ok(r.tabSpace[b1.id] === spaceB && r.tabSpace[b2.id] === spaceB, 'new tabs go to active space (Work)');
    const groups = await chrome.tabGroups.query({ windowId: W });
    ok(groups.length === 2 && groups.some(g => g.title === 'Work' && g.color === 'green'),
      'one group per space, titled/colored: ' + JSON.stringify(groups.map(g => [g.title, g.color])));

    await send('goToSpace', { windowId: W, index: 0 });
    await sleep(300);
    ok((await rt()).activeSpace[W] === main, 'goToSpace(1) switches to the first space');
    await send('goToSpace', { windowId: W, index: 1 });
    await sleep(300);
    ok((await rt()).activeSpace[W] === spaceB, 'goToSpace(2) switches to the second space');
    await send('goToSpace', { windowId: W, index: 8 });
    await sleep(200);
    ok((await rt()).activeSpace[W] === spaceB, 'goToSpace for a missing space is ignored');
    const cmds = await chrome.commands.getAll();
    ok([1, 2, 3, 4, 5, 6, 7, 8, 9].every(n => cmds.some(c => c.name === `space-${n}`)), 'space-1..9 commands registered');

    await send('switchSpace', { windowId: W, spaceId: main });
    await sleep(300);
    ok([a1.id, a2.id, a3.id].includes((await active(W)).id), 'switching to Main activates a Main tab');

    // Strip order: a1 a2 a3 | b1 b2. MRU in Main: a3, a1. Chrome's own pick would be b1 (right neighbour).
    await chrome.tabs.update(a1.id, { active: true }); await sleep(150);
    await chrome.tabs.update(a3.id, { active: true }); await sleep(300);
    await chrome.tabs.remove(a3.id); // what Cmd+W does
    await sleep(900);
    let act = await active(W);
    r = await rt();
    ok(act.id === a1.id, `Cmd+W: next tab is MRU in same space (got "${act.title}", want a1)`);
    ok(r.activeSpace[W] === main, 'Cmd+W: active space stays Main');

    await send('closeTabs', { windowId: W, tabIds: [a1.id] });
    await sleep(600);
    act = await active(W);
    ok(act.id === a2.id, 'sidebar close picks remaining Main tab: ' + act.title);

    await chrome.tabs.remove(a2.id);
    await sleep(900);
    act = await active(W);
    r = await rt();
    ok(r.tabSpace[act.id] === main && r.activeSpace[W] === main,
      'closing last tab in a space opens a New Tab in that space (' + (act.pendingUrl || act.url) + ')');

    // ---- Pinned tab: custom name, drift, reset, unload
    const p1 = await chrome.tabs.create({ windowId: W, url: B + '/pinned' });
    await waitLoad(p1.id);
    await send('pinTab', { tabId: p1.id, spaceId: main });
    c = await cfg();
    const pinId = c.spaces.find(s => s.id === main).pins[0];
    ok(!!pinId && c.pins[pinId].url === B + '/pinned', 'pinTab creates a pin at the current URL');
    await send('renamePin', { pinId, title: 'My Name' });
    await chrome.tabs.update(p1.id, { url: B + '/elsewhere', active: true });
    await waitLoad(p1.id);
    await sleep(500);
    await chrome.tabs.create({ windowId: W, url: location.href, active: false });
    await sleep(1200);
    await chrome.tabs.update(p1.id, { active: true });
    await sleep(400);
    const panelW = chrome.extension.getViews({ type: 'tab', windowId: W })[0];
    const row = panelW?.document.querySelector(`#pins [data-id="${pinId}"]`);
    ok(row?.querySelector('.title').textContent === 'My Name',
      'custom name still shown after navigating away: ' + row?.querySelector('.title').textContent);
    ok(row?.classList.contains('drifted'), 'pinned row shows the "/" drifted state');
    await send('openPin', { windowId: W, pinId });
    await waitLoad(p1.id);
    await sleep(200);
    ok((await chrome.tabs.get(p1.id)).url === B + '/pinned', 'clicking the active drifted pin resets it');

    await send('unloadPin', { windowId: W, pinId });
    await sleep(500);
    c = await cfg();
    ok(c.pins[pinId] && !Object.values((await rt()).tabPin).includes(pinId), 'closing a pinned tab keeps the pin (unloaded)');
    await send('openPin', { windowId: W, pinId });
    await sleep(600);
    r = await rt();
    const reopened = Object.entries(r.tabPin).find(([, p]) => p === pinId);
    ok(!!reopened && r.tabSpace[reopened[0]] === main, 'clicking an unloaded pin reopens it in its space');

    // ---- Essentials
    const e1 = await chrome.tabs.create({ windowId: W, url: B + '/mail' });
    await waitLoad(e1.id);
    await send('pinTab', { tabId: e1.id, spaceId: null });
    await sleep(300);
    ok((await chrome.tabs.get(e1.id)).pinned, 'Essential is backed by a Chrome-pinned tab');
    c = await cfg();
    const essId = c.essentials[0];
    await chrome.tabs.update(e1.id, { url: B + '/inbox/thread', active: true });
    await waitLoad(e1.id);
    await send('switchSpace', { windowId: W, spaceId: spaceB });
    await sleep(300);
    await send('openPin', { windowId: W, pinId: essId });
    await sleep(200);
    ok((await active(W)).id === e1.id, 'first click on Essential activates it');
    await send('openPin', { windowId: W, pinId: essId });
    await waitLoad(e1.id);
    ok((await chrome.tabs.get(e1.id)).url === B + '/mail', 'second click on drifted Essential returns to mounted URL');
    r = await rt();
    ok(r.activeSpace[W] === spaceB, 'activating an Essential does not change space');

    await send('setPinUrl', { pinId: essId, url: B + '/redirect' });
    await send('resetPin', { windowId: W, pinId: essId });
    await waitLoad(e1.id);
    await sleep(1800);
    c = await cfg();
    ok((await chrome.tabs.get(e1.id)).url === B + '/home' && c.pins[essId].aliases.includes(B + '/home'),
      'server redirect recorded as alias, not drift: ' + JSON.stringify(c.pins[essId].aliases));

    // Closing an Essential returns to a tab in the current space
    await chrome.tabs.update(b1.id, { active: true }); await sleep(150);
    await chrome.tabs.update(e1.id, { active: true }); await sleep(300);
    await chrome.tabs.remove(e1.id);
    await sleep(900);
    act = await active(W);
    ok(act.id === b1.id, 'closing an Essential returns to the MRU tab of the current space: ' + act.title);
    c = await cfg();
    ok(c.essentials.includes(essId), 'Essential survives being closed');

    // ---- moveTab across spaces
    await send('moveTab', { tabId: b2.id, spaceId: main });
    await sleep(300);
    r = await rt();
    ok(r.tabSpace[b2.id] === main, 'moveTab moves a tab to another space');

    // ---- Collapse inactive spaces
    await send('updateSettings', { patch: { collapseInactive: true } });
    await send('switchSpace', { windowId: W, spaceId: spaceB });
    await sleep(500);
    let gs = await chrome.tabGroups.query({ windowId: W });
    r = await rt();
    ok(gs.every(g => g.collapsed === (r.groupSpace[g.id] !== spaceB)),
      'inactive space groups are collapsed: ' + JSON.stringify(gs.map(g => [g.title, g.collapsed])));

    // ---- Renaming the group in Chrome renames the space
    const workGroup = gs.find(g => r.groupSpace[g.id] === spaceB);
    await chrome.tabGroups.update(workGroup.id, { title: 'Job' });
    await sleep(400);
    c = await cfg();
    ok(c.spaces.find(s => s.id === spaceB).name === 'Job', 'renaming the tab group renames the space');

    // ---- Chrome-pinning a tab makes it an Essential
    const loose = (await chrome.tabs.query({ windowId: W })).find(t => !t.pinned && r.tabSpace[t.id] === spaceB);
    await chrome.tabs.update(loose.id, { pinned: true });
    await sleep(400);
    c = await cfg();
    ok(c.essentials.length === 2, 'pinning a tab in Chrome adds it to Essentials');
    await chrome.tabs.update(loose.id, { pinned: false });
    await sleep(400);
    ok((await chrome.tabs.get(loose.id)).groupId !== -1, 'unpinning in Chrome puts the tab back in a space');

    // ---- Dragging a tab out of its group puts it back
    const t2 = (await chrome.tabs.query({ windowId: W })).find(t => !t.pinned);
    await chrome.tabs.ungroup(t2.id);
    await sleep(600);
    ok((await chrome.tabs.get(t2.id)).groupId !== -1, 'a tab removed from its group is put back into its space');

    // ---- Delete space
    await send('deleteSpace', { spaceId: spaceB });
    await sleep(700);
    c = await cfg();
    const all = await chrome.tabs.query({ windowId: W });
    ok(c.spaces.length === 1 && !all.some(t => t.id === b1.id), 'deleteSpace removes the space and its tabs');
    ok(all.length > 0, 'window survives space deletion');
    // ---- Copy URL (⌘⇧C) — note: this writes a test URL to the clipboard
    const copied = await send('copyUrl', { windowId: W });
    ok(copied === true, 'copyUrl copies via the offscreen document');
    ok((await chrome.action.getBadgeText({})) === '✓', 'copyUrl flashes a ✓ badge');
    ok((await chrome.commands.getAll()).some(c => c.name === 'copy-url'), 'copy-url command registered');

    // ---- Peek
    const parent = await chrome.windows.get(W);
    const spaceBefore = (await rt()).activeSpace[W];
    const peekWin = await send('peek', { url: B + '/peeked', windowId: W });
    await sleep(1200);
    const pw = await chrome.windows.get(peekWin, { populate: true });
    ok(pw.type === 'popup', 'peek opens a popup window');
    ok(Math.abs(pw.left + pw.width / 2 - (parent.left + parent.width / 2)) <= 2 && pw.width < parent.width,
      'peek is smaller than and centered over its window');
    const [ui] = await chrome.scripting.executeScript({ target: { tabId: pw.tabs[0].id }, func: () => !!document.querySelector('cove-peek') });
    ok(ui.result === true, 'peek toolbar injected into the page');
    r = await rt();
    ok(!Object.values(r.tabSpace).includes(undefined) && !(pw.tabs[0].id in r.tabSpace), 'peek tab is not adopted into a space');
    await send('peekClose', { windowId: peekWin });
    await sleep(400);
    ok(!(await chrome.windows.getAll()).some(w => w.id === peekWin) && !(await rt()).peeks[peekWin], 'peekClose closes the popup');

    const peek2 = await send('peek', { url: B + '/keepme', windowId: W });
    await sleep(800);
    const keptTabId = await send('peekExpand', { windowId: peek2 });
    await sleep(800);
    const kept = await chrome.tabs.get(keptTabId);
    r = await rt();
    ok(kept.windowId === W && kept.url === B + '/keepme' && r.tabSpace[kept.id] === spaceBefore,
      'peekExpand opens the page as a tab in the space it came from');
    ok(!(await chrome.windows.getAll()).some(w => w.id === peek2), 'peekExpand closes the popup');

    const peek3 = await send('peek', { url: B + '/a', windowId: W });
    await sleep(500);
    const peek4 = await send('peek', { url: B + '/b', windowId: peek3 });
    await sleep(500);
    const wins = await chrome.windows.getAll();
    ok(!wins.some(w => w.id === peek3) && wins.some(w => w.id === peek4) && (await rt()).peeks[peek4]?.parentWindowId === W,
      'peeking from inside a peek replaces it (no stacking)');
    await send('peekClose', { windowId: peek4 });

    // A tab Chrome attributes to the Essential that its page didn't open itself (e.g. a link
    // arriving from Slack while the Essential is active) stays a normal tab. Tabs the page does
    // open (target=_blank) are covered with real clicks in peek-input.mjs.
    const essTab = await chrome.tabs.create({ windowId: W, url: B + '/inbox' });
    await waitLoad(essTab.id);
    await send('pinTab', { tabId: essTab.id, spaceId: null });
    await chrome.tabs.update(essTab.id, { active: true });
    await sleep(300);
    const spawned = await chrome.tabs.create({ windowId: W, url: B + '/from-slack', openerTabId: essTab.id, active: true });
    await sleep(1200);
    r = await rt();
    ok(!!(await chrome.tabs.get(spawned.id).catch(() => null)) && !Object.keys(r.peeks).length && r.tabSpace[spawned.id],
      'a link arriving from another app while an Essential is active opens as a normal tab in a space');
    const bg = await chrome.tabs.create({ windowId: W, url: B + '/bg', openerTabId: essTab.id, active: false });
    await sleep(800);
    ok(!!(await chrome.tabs.get(bg.id).catch(() => null)) && !Object.keys((await rt()).peeks).length,
      '⌘-click style background tab from an Essential stays a normal tab');
    await send('updateSettings', { patch: { peekFromEssentials: false } });
    const off = await chrome.tabs.create({ windowId: W, url: B + '/off', openerTabId: essTab.id, active: true });
    await sleep(800);
    ok(!!(await chrome.tabs.get(off.id).catch(() => null)), 'setting off: links from Essentials open as tabs');
    await send('updateSettings', { patch: { peekFromEssentials: true } });

    // ---- Full screen: Peek opens in a split view beside the tab you came from
    await chrome.windows.update(W, { state: 'fullscreen' });
    await sleep(800);
    ok((await chrome.windows.get(W)).state === 'fullscreen', '(window is full screen)');
    const NONE = chrome.tabs.SPLIT_VIEW_ID_NONE;
    const essentialsBefore = (await cfg()).essentials.length;
    const windowsBefore = (await chrome.windows.getAll()).length;
    await chrome.tabs.update(essTab.id, { active: true });
    await sleep(300);
    const sp1 = await send('peek', { url: B + '/split-peek', windowId: W });
    await sleep(1200);
    let spTab = await chrome.tabs.get(sp1);
    let essNow = await chrome.tabs.get(essTab.id);
    ok((await chrome.windows.getAll()).length === windowsBefore, 'full screen: Peek opens no new window');
    ok(spTab.splitViewId !== NONE && spTab.splitViewId === essNow.splitViewId && spTab.url === B + '/split-peek',
      'full screen: Peek is split beside the Essential');
    ok((await cfg()).essentials.length === essentialsBefore, 'split Peek next to an Essential is not turned into an Essential');
    const [spUi] = await chrome.scripting.executeScript({ target: { tabId: sp1 }, func: () => !!document.querySelector('cove-peek') });
    ok(spUi.result === true, 'split Peek gets the ✕ / ⤢ toolbar');
    await chrome.tabs.update(essTab.id, { active: true });
    await sleep(500);
    ok(!!(await chrome.tabs.get(sp1).catch(() => null)), 'clicking the Essential pane keeps the split Peek open');
    await send('peekClose', { tabId: sp1 });
    await sleep(700);
    essNow = await chrome.tabs.get(essTab.id);
    ok(!(await chrome.tabs.get(sp1).catch(() => null)) && essNow.active && essNow.splitViewId === NONE,
      'closing the split Peek returns to the full-width Essential');

    const sp2 = await send('peek', { url: B + '/split-keep', windowId: W });
    await sleep(1000);
    await send('peekExpand', { tabId: sp2 });
    await sleep(800);
    spTab = await chrome.tabs.get(sp2);
    r = await rt();
    ok(spTab.splitViewId === NONE && !spTab.pinned && r.groupSpace[spTab.groupId] && spTab.active && !(sp2 in r.tabPeeks),
      'keeping the split Peek "mounts" it as a normal, active tab in the current space');
    ok((await chrome.tabs.get(essTab.id)).splitViewId === NONE, 'the Essential is no longer split');

    await chrome.tabs.update(essTab.id, { active: true });
    await sleep(300);
    const fsSlack = await chrome.tabs.create({ windowId: W, url: B + '/fs-slack', openerTabId: essTab.id, active: true });
    await sleep(1200);
    const fsSlackTab = await chrome.tabs.get(fsSlack.id).catch(() => null);
    r = await rt();
    ok(!!fsSlackTab && fsSlackTab.splitViewId === NONE && !Object.keys(r.tabPeeks).length,
      'full screen: a link arriving from another app opens as a normal tab, not a split Peek');
    await chrome.tabs.update(essTab.id, { active: true });
    await sleep(300);
    const spawnId = await send('peek', { url: B + '/fs-email', windowId: W });
    await sleep(1000);
    const spawnTab = await chrome.tabs.get(spawnId);
    await chrome.tabs.unsplit(spawnTab.splitViewId);
    await sleep(800);
    r = await rt();
    const unsplitTab = await chrome.tabs.get(spawnTab.id);
    ok(!(spawnTab.id in r.tabPeeks) && !unsplitTab.pinned && r.groupSpace[unsplitTab.groupId],
      'unsplitting from Chrome UI keeps the Peek as a normal tab');

    // Fallback: a tab already in a split you made gets a temporary-tab Peek instead
    const u1 = await chrome.tabs.create({ windowId: W, url: B + '/u1' });
    const u2 = await chrome.tabs.create({ windowId: W, url: B + '/u2' });
    await sleep(800);
    await chrome.tabs.createSplit([u1.id, u2.id]);
    await chrome.tabs.update(u1.id, { active: true });
    await sleep(500);
    const fb = await send('peek', { url: B + '/fallback', windowId: W });
    await sleep(800);
    const fbTab = await chrome.tabs.get(fb);
    ok(fbTab.splitViewId === NONE && (await rt()).tabPeeks[fb] && !(await rt()).tabPeeks[fb].split,
      'tab already in a split: Peek falls back to a temporary tab');
    await send('peekClose', { tabId: fb });
    await sleep(500);
    ok((await active(W)).id === u1.id, 'closing the fallback Peek returns to where you were');
    await chrome.windows.update(W, { state: 'normal' });
    await sleep(800);

    // Setting: split view outside full screen
    await send('updateSettings', { patch: { peekInSplitView: true } });
    await chrome.tabs.update(essTab.id, { active: true });
    await sleep(300);
    const sp3 = await send('peek', { url: B + '/split-windowed', windowId: W });
    await sleep(800);
    ok((await chrome.tabs.get(sp3)).splitViewId !== NONE, 'with the setting on, Peek uses split view outside full screen too');
    await send('peekClose', { tabId: sp3 });
    await send('updateSettings', { patch: { peekInSplitView: false } });
    await sleep(300);

    // Content scripts may only use Peek messages
    const victim = (await chrome.tabs.query({ windowId: W })).find(t => /^http/.test(t.url));
    const spacesBefore = (await cfg()).spaces.length;
    await chrome.scripting.executeScript({
      target: { tabId: victim.id },
      func: id => chrome.runtime.sendMessage({ type: 'deleteSpace', spaceId: id }).catch(() => 'rejected'),
      args: [(await cfg()).spaces.at(-1).id],
    });
    await sleep(400);
    ok((await cfg()).spaces.length === spacesBefore, 'content scripts cannot call non-Peek handlers');

    // ---- prepare restart check
    const sp = await send('createSpace', { windowId: W, name: 'Restart', color: 'purple' });
    const rp = await chrome.tabs.create({ windowId: W, url: B + '/restart-pin' });
    await waitLoad(rp.id);
    await send('pinTab', { tabId: rp.id, spaceId: sp });
    await chrome.tabs.update(rp.id, { url: B + '/restart-pin/drifted' });
    await waitLoad(rp.id);
    const ess = await chrome.tabs.create({ windowId: W, url: B + '/ess2' });
    await waitLoad(ess.id);
    await send('pinTab', { tabId: ess.id, spaceId: null });
    await sleep(600);
    c = await cfg();
    r = await rt();
    await chrome.storage.session.set({ __marker: 1 });
    await chrome.storage.local.set({ __expect: {
      W, spaces: c.spaces.map(s => s.name).sort(), bound: Object.entries(r.tabPin).sort(), rp: rp.id, ess: ess.id,
    } });
  } catch (e) {
    log.push('FAIL exception: ' + e.stack);
  }
  return log.join('\n');
})()
