(async()=>{
  const log=[];const ok=(value,label)=>log.push(`${value?'PASS':'FAIL'} ${label}`);
  await new Promise(r=>setTimeout(r,1000));
  const {config,archive,searchMemory,__upgrade:x}=await chrome.storage.local.get(['config','archive','searchMemory','__upgrade']);
  const {rt}=await chrome.storage.session.get('rt');
  for(const p of x.pins)ok(rt.tabPin[p.tabId]===p.pinId && config.pins[p.pinId].folderId===x.folder,`reordered ${p.route} tab restores its exact folder pin before broad aliases`);
  ok(archive.length===2 && new Set(archive.map(e=>e.id)).size===2 && archive[0].id==='upstream-close','upgrade preserves old and upstream archive entries once, newest first');
  ok(!('archive' in config) && !JSON.stringify(archive).includes('upgrade-secret'),'upgrade moves archive out of config and strips URL secrets');
  ok(searchMemory.searches.some(e=>e.text==='localhost') && searchMemory.searches.some(e=>e.text==='Example.COM'),'recent queries retain exact text through worker startup');
  ok(!JSON.stringify(searchMemory).includes('upgrade-secret') && JSON.stringify(searchMemory).includes('view=ok'),'existing selection memory is redacted without losing safe parameters');
  await chrome.runtime.sendMessage({type:'openPin',windowId:x.windowId,pinId:x.pins[0].pinId,reset:false});
  const updated=(await chrome.storage.local.get('config')).config;
  ok(!updated.folders[x.parent].collapsed && !updated.folders[x.folder].collapsed,'recovered route pin expands all folder ancestors');
  return log.join('\n');
})()
