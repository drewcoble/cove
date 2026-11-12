// Migration, part 2 (after a reload with empty storage): import the exported setup and check
// everything comes back and re-attaches to the open tabs without duplicates.
(async () => {
  const log = [];
  const ok = (cond, msg) => log.push((cond ? 'PASS ' : 'FAIL ') + msg);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = (type, p = {}) => chrome.runtime.sendMessage({ type, ...p });
  const cfg = async () => (await chrome.storage.local.get('config')).config;
  const rt = async () => (await chrome.storage.session.get('rt')).rt;
  const exported = __PAYLOAD__;
  try {
    await sleep(1000);
    const fresh = await cfg();
    ok(!Object.values(fresh.pins).some(p => p.title), 'fresh install starts without custom names (sanity)');

    const bad = await send('importConfig', { data: { hello: 'world' } });
    ok(!bad.ok && JSON.stringify(await cfg()) === JSON.stringify(fresh), 'a non-setup file is rejected and changes nothing');

    const res = await send('importConfig', { data: exported });
    ok(res.ok, 'import succeeds: ' + JSON.stringify(res.result ?? res.error));
    await sleep(800);
    const c = await cfg();
    const r = await rt();
    ok(JSON.stringify(c.spaces.map(s => [s.name, s.icon, s.color])) === JSON.stringify([['Work', '💼', 'green'], ['Personal', '', 'pink']]),
      'spaces restored with names, icons, colors and order: ' + JSON.stringify(c.spaces.map(s => s.name)));
    ok(c.essentials.length === 2 && c.essentials.map(id => c.pins[id].title).includes('Inbox'), 'Essentials restored without duplicates, custom name kept');
    ok(c.pins[c.spaces[0].pins[0]]?.title === 'Team PRs', 'pinned tab custom name restored');
    const reviews = Object.values(c.folders).find(f => f.name === 'Reviews');
    ok(reviews && c.folders[reviews.parentId]?.name === 'Projects' && c.pins[c.spaces[0].pins[0]].folderId === reviews.id, 'nested folders and pin membership survive export/import');
    ok(c.settings.collapseInactive === false && c.settings.peekInSplitView === true, 'settings restored');
    const boundPins = new Set(Object.values(r.tabPin));
    ok(Object.keys(c.pins).every(id => boundPins.has(id)), 'every pin re-attached to its open tab (incl. the drifted one)');
    const groups = await chrome.tabGroups.query({});
    ok(groups.every(g => c.spaces.some(s => s.id === r.groupSpace[g.id] && s.name === g.title)), 'tab groups mapped onto the imported spaces');
  } catch (e) {
    log.push('FAIL exception: ' + e.stack);
  }
  return log.join('\n');
})()
