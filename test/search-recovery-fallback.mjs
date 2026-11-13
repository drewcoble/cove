export async function run({ cdp, sessionId: control, extId, base }) {
  const log = [];
  const ok = (condition, message) => log.push(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = async (session, expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const api = expression => evaluate(control, expression);
  const send = (type, payload = {}) => api(`chrome.runtime.sendMessage(${JSON.stringify({ type, ...payload })}).then(r => { if (!r.ok) throw new Error(r.error); return r.result; })`);
  const config = () => api("chrome.storage.local.get('config').then(r => r.config)");
  const runtime = () => api("chrome.storage.session.get('rt').then(r => r.rt)");
  const tab = id => api(`chrome.tabs.get(${id}).catch(() => null)`);
  const wait = async predicate => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await sleep(60); }
    throw new Error('Timed out waiting for recovery/fallback state');
  };
  try {
    const main = (await config()).spaces[0].id;
    const W = await api('chrome.windows.getCurrent().then(w => w.id)');
    const sourceId = await send('newTab', { windowId: W, spaceId: main, url: base + '/review-source' });
    await wait(async () => (await tab(sourceId))?.status === 'complete');
    await send('pinTab', { tabId: sourceId, spaceId: null });
    const folder = await send('createFolder', { spaceId: main, name: 'Views' });
    const pins = [];
    for (const name of ['dashboard', 'reports']) {
      const id = await send('newTab', { windowId: W, spaceId: main, url: base + '/app#/' + name });
      await wait(async () => (await tab(id))?.status === 'complete');
      await send('pinTab', { tabId: id, spaceId: main, folderId: folder });
      const pinId = (await runtime()).tabPin[id];
      await send('renamePin', { pinId, title: name }); pins.push({ id, pinId, name });
    }
    await api(`chrome.tabs.move(${pins[1].id}, { index: ${(await tab(pins[0].id)).index} })`);
    await api(`chrome.tabs.update(${sourceId}, { active: true })`);
    await send('updateFolder', { folderId: folder, collapsed: true });
    await api("chrome.storage.session.remove('rt')");
    await cdp('Extensions.loadUnpacked', { path: new URL('../', import.meta.url).pathname });
    const fresh = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/src/sidepanel.html` });
    control = (await cdp('Target.attachToTarget', { targetId: fresh.targetId, flatten: true })).sessionId;
    await wait(async () => { try { return (await runtime())?.initialized; } catch { return false; } });
    for (const pin of pins) {
      const boundId = Object.entries((await runtime()).tabPin).find(([, id]) => id === pin.pinId)?.[0];
      ok(boundId && (await tab(+boundId)).url.endsWith('#/' + pin.name), `fresh session retains the ${pin.name} folder pin despite native tab reordering`);
    }
    await send('openPin', {windowId:W,pinId:pins[0].pinId,reset:false});
    ok((await api(`chrome.tabs.query({windowId:${W},active:true}).then(t=>t[0].url)`)).endsWith('#/dashboard'), 'opening the recovered Dashboard pin activates its own route');
    ok(!(await config()).folders[folder].collapsed, 'opening a recovered pin reveals its folder');
    // Inspect the restricted-page fallback in the same selected space.
    const other = await send('createSpace',{name:'Other space'});
    const otherId = await send('newTab',{windowId:W,spaceId:other,url:base+'/foreign-only-tab'});
    await wait(async()=> (await tab(otherId))?.status==='complete');
    await send('switchSpace',{windowId:W,spaceId:main});
    const native = await api(`chrome.tabs.create({windowId:${W},url:'chrome://newtab/',active:true})`);
    await send('openCommandOverlay',{tabId:native.id});
    await wait(async()=> (await cdp('Target.getTargets')).targetInfos.some(t=>t.url.includes('/src/newtab.html')));
    const target = (await cdp('Target.getTargets')).targetInfos.find(t=>t.url.includes('/src/newtab.html'));
    const session = (await cdp('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
    await wait(()=>evaluate(session, "!!document.querySelector('[role=option]')").catch(()=>false));
    await evaluate(session, "var input = document.querySelector('#search'); input.value='foreign-only-tab'; input.dispatchEvent(new Event('input',{bubbles:true}));");
    ok(await evaluate(session, "![...document.querySelectorAll('[role=option]')].some(n => n.dataset.kind === 'tab')"), 'native New Tab fallback excludes ordinary tabs from other spaces');
    ok(await evaluate(session, "document.querySelectorAll('[role=option]')[1]?.dataset.kind === 'search'"), 'native New Tab fallback keeps web search second');
    await evaluate(session, "var input = document.querySelector('#search'); input.value='dashboard'; input.dispatchEvent(new Event('input',{bubbles:true}));");
    ok(await evaluate(session, `document.querySelector('[role=option]').dataset.key === ${JSON.stringify('pin-' + pins[0].pinId)}`), 'fallback suggests recovered current-space folder pins');
    const parity = await evaluate(session, `(async () => {
      const { rankSearch } = await import('./search-ranking.js');
      const { searchCatalog } = await import('./search-catalog.js');
      const tab = await chrome.tabs.getCurrent();
      const response = await chrome.runtime.sendMessage({type:'newTabSearchContext',tabId:tab.id});
      const data = response.result;
      const items = searchCatalog({...data,mode:'all',root:chrome.runtime.getURL(''),spacePinsOnly:true});
      const expected = rankSearch({items,history:data.history,memory:data.memory,query:'dashboard',spaceId:data.spaceId});
      return JSON.stringify(expected.map(n=>n.key)) === JSON.stringify([...document.querySelectorAll('[role=option]')].map(n=>n.dataset.key));
    })()`);
    ok(parity, 'fallback result order equals the floating panel ranking model');
    const fallbackId = await evaluate(session,'chrome.tabs.getCurrent().then(t=>t.id)');
    const denied = await api(`chrome.scripting.executeScript({target:{tabId:${sourceId}},func:async(id)=>chrome.runtime.sendMessage({type:'newTabSearchContext',tabId:id}),args:[${fallbackId}]}).then(r=>r[0].result)`);
    ok(denied == null, 'content scripts cannot request the fallback history/configuration context');
    // A domain in the second row must search, rather than navigate to the domain.
    await evaluate(session, "var input = document.querySelector('#search'); input.value='example.com'; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelectorAll('[role=option]')[1].click();");
    await wait(async()=> /[?&]q=example/.test((await tab(fallbackId))?.pendingUrl || (await tab(fallbackId))?.url || ''));
    ok(true, 'second-row search treats a domain as a search query');
    await wait(() => api("chrome.storage.local.get('searchMemory').then(r => r.searchMemory?.searches?.some(e => e.text === 'example.com'))"));
    ok(true, 'fallback submissions are saved to the shared local recent searches');
    await api(`chrome.tabs.update(${pins[0].id},{active:true})`);
    const againNative = await api(`chrome.tabs.create({windowId:${W},url:'chrome://newtab/',active:true})`);
    await send('openCommandOverlay',{tabId:againNative.id});
    const pages = (await cdp('Target.getTargets')).targetInfos;
    const again = pages.find(t=>t.url.includes('/src/newtab.html'));
    const againSession = (await cdp('Target.attachToTarget',{targetId:again.targetId,flatten:true})).sessionId;
    await wait(()=>evaluate(againSession,"!!document.querySelector('[role=option]')").catch(()=>false));
    ok(await evaluate(againSession, "[...document.querySelectorAll('.result-kind')].some(n => n.textContent === 'Recent search')"), 'fallback reload displays the shared recent searches');
    await evaluate(againSession,"var input=document.querySelector('#search');input.value='dashboard';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[role=option]').click();");
    await wait(async()=> (await tab(pins[0].id))?.active);
    ok((await tab(pins[0].id)).url.endsWith('#/dashboard'), 'fallback activates the correct existing folder pin after recovery');

  } catch(error) {log.push('FAIL '+error.stack);}
  return log.join('\n');
}
