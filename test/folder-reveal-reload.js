(async () => {
  const { config, __folderRevealExpect: x } = await chrome.storage.local.get(['config', '__folderRevealExpect']);
  return [
    [!config.folders[x.root].collapsed && !config.folders[x.nested].collapsed, 'restart reveals all ancestors of the selected pinned tab'],
    [config.folders[x.unrelated].collapsed, 'restart preserves unrelated collapsed folders'],
    [config.pins[x.pinId].folderId === x.nested, 'restart preserves pin folder membership'],
    [!chrome.runtime.getManifest().chrome_url_overrides?.newtab, 'restart retains the browser default New Tab'],
  ].map(([pass, label]) => `${pass ? 'PASS' : 'FAIL'} ${label}`).join('\n');
})()
