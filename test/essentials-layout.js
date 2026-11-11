// Essentials grid: 1–3 on one row, 4–10 split over two rows (top row gets the extra),
// then rows of 5.
(async () => {
  const log = [];
  const ok = (cond, msg) => log.push((cond ? 'PASS ' : 'FAIL ') + msg);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const send = (type, p = {}) => chrome.runtime.sendMessage({ type, ...p });
  const expected = { 1: [1], 2: [2], 3: [3], 4: [2, 2], 5: [3, 2], 6: [3, 3], 7: [4, 3], 8: [4, 4], 9: [5, 4], 10: [5, 5], 11: [5, 5, 1] };
  try {
    await sleep(800);
    const W = (await chrome.windows.getCurrent()).id;
    for (let n = 1; n <= 11; n++) {
      const t = await chrome.tabs.create({ windowId: W, url: `__BASE__/ess${n}`, active: false });
      await sleep(300);
      await send('pinTab', { tabId: t.id, spaceId: null });
      await sleep(400);
      const rows = {};
      for (const el of document.querySelectorAll('#essentials .ess')) {
        const top = Math.round(el.getBoundingClientRect().top);
        rows[top] = (rows[top] ?? 0) + 1;
      }
      const got = Object.keys(rows).sort((a, b) => a - b).map(k => rows[k]);
      ok(JSON.stringify(got) === JSON.stringify(expected[n]), `${n} Essentials -> rows ${JSON.stringify(got)}`);
    }
  } catch (e) {
    log.push('FAIL exception: ' + e.stack);
  }
  return log.join('\n');
})()
