(async()=>{
  const log=[];const ok=(pass,label)=>log.push(`${pass?'PASS':'FAIL'} ${label}`);
  const send=async(type,payload={})=>{const r=await chrome.runtime.sendMessage({type,...payload});if(!r.ok)throw new Error(r.error);return r.result;};
  const wait=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,60));}throw new Error('Timed out waiting for Essential hash drift');};
  try {
    const windowId=(await chrome.windows.getCurrent()).id;
    const {config}=await chrome.storage.local.get('config');const spaceId=config.spaces[0].id;
    const tabId=await send('newTab',{windowId,spaceId,url:'__BASE__/mail#inbox'});
    await wait(async()=>(await chrome.tabs.get(tabId)).status==='complete');
    await send('pinTab',{tabId,spaceId:null});
    const pinId=(await chrome.storage.session.get('rt')).rt.tabPin[tabId];
    await chrome.tabs.update(tabId,{url:'__BASE__/mail#email/123'});
    await wait(async()=>(await chrome.storage.local.get('config')).config.pins[pinId].lastUrl==='__BASE__/mail#email/123');
    await send('openPin',{windowId,pinId});
    await wait(async()=>(await chrome.tabs.get(tabId)).url==='__BASE__/mail#inbox');
    ok(true,'reclicking an Essential after a Gmail-style hash-only navigation returns to its pinned inbox');
    ok((await chrome.storage.local.get('config')).config.settings.peekFromEssentials===true,'hash drift keeps the default Essential Peek preference');
    document.querySelector('#settings').click();
    await wait(()=>document.querySelector('input[name=peekFromEssentials]'));
    const toggle=document.querySelector('input[name=peekFromEssentials]');
    ok(toggle.checked,'the Essential Peek toggle remains present and enabled');
    toggle.click();
    await wait(async()=>(await chrome.storage.local.get('config')).config.settings.peekFromEssentials===false);
    ok(true,'the Essential Peek setting remains editable');
  }catch(error){log.push('FAIL '+error.stack);}
  return log.join('\n');
})()
