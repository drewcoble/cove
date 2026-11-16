export async function run({ cdp, sessionId: control, base, extId }) {
  const log = [];
  const ok = (condition, message) => { log.push(`${condition ? 'PASS' : 'FAIL'} ${message}`); if (process.env.TRACE) console.log(log.at(-1)); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function evaluate(session, expression) {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  const api = expression => evaluate(control, expression);
  const send = (type, payload = {}) => api(`chrome.runtime.sendMessage(${JSON.stringify({ type, ...payload })}).then(r => { if (!r.ok) throw new Error(r.error); return r.result; })`);
  const config = () => api("chrome.storage.local.get('config').then(r => r.config)");
  const runtime = () => api("chrome.storage.session.get('rt').then(r => r.rt)");
  const tab = id => api(`chrome.tabs.get(${id}).catch(() => null)`);
  const wait = async predicate => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await sleep(60); }
    throw new Error('Timed out waiting for overlay/browser state');
  };
  async function attach(path) {
    const { targetInfos } = await cdp('Target.getTargets');
    const target = targetInfos.find(t => t.type === 'page' && t.url.includes(path));
    if (!target) throw new Error('Missing target: ' + path);
    return (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  }
  async function panel(session, code) {
    const { root } = await cdp('DOM.getDocument', { depth: -1, pierce: true }, session);
    const find = node => {
      if (node.nodeName === 'COVE-COMMAND') return node;
      for (const child of node.children || []) { const match = find(child); if (match) return match; }
    };
    const host = find(root);
    if (!host?.shadowRoots?.[0]) return null;
    const { object } = await cdp('DOM.resolveNode', { nodeId: host.shadowRoots[0].nodeId }, session);
    const result = await cdp('Runtime.callFunctionOn', {
      objectId: object.objectId, functionDeclaration: `function() { const root = this; ${code} }`, returnByValue: true, awaitPromise: true,
    }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  const search = (session, text) => panel(session, `const input = root.querySelector('#search'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true, composed: true })); return root.querySelectorAll('[role=option]').length;`);
  async function key(session, value, modifiers = 0) {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value.length === 1 ? 'Key' + value.toUpperCase() : value, modifiers, windowsVirtualKeyCode: value === 'Enter' ? 13 : value === 'Escape' ? 27 : value.toUpperCase().charCodeAt(0) }, session);
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value.length === 1 ? 'Key' + value.toUpperCase() : value, modifiers }, session).catch(() => {});
  }
  const open = async (id, session) => {
    await send('openCommandOverlay', { tabId: id });
    await wait(() => panel(session, "return !!root.querySelector('[role=option]');").catch(() => false));
  };
  const closed = session => wait(() => evaluate(session, "!document.querySelector('cove-command')"));
  try {
    const main = (await config()).spaces[0].id;
    const W = await api('chrome.windows.getCurrent().then(w=>w.id)');
    const sourceId = await send('newTab',{windowId:W,spaceId:main,url:base+'/query-replay-source'});
    await wait(async()=> (await tab(sourceId))?.status==='complete');
    const source = await attach('/query-replay-source');
    const fallbackUrl = `chrome-extension://${extId}/src/newtab.html`;
    const first = await api(`chrome.tabs.create({windowId:${W},url:${JSON.stringify(fallbackUrl)},active:true})`);
    await send('navigateNewTab',{tabId:first.id,text:'localhost',forceSearch:true});
    await wait(()=>api("chrome.storage.local.get('searchMemory').then(r=>r.searchMemory?.searches?.some(e=>e.text==='localhost'))"));
    ok(true,'fallback remembers the exact localhost search instead of converting it to a URL');
    await api(`chrome.tabs.update(${sourceId},{active:true})`);
    await open(sourceId,source);
    await search(source,'local');
    const index=await panel(source,"return [...root.querySelectorAll('[role=option]')].findIndex(n=>n.querySelector('.result-kind').textContent==='Recent search' && n.querySelector('.result-title').textContent==='localhost')");
    ok(index>=0,'floating search finds the exact recent query submitted through the fallback');
    if(index<0)throw new Error('Missing recent query');
    for(let i=0;i<index;i++)await key(source,'ArrowDown');
    await key(source,'Enter'); await closed(source);
    let active = await api(`chrome.tabs.query({windowId:${W},active:true}).then(t=>t[0])`);
    ok(new URL(active.pendingUrl||active.url).searchParams.get('q')==='localhost','floating replay submits the original localhost query');
    await api(`chrome.tabs.update(${sourceId},{active:true})`);
    await open(sourceId,source);
    await search(source,'Example.COM');
    await key(source,'ArrowDown'); await key(source,'Enter'); await closed(source);
    active=await api(`chrome.tabs.query({windowId:${W},active:true}).then(t=>t[0])`);
    ok(new URL(active.pendingUrl||active.url).searchParams.get('q')==='Example.COM','floating search submits the original domain spelling');
    const created=await cdp('Target.createTarget',{url:fallbackUrl});
    const {sessionId}=await cdp('Target.attachToTarget',{targetId:created.targetId,flatten:true});
    await wait(()=>evaluate(sessionId,"[...document.querySelectorAll('.result')].some(n=>n.querySelector('.result-kind')?.textContent==='Recent search' && n.querySelector('.result-title').textContent==='Example.COM')").catch(()=>false));
    const fallbackId=await evaluate(sessionId,'chrome.tabs.getCurrent().then(t=>t.id)');
    await evaluate(sessionId,"[...document.querySelectorAll('.result')].find(n=>n.querySelector('.result-kind')?.textContent==='Recent search' && n.querySelector('.result-title').textContent==='Example.COM').click()");
    await wait(async()=> new URL((await tab(fallbackId))?.pendingUrl||(await tab(fallbackId))?.url).searchParams.get('q')==='Example.COM');
    ok(true,'fallback replay submits the exact query saved by floating search');
    // Normalizing existing memory on worker startup must not rewrite the new query text.
    await cdp('Extensions.loadUnpacked',{path:new URL('../',import.meta.url).pathname});
    const fresh=await cdp('Target.createTarget',{url:`chrome-extension://${extId}/src/sidepanel.html`});
    control=(await cdp('Target.attachToTarget',{targetId:fresh.targetId,flatten:true})).sessionId;
    await wait(async()=>{try{return await api("chrome.storage.session.get('rt').then(r=>r.rt?.initialized)");}catch{return false;}});
    const queries=await api("chrome.storage.local.get('searchMemory').then(r=>r.searchMemory.searches.map(e=>e.text))");
    ok(queries.includes('localhost')&&queries.includes('Example.COM'),'recent queries retain their exact text after extension reload');
  } catch(error){log.push('FAIL '+error.stack);}
  return log.join('\n');
}
