(async () => {
  const log = [];
  const ok = (condition, message) => log.push(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  const { config, __organizerExpect: expected } = await chrome.storage.local.get(['config', '__organizerExpect']);
  ok(!!config.folders[expected.folderId], 'nested folder survives extension reload');
  ok(config.pins[expected.pinId].folderId === expected.folderId, 'pin folder membership survives reload');
  ok(JSON.stringify(config.archive.map(e => e.id)) === JSON.stringify(expected.archiveIds), 'archive survives reload without duplicates');
  return log.join('\n');
})()
