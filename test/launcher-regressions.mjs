// Remaining search behavior, exercised in upstream's isolated launcher (overlay and fallback).
export async function run({ cdp, sessionId: control, base }) {
  const log = [];
  const ok = (pass, label) => { log.push(`${pass ? 'PASS' : 'FAIL'} ${label}`); if (process.env.TRACE) console.log(log.at(-1)); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function ev(session, expression) {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  const api = expression => ev(control, expression);
  const send = (type, payload = {}) => api(`chrome.runtime.sendMessage(${JSON.stringify({ type, ...payload })}).then(r => { if (!r.ok) throw new Error(r.error); return r.result; })`);
  const rt = () => api("chrome.storage.session.get('rt').then(r => r.rt)");
  const cfg = () => api("chrome.storage.local.get('config').then(r => r.config)");
  async function wait(fn, label) {
    for (let i = 0; i < 120; i++) { if (await fn()) return; await sleep(60); }
    throw new Error('Timed out: ' + label);
  }
  async function attach(url) {
    let target;
    await wait(async () => { target = (await cdp('Target.getTargets')).targetInfos.find(t => t.url === url); return target; }, url);
    return (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  }
  let W;
  async function open(source) {
    await api(`chrome.tabs.update(${source}, {active:true})`);
    await send('openSearch', { windowId: W });
    let entry;
    await wait(async () => { entry = Object.entries((await rt()).searches).find(([, s]) => s.windowId === W); return entry; }, 'search session');
    let launcher;
    await wait(async () => { launcher = (await cdp('Target.getTargets')).targetInfos.find(t => t.url.includes('launcher.html') && t.url.includes(entry[0])); return launcher; }, 'launcher target');
    const frame = (await cdp('Target.attachToTarget', { targetId: launcher.targetId, flatten: true })).sessionId;
    await wait(() => ev(frame, "document.querySelectorAll('[role=option]').length > 0").catch(() => false), 'results');
    return { frame, token: entry[0], ...entry[1] };
  }
  async function query(frame, text) {
    await ev(frame, `(() => { const i=document.querySelector('#search'); i.value=${JSON.stringify(text)}; i.dispatchEvent(new Event('input')); })()`);
    await sleep(100);
  }
  const rows = frame => ev(frame, "[...document.querySelectorAll('[role=option]')].map(n=>({label:n.querySelector('.result-title').textContent,badge:n.querySelector('.result-kind').textContent,icon:n.querySelector('img')?.src}))");
  async function close({ frame, token }) {
    await ev(frame, `void chrome.runtime.sendMessage({type:'launcherClose',token:${JSON.stringify(token)}}); true`);
    await wait(async () => !(await rt()).searches[token], 'close');
  }
  async function key(frame, key) {
    for (const type of ['keyDown','keyUp']) await cdp('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 13 }, frame);
  }
  try {
    W = await api('chrome.windows.getCurrent().then(w=>w.id)');
    const controller = await api('chrome.tabs.getCurrent().then(t=>t.id)');
    await send('pinTab', {tabId:controller,spaceId:null});
    const main = (await cfg()).spaces[0].id;
    const folder = await send('createFolder', {spaceId:main,name:'Outer'});
    const nested = await send('createFolder', {spaceId:main,parentId:folder,name:'Inner'});
    const pinned = await send('newTab',{windowId:W,spaceId:main,url:base+'/ranking-pin'});
    await wait(()=>api(`chrome.tabs.get(${pinned}).then(t=>t.status==='complete')`),'pin load');
    await send('pinTab',{tabId:pinned,spaceId:main,folderId:nested});
    const pinId=(await rt()).tabPin[pinned];
    await send('renamePin',{pinId,title:'Ranking document'});
    const other=await send('createSpace',{name:'Other'});
    const foreign=await send('newTab',{windowId:W,spaceId:other,url:base+'/foreign'});
    await send('pinTab',{tabId:foreign,spaceId:other});
    const foreignId=(await rt()).tabPin[foreign];
    await send('renamePin',{pinId:foreignId,title:'Ranking foreign'});
    const source=await send('newTab',{windowId:W,spaceId:main,url:base+'/ranking-source'});
    await wait(()=>api(`chrome.tabs.get(${source}).then(t=>t.status==='complete')`),'source load');
    const page=await attach(base+'/ranking-source');
    const histories=Array.from({length:7},(_,i)=>({id:String(i),url:`https://known${i}.example/`,title:`Ranking known ${i}`,visitCount:10+i,lastVisitTime:Date.now()}));
    await api(`Promise.all(${JSON.stringify(histories)}.map(e=>chrome.history.addUrl({url:e.url})))`);
    let session=await open(source);
    await query(session.frame,'Ranking');
    let found=await rows(session.frame);
    ok(found[1]?.badge==='Search web' && found.some(r=>r.label==='Ranking document') && !found.some(r=>r.label==='Ranking foreign'),'search reserves row two and scopes pins to the current space');
    ok(!found.some(r=>r.badge==='Switch to tab' && r.label.includes('ranking-source')) && found.find(r=>r.label==='Ranking document')?.badge==='Switch to tab','ordinary tabs are not switch results; open folder pins are');
    await query(session.frame,'known'); found=await rows(session.frame);
    ok(found.some(r=>r.badge==='History' && r.icon?.includes('_favicon/')),'known history pages have site icons');
    ok(await ev(session.frame,"(() => {const r=document.querySelector('#results');return r.children.length>4 && r.scrollHeight>r.clientHeight && r.clientHeight<=256;})()"),'four visible rows scroll to additional results');
    await close(session);
    await send('updateFolder',{folderId:folder,collapsed:true});
    await send('updateFolder',{folderId:nested,collapsed:true});
    session=await open(source); await query(session.frame,'Ranking document');
    await ev(session.frame,"document.querySelector('[role=option]').click()");
    await wait(()=>api(`chrome.tabs.get(${pinned}).then(t=>t.active)`),'switch pin');
    ok(!(await cfg()).folders[folder].collapsed && !(await cfg()).folders[nested].collapsed,'search activates the saved pin and expands all its folder ancestors');
    ok((await api(`chrome.tabs.query({windowId:${W}})`)).filter(t=>(t.url||t.pendingUrl)===base+'/ranking-pin').length===1,'switching a folder pin does not duplicate its live tab');
    // A trusted sidebar click selects the page, then the launcher must take keyboard focus.
    await api(`chrome.tabs.update(${controller},{active:true})`);
    await wait(()=>api(`!!document.querySelector('#tabs [data-id="${source}"]')`),'sidebar row');
    const rect=await api(`(() => { const r=document.querySelector('#tabs [data-id="${source}"] .title').getBoundingClientRect(); return {x:r.x+Math.min(20,r.width/2),y:r.y+r.height/2}; })()`);
    for(const type of ['mousePressed','mouseReleased']) await cdp('Input.dispatchMouseEvent',{type,...rect,button:'left',clickCount:1},control);
    await wait(()=>api(`chrome.tabs.get(${source}).then(t=>t.active)`),'sidebar selects source');
    session=await open(source);
    await wait(()=>ev(session.frame,"document.hasFocus() && document.activeElement===document.querySelector('#search')"),'launcher focus after sidebar click');
    await cdp('Input.insertText',{text:'focus query'},session.frame);
    ok(await ev(session.frame,"document.querySelector('#search').value==='focus query'"),'sidebar-to-search handoff sends real typing into the search input');
    await key(session.frame,'Escape');
    ok(await ev(session.frame,"document.querySelector('#search').value===''") ,'Escape clears the query');
    await ev(session.frame,"document.querySelector('#search').blur()");
    await key(session.frame,'Escape');
    await wait(()=>ev(page,"!document.querySelector('cove-search')"),'Escape dismissal');
    ok(true,'Escape also dismisses the overlay when the input loses focus');
    // Explicit web search must replay exactly, even for text recognized as a URL.
    const restricted=await send('newTab',{windowId:W,spaceId:main,url:'chrome://version'});
    session=await open(restricted); await query(session.frame,'localhost');
    const index=(await rows(session.frame)).findIndex(r=>r.badge==='Search web');
    await ev(session.frame,`document.querySelectorAll('[role=option]')[${index}].click()`);
    await wait(()=>api(`chrome.tabs.query({windowId:${W},active:true}).then(t=>{try{return new URL(t[0].pendingUrl||t[0].url).searchParams.get('q')==='localhost'}catch{return false}})`),'fallback search query');
    ok(true,'fallback explicit search preserves localhost as search text');
    session=await open(source); await query(session.frame,'local');
    const recent=(await rows(session.frame)).findIndex(r=>r.badge==='Recent search' && r.label==='localhost');
    ok(recent>=0,'fallback queries are available in floating recent searches');
    await ev(session.frame,`document.querySelectorAll('[role=option]')[${recent}].click()`);
    await wait(()=>api(`chrome.tabs.query({windowId:${W},active:true}).then(t=>{try{return new URL(t[0].pendingUrl||t[0].url).searchParams.get('q')==='localhost'}catch{return false}})`),'recent query replay');
    ok(true,'recent search replay keeps its search intent instead of navigating to localhost');
    // Empty-space search cannot switch back to the underlying source tab's previous space.
    await api(`chrome.tabs.update(${restricted},{active:true})`);
    const empty=await send('createSpace',{windowId:W,name:'Empty search space'});
    await send('openSearch',{windowId:W});
    let fallback;
    await wait(async()=>{fallback=Object.values((await rt()).searches).find(s=>s.windowId===W);return fallback?.launcherTabId;},'empty-space fallback');
    ok((await rt()).activeSpace[W]===empty && (await rt()).tabSpace[fallback.launcherTabId]===empty,'restricted-page search stays in the selected empty space');
  } catch (error) { log.push('FAIL '+error.stack); }
  return log.join('\n');
}
