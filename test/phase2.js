(async () => {
  const log = [];
  const ok = (cond, msg) => log.push((cond ? 'PASS ' : 'FAIL ') + msg);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    await sleep(800);
    const { __expect: x, config: c } = await chrome.storage.local.get(['__expect', 'config']);
    const { rt: r } = await chrome.storage.session.get('rt');
    ok(!(await chrome.storage.session.get('__marker')).__marker, 'session storage really was wiped by the reload');
    ok(r.initialized, 'runtime state rebuilt');
    ok(JSON.stringify(c.spaces.map(s => s.name).sort()) === JSON.stringify(x.spaces),
      'no duplicate spaces after re-adopting groups: ' + c.spaces.map(s => s.name));
    ok(JSON.stringify(Object.entries(r.tabPin).sort()) === JSON.stringify(x.bound),
      'pins re-bound to their tabs by URL (incl. a drifted one): ' + JSON.stringify(Object.entries(r.tabPin)));
    const tabs = await chrome.tabs.query({ windowId: x.W });
    ok(tabs.filter(t => !t.pinned).every(t => r.groupSpace[t.groupId]), 'every regular tab is in a space group');
    ok(c.essentials.length === Object.values(c.pins).filter(p => p.spaceId == null).length, 'no duplicate Essentials created');
  } catch (e) {
    log.push('FAIL exception: ' + e.stack);
  }
  return log.join('\n');
})()
