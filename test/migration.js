(async () => {
  const result = await chrome.runtime.sendMessage({ type: 'createFolder', spaceId: (await chrome.storage.local.get('config')).config.spaces[0].id, name: 'Seed' });
  const tab = await chrome.tabs.create({ url: '__BASE__/legacy-pin', active: false });
  await new Promise(r => setTimeout(r, 300));
  let { config } = await chrome.storage.local.get('config');
  await chrome.runtime.sendMessage({ type: 'pinTab', tabId: tab.id, spaceId: config.spaces[0].id });
  ({ config } = await chrome.storage.local.get('config'));
  const pinIds = Object.keys(config.pins).sort();
  config.version = 1;
  delete config.folders;
  delete config.archive;
  for (const pin of Object.values(config.pins)) delete pin.folderId;
  await chrome.storage.local.set({ config, __legacyPinIds: pinIds });
  return 'PASS seeded legacy v1 configuration';
})()
