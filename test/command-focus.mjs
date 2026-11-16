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
    const main=(await config()).spaces[0].id;
    const W=await api('chrome.windows.getCurrent().then(w=>w.id)');
    const controller=await api('chrome.tabs.getCurrent().then(t=>t.id)');
    const first=await send('newTab',{windowId:W,spaceId:main,url:base+'/focus-first'});
    await wait(async()=> (await tab(first))?.status==='complete');
    const firstSession=await attach('/focus-first');
    const second=await send('newTab',{windowId:W,spaceId:main,url:base+'/focus-second'});
    await wait(async()=> (await tab(second))?.status==='complete');
    const secondSession=await attach('/focus-second');
    await api(`chrome.tabs.update(${controller},{active:true})`);
    await open(first,firstSession);
    ok((await tab(first)).active && await panel(firstSession,"return document.hasFocus() && root.activeElement===root.querySelector('#search')"),'opening from an extension-focused surface transfers actual keyboard focus to the page and search input');
    await cdp('Input.insertText',{text:'first query'},firstSession);
    await sleep(100);
    await cdp('Input.insertText',{text:' continued'},firstSession);
    ok(await panel(firstSession,"return root.querySelector('#search').value==='first query continued'"),'deferred focus does not select or overwrite newly typed text');
    await api(`chrome.tabs.update(${second},{active:true})`);
    await closed(firstSession);
    await wait(async()=>!(await runtime()).commandSessions[first]);
    ok(true,'switching away removes the old panel and revokes its session');
    await key(secondSession,'k',4);
    await wait(()=>panel(secondSession,"return !!root.querySelector('[role=option]')").catch(()=>false));
    ok(await panel(secondSession,"return document.hasFocus() && root.activeElement===root.querySelector('#search')"),'Command+K after switching tabs focuses search');
    await key(secondSession,'Escape'); await closed(secondSession);
    ok(true,'Escape dismisses the panel after switching tabs');
    await api(`chrome.tabs.update(${first},{active:true})`);
    await key(firstSession,'k',4);
    await wait(()=>panel(firstSession,"return !!root.querySelector('[role=option]')").catch(()=>false));
    ok(await panel(firstSession,"return root.querySelector('#search').value==='' && root.activeElement===root.querySelector('#search')"),'returning to a tab opens a fresh focused panel');
    await panel(firstSession,"const d=root.querySelector('dialog');d.tabIndex=-1;d.focus();return true");
    await key(firstSession,'Escape');await closed(firstSession);
    ok(true,'Escape closes the panel even when the search input has lost focus');
    for(let i=0;i<3;i++) {
      const id=i%2?second:first, session=i%2?secondSession:firstSession;
      await api(`chrome.tabs.update(${controller},{active:true})`);
      await open(id,session);
      ok(await panel(session,"return document.hasFocus() && root.activeElement===root.querySelector('#search')"),`repeated sidebar-style handoff ${i+1} focuses the correct tab`);
      await key(session,'Escape');await closed(session);
    }
    const target = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/src/newtab.html` });
    const fallbackSession = (await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await wait(() => evaluate(fallbackSession, "!!document.querySelector('[role=option]')").catch(() => false));
    const fallbackId = await evaluate(fallbackSession, 'chrome.tabs.getCurrent().then(t=>t.id)');
    await evaluate(fallbackSession, "document.querySelector('#search').blur()");
    await api(`chrome.tabs.update(${controller},{active:true})`);
    await send('openCommandOverlay',{tabId:fallbackId});
    await wait(()=>evaluate(fallbackSession,"document.hasFocus() && document.activeElement===document.querySelector('#search')"));
    ok(true,'standalone fallback also receives actual keyboard focus from an extension surface');
    await key(fallbackSession,'Escape');
    await wait(async()=>!(await tab(fallbackId)));
    ok(true,'Escape dismisses the refocused standalone fallback');
  }catch(error){log.push('FAIL '+error.stack);}
  return log.join('\n');
}
