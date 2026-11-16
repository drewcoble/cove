(async () => {
  const log=[];
  const send=async(type,payload={})=>{const r=await chrome.runtime.sendMessage({type,...payload});if(!r.ok)throw new Error(r.error);return r.result;};
  const wait=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,60));}throw new Error('Upgrade fixture timed out');};
  try {
    const windowId=(await chrome.windows.getCurrent()).id;
    await send('pinTab',{tabId:(await chrome.tabs.getCurrent()).id,spaceId:null});
    const {config}=await chrome.storage.local.get('config'); const spaceId=config.spaces[0].id;
    const parent=await send('createFolder',{spaceId,name:'Upgrade parent'});
    const folder=await send('createFolder',{spaceId,parentId:parent,name:'Routes'});
    const pins=[];
    for(const route of ['dashboard','reports']) {
      const tabId=await send('newTab',{windowId,spaceId,url:'__BASE__/app#/'+route});
      await wait(async()=>(await chrome.tabs.get(tabId)).status==='complete');
      await send('pinTab',{tabId,spaceId,folderId:folder});
      const pinId=(await chrome.storage.session.get('rt')).rt.tabPin[tabId];
      await send('renamePin',{pinId,title:route});
      pins.push({tabId,pinId,route});
    }
    await chrome.tabs.move(pins[1].tabId,{index:(await chrome.tabs.get(pins[0].tabId)).index});
    await send('updateFolder',{folderId:parent,collapsed:true});
    await send('updateFolder',{folderId:folder,collapsed:true});
    const current=(await chrome.storage.local.get('config')).config;
    current.pins[pins[0].pinId].lastUrl='__BASE__/app#/reports';
    const legacy={id:'legacy-close',url:'__BASE__/legacy?code=upgrade-secret',title:'Old PR close',closedAt:20,batchId:'old',windowId,spaceId};
    const newer={id:'upstream-close',url:'__BASE__/newer',title:'Upstream close',closedAt:30,batchId:'new',windowId,spaceId};
    current.archive=[legacy];
    await chrome.storage.local.set({config:current,archive:[newer,legacy],__upgrade:{pins,folder,parent,windowId},searchMemory:{searches:[{text:'localhost',count:1},{text:'Example.COM',count:1}],selections:[{query:'https://app.example/?token=upgrade-secret&view=ok',key:'https://app.example/?token=upgrade-secret&view=ok',count:2}]}});
    log.push('PASS saved reordered route pins and old/new archive and search-memory upgrade fixtures');
  }catch(error){log.push('FAIL '+error.stack);}
  return log.join('\n');
})()
