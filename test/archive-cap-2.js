// Archive cap, part 2 (after an extension reload): close the two tabs that were open before
// the reload, and check the archive keeps the newest 500.
(async () => {
  const log = [];
  const ok = (cond, msg) => log.push((cond ? 'PASS ' : 'FAIL ') + msg);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const { W } = __PAYLOAD__;
  try {
    await sleep(1200);
    const tabs = (await chrome.tabs.query({ windowId: W })).filter(t => /before-reload/.test(t.url));
    for (const t of tabs) {
      await chrome.tabs.remove(t.id);
      await sleep(400);
    }
    await sleep(600);
    const { archive } = await chrome.storage.local.get('archive');
    ok(archive.length === 500, 'archive is capped at 500 entries: ' + archive.length);
    ok(/before-reload/.test(archive[0].url) && /before-reload/.test(archive[1].url), 'newest closes are kept first (tabs opened before a restart are still archived)');
    ok(!archive.some(e => e.id === 'seed498') && archive.some(e => e.id === 'seed497') && archive.some(e => e.id === 'seed0'), 'only the oldest entry is dropped (499 + 2 = 501)');
  } catch (e) {
    log.push('FAIL exception: ' + e.stack);
  }
  return log.join('\n');
})()
