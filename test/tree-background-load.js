(async()=>{
  const log=[];const ok=(pass,label)=>log.push(`${pass?'PASS':'FAIL'} ${label}`);
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const wait=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await sleep(60);}throw new Error('Timed out waiting for tree persistence');};
  const send=async(type,payload={})=>{const r=await chrome.runtime.sendMessage({type,...payload});if(!r.ok)throw new Error(r.error);return r.result;};
  try {
    const windowId=(await chrome.windows.getCurrent()).id;
    const controller=(await chrome.tabs.getCurrent()).id;
    await send('pinTab',{tabId:controller,spaceId:null});
    const {config}=await chrome.storage.local.get('config');const spaceId=config.spaces[0].id;
    ok(config.settings.peekFromEssentials===true,'Essential Peek remains enabled by default');
    const parent=await send('newTab',{windowId,spaceId,url:'__BASE__/tree-load-parent'});
    const child=await send('newChildTab',{tabId:parent});
    await chrome.tabs.update(child,{url:'__BASE__/tree-load-child'});
    await wait(async()=>(await chrome.tabs.get(child)).status==='complete' && (await chrome.tabs.get(parent)).status==='complete');
    await chrome.tabs.update(controller,{active:true});
    await wait(async()=>(await chrome.storage.local.get('tabTreeState')).tabTreeState?.parents[child]===parent);
    await sleep(900);
    const counts={tree:0,rt:0};
    const observe=(changes,area)=>{if(area==='local'&&changes.tabTreeState)counts.tree++;if(area==='session'&&changes.rt)counts.rt++;};
    chrome.storage.onChanged.addListener(observe);
    await chrome.scripting.executeScript({target:{tabId:child},func:()=>{for(let i=0;i<20;i++)history.pushState({},'',`/tree-load-child/route-${i}?view=${i}#section`);}});
    await sleep(900);
    ok(counts.tree===0 && counts.rt===0,'twenty unpinned SPA URL changes enqueue no runtime saves or local tree writes');
    await chrome.tabs.update(parent,{active:true});await sleep(100);
    await chrome.tabs.update(child,{active:true});await sleep(100);
    await chrome.tabs.update(controller,{active:true});await sleep(700);
    ok(counts.rt>0 && counts.tree===0,'tab switches update MRU without rewriting unchanged local tree state');
    counts.tree=0;
    for(let i=0;i<5;i++)await send('toggleTabTree',{windowId,tabId:parent,spaceId});
    await sleep(800);
    ok(counts.tree===1,'a burst of tree changes produces one debounced local tree write');
    const tree=(await chrome.storage.local.get('tabTreeState')).tabTreeState;
    ok(!JSON.stringify(tree).includes('http') && Object.values(tree.identities).every(x=>!('url' in x)),'persisted tree identities contain window ids, never browsing URLs');
    await chrome.tabs.update(child,{url:'__BASE__/tree-load-child/another-document'});
    await wait(async()=>(await chrome.tabs.get(child)).status==='complete');
    await sleep(500);
    ok(counts.tree===1,'full-page navigation also leaves the saved tree untouched');
    chrome.storage.onChanged.removeListener(observe);
    await chrome.tabs.update(parent,{active:true});
    await wait(async()=>(await chrome.storage.session.get('rt')).rt.mru[windowId][0]===parent);
    await chrome.storage.local.set({__treeLoad:{parent,child,spaceId}});
  }catch(error){log.push('FAIL '+error.stack);}
  return log.join('\n');
})()
