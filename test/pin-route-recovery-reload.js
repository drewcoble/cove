(async()=>{
  const log=[];const ok=(pass,label)=>log.push(`${pass?'PASS':'FAIL'} ${label}`);
  const {config,__routeRecovery:x}=await chrome.storage.local.get(['config','__routeRecovery']);
  const {rt}=await chrome.storage.session.get('rt');
  for(const pin of x.pins) {
    ok(rt.tabPin[pin.tabId]===pin.pinId && config.pins[pin.pinId].folderId===x.folder,
      `reordered ${pin.route} tab restores its exact folder pin before broader aliases`);
    ok((await chrome.tabs.get(pin.tabId)).url.endsWith('#/'+pin.route),`${pin.route} retains its saved hash route`);
  }
  await chrome.runtime.sendMessage({type:'openPin',windowId:x.windowId,pinId:x.pins[0].pinId,reset:false});
  const updated=(await chrome.storage.local.get('config')).config;
  ok(!updated.folders[x.parent].collapsed && !updated.folders[x.folder].collapsed,'recovered route pin expands all folder ancestors');
  return log.join('\n');
})()
