// Archive cap, part 1: seed 499 entries, open two tabs, then the harness reloads the extension.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(800);
  const W = (await chrome.windows.create({ url: '__BASE__/keep' })).id;
  await sleep(600);
  const seeded = Array.from({ length: 499 }, (_, i) => ({
    id: 'seed' + i, batchId: 'seed' + i, closedAt: Date.now() - i * 1000, windowId: W,
    spaceId: null, url: `__BASE__/old-${i}`, title: `Old ${i}`, favIconUrl: '', active: false,
  }));
  await chrome.storage.local.set({ archive: seeded });
  for (const n of [1, 2]) await chrome.tabs.create({ windowId: W, url: `__BASE__/before-reload-${n}` });
  await sleep(800);
  return JSON.stringify({ log: 'PASS seeded 499 archive entries and opened two tabs', payload: { W } });
})()
