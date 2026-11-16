(async()=>{
  const log=[];
  const ok=(pass,label)=>log.push(`${pass?'PASS':'FAIL'} ${label}`);
  const send=async(type,args={})=>{const r=await chrome.runtime.sendMessage({type,...args});if(!r.ok)throw new Error(r.error);return r.result;};
  const rt=async()=> (await chrome.storage.session.get('rt')).rt;
  const wait=async f=>{for(let i=0;i<100;i++){if(await f())return;await new Promise(r=>setTimeout(r,60));}throw new Error('Timed out waiting for New Tab tree state');};
  try {
    const W=(await chrome.windows.getCurrent()).id;
    const control=(await chrome.tabs.getCurrent()).id;
    await send('pinTab',{tabId:control,spaceId:null});
    const {config}=await chrome.storage.local.get('config');const main=config.spaces[0].id;
    const parent=await send('newTab',{windowId:W,spaceId:main,url:'__BASE__/Wikipedia'});
    await wait(async()=> (await chrome.tabs.get(parent)).status==='complete');
    // Chrome may carry an opener ID even for a tab created by the browser's New Tab action.
    const fresh=await chrome.tabs.create({windowId:W,url:'chrome://newtab/',openerTabId:parent,active:true});
    await wait(async()=> (await rt()).treeDetached[fresh.id]===true);
    await chrome.tabs.update(fresh.id,{url:'__BASE__/Typed-search-result'});
    await wait(async()=> (await chrome.tabs.get(fresh.id)).status==='complete' && (await rt()).tabSnapshots[fresh.id]?.url==='__BASE__/Typed-search-result');
    ok(!(await rt()).tabParent[fresh.id],'a normal New Tab remains a root after entering a URL or searching');
    await chrome.tabs.update(control,{active:true});
    await wait(()=>document.querySelector(`[data-kind=tab][data-id="${fresh.id}"]`));
    ok(document.querySelector(`[data-kind=tab][data-id="${fresh.id}"]`).dataset.treeDepth==='0','the looked-up New Tab is shown at the top level');
    const link=await chrome.tabs.create({windowId:W,url:'__BASE__/Link-result',openerTabId:parent,active:false});
    await wait(async()=> (await rt()).tabParent[link.id]===parent);
    ok(true,'tabs opened directly from links still become children');
    const explicit=await send('newChildTab',{tabId:parent});
    await chrome.tabs.update(explicit,{url:'__BASE__/Explicit-child-result'});
    await wait(async()=> (await chrome.tabs.get(explicit)).status==='complete' && (await rt()).tabParent[explicit]===parent);
    ok(!(await rt()).treeDetached[explicit],'New child tab keeps its explicit parent after lookup');
    const manual=await chrome.tabs.create({windowId:W,url:'chrome://newtab/',openerTabId:parent,active:false});
    await wait(async()=> (await rt()).treeDetached[manual.id]===true);
    await send('setTabParent',{tabId:manual.id,parentId:parent});
    await chrome.tabs.update(manual.id,{url:'__BASE__/Manually-nested'});
    await wait(async()=> (await chrome.tabs.get(manual.id)).status==='complete');
    ok((await rt()).tabParent[manual.id]===parent && !(await rt()).treeDetached[manual.id],'explicitly nesting a blank tab overrides root intent');
    await chrome.storage.local.set({__newTabTreeExpect:{root:fresh.id,parent,explicit,manual:manual.id}});
  }catch(error){log.push('FAIL '+error.stack);}
  return log.join('\n');
})()
