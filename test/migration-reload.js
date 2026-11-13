(async () => {
  const { config, __legacyPinIds: expected } = await chrome.storage.local.get(['config', '__legacyPinIds']);
  const checks = [
    [config.version === 2, 'v1 config migrates to v2'],
    [!!config.folders && Array.isArray(config.archive), 'migration initializes folders and archive'],
    [JSON.stringify(Object.keys(config.pins).sort()) === JSON.stringify(expected), 'migration keeps all saved pins'],
    [Object.values(config.pins).every(p => !p.folderId), 'legacy pins remain at top level'],
  ];
  return checks.map(([pass, label]) => `${pass ? 'PASS' : 'FAIL'} ${label}`).join('\n');
})()
