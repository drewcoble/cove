(async()=>{
  const log=[];
  const ok=(pass,label)=>log.push(`${pass?'PASS':'FAIL'} ${label}`);
  const send=async(type,payload={})=>{const r=await chrome.runtime.sendMessage({type,...payload});if(!r.ok)throw new Error(r.error);return r.result;};
  const state=async()=>(await chrome.storage.session.get('rt')).rt;
  const wait=async fn=>{for(let i=0;i<120;i++){if(await fn())return;await new Promise(r=>setTimeout(r,60));}throw new Error('Timed out waiting for confirmed link source');};
  try {
    const windowId=(await chrome.windows.getCurrent()).id;
    const controller=(await chrome.tabs.getCurrent()).id;
    await send('pinTab',{tabId:controller,spaceId:null});
    const {config}=await chrome.storage.local.get('config');const spaceId=config.spaces[0].id;
    const parent=await send('newTab',{windowId,spaceId,url:'__BASE__/external-source'});
    await wait(async()=>(await chrome.tabs.get(parent)).status==='complete');
    // Same browser condition as an app launch: misleading opener, no renderer source event.
    const external=await chrome.tabs.create({windowId,openerTabId:parent,url:'__BASE__/from-other-app',active:true});
    await wait(async()=>{const rt=await state();return rt.tabSpace[external.id] && (await chrome.tabs.get(external.id)).status==='complete';});
    ok(!(await state()).tabParent[external.id],'an external-app tab stays a root despite its misleading opener ID');
    await chrome.tabs.update(external.id,{url:'__BASE__/external-navigation'});
    await wait(async()=>(await chrome.tabs.get(external.id)).status==='complete');
    ok(!(await state()).tabParent[external.id],'later navigation does not adopt the unrelated opener');
    await send('pinTab',{tabId:parent,spaceId:null});
    const essentialExternal=await chrome.tabs.create({windowId,openerTabId:parent,url:'__BASE__/external-from-essential',active:true});
    await wait(async()=>{const rt=await state();return rt.tabSpace[essentialExternal.id] && (await chrome.tabs.get(essentialExternal.id)).status==='complete';});
    ok(!(await state()).tabParent[essentialExternal.id],'an external link with an Essential as opener also stays a root');
    await chrome.scripting.executeScript({target:{tabId:parent},func:url=>{const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener';document.body.append(a);a.click();a.remove();},args:['__BASE__/real-noopener-link']});
    let linked;
    await wait(async()=>{linked=(await chrome.tabs.query({windowId})).find(t=>t.url==='__BASE__/real-noopener-link'||t.pendingUrl==='__BASE__/real-noopener-link');return linked && (await state()).tabParent[linked.id]===parent;});
    ok((await state()).tabParent[linked.id]===parent,'a confirmed page link nests under its source even with rel=noopener');
    await chrome.tabs.update(controller,{active:true});
    await wait(()=>document.querySelector(`[data-kind=tab][data-id="${external.id}"]`));
    ok(document.querySelector(`[data-kind=tab][data-id="${external.id}"]`).dataset.treeDepth==='0','the sidebar renders the external tab at the top level');
    await chrome.storage.local.set({__externalLinkTree:{external:external.id,essentialExternal:essentialExternal.id,linked:linked.id,parent}});
  }catch(error){log.push('FAIL '+error.stack);}
  return log.join('\n');
})()
