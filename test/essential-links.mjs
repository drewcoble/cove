export async function run({ cdp, sessionId: control, base }) {
  const log = [];
  const ok = (condition, message) => log.push(`${condition ? 'PASS' : 'FAIL'} ${message}`);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ev = async (session, expression) => {
    const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const api = expression => ev(control, expression);
  const send = (type, payload = {}) => api(`chrome.runtime.sendMessage(${JSON.stringify({ type, ...payload })}).then(r => { if (!r.ok) throw new Error(r.error); return r.result })`);
  const rt = () => api("chrome.storage.session.get('rt').then(r => r.rt)");
  const tab = id => api(`chrome.tabs.get(${id}).catch(() => null)`);
  const wait = async predicate => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await sleep(60); } throw new Error('Timed out waiting for link/browser state'); };
  const click = async (session, selector, modifiers = 0, button = 'left') => {
    const { x, y } = await ev(session, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x, y, modifiers, button, clickCount: 1 }, session);
  };
  try {
    const W = await api('chrome.windows.getCurrent().then(w => w.id)');
    const main = await api("chrome.storage.local.get('config').then(r => r.config.spaces[0].id)");
    const essential = await send('newTab', { windowId: W, spaceId: main, url: base + '/essential-links' });
    await wait(async () => (await tab(essential))?.status === 'complete');
    await send('pinTab', { tabId: essential, spaceId: null });
    const pinId = (await rt()).tabPin[essential];
    const space = await send('createSpace', { windowId: W, name: 'Current work' });
    await send('newTab', { windowId: W, spaceId: space, url: base + '/work' });
    await api(`chrome.tabs.update(${essential}, {active:true})`);
    await wait(() => api(`chrome.scripting.executeScript({ target:{tabId:${essential}}, func:()=>globalThis.__coveEssential === true }).then(r => r[0].result)`));
    const { targetInfos } = await cdp('Target.getTargets');
    const target = targetInfos.find(t => t.url.endsWith('/essential-links'));
    const { sessionId: source } = await cdp('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const windowCount = await api('chrome.windows.getAll().then(w=>w.length)');
    const external = new URL(base); external.hostname = 'localhost'; external.pathname = '/far';
    await click(source, '#far');
    let destination;
    await wait(async () => { destination = await api(`chrome.tabs.query({windowId:${W},active:true}).then(t=>t[0])`); return destination?.url === external.href && (await rt()).tabSpace[destination.id] === space; });
    ok((await tab(essential)).url === base + '/essential-links', 'external link opens in the current space while preserving the Essential');
    ok((await api('chrome.windows.getAll().then(w=>w.length)')) === windowCount && !Object.keys((await rt()).peeks).length, 'ordinary Essential links create no popup or Peek');
    ok((await rt()).activeSpace[W] === space, 'the Essential uses the selected space, not the space it originally came from');

    await api(`chrome.tabs.update(${essential}, {active:true})`);
    await ev(source, `(() => { const a=document.createElement('a');a.id='new';a.href=${JSON.stringify(base + '/same-site-new')};a.target='_blank';a.textContent='new';document.body.append(a); })()`);
    await click(source, '#new');
    await wait(() => api(`chrome.tabs.query({windowId:${W},url:${JSON.stringify(base + '/same-site-new')}}).then(t=>t.length===1)`));
    const newTab = await api(`chrome.tabs.query({windowId:${W},url:${JSON.stringify(base + '/same-site-new')}}).then(t=>t[0])`);
    await wait(async () => (await rt()).tabSpace[newTab.id] === space);
    ok(true, 'target=_blank links on the same site join the current space');

    await api(`chrome.tabs.update(${essential}, {active:true})`);
    await ev(source, `(() => { const a=document.createElement('a');a.id='bg';a.href=${JSON.stringify(base + '/background-link')};a.textContent='background';document.body.append(a); })()`);
    await click(source, '#bg', 4);
    await wait(() => api(`chrome.tabs.query({windowId:${W},url:${JSON.stringify(base + '/background-link')}}).then(t=>t.length===1)`));
    const background = await api(`chrome.tabs.query({windowId:${W},url:${JSON.stringify(base + '/background-link')}}).then(t=>t[0])`);
    await wait(async () => (await rt()).tabSpace[background.id] === space);
    ok((await tab(essential)).active && !background.active, 'Command-click opens in the current space without stealing focus');

    await ev(source, `(() => { const b=document.createElement('button');b.id='script';b.textContent='script';b.onclick=()=>{const child=window.open('about:blank','_blank');setTimeout(()=>child.location=${JSON.stringify(base + '/script-link')},30)};document.body.append(b); })()`);
    await click(source, '#script');
    await wait(() => api(`chrome.tabs.query({windowId:${W},url:${JSON.stringify(base + '/script-link')}}).then(t=>t.length===1)`));
    const scripted = await api(`chrome.tabs.query({windowId:${W},url:${JSON.stringify(base + '/script-link')}}).then(t=>t[0])`);
    await wait(async () => (await rt()).tabSpace[scripted.id] === space);
    ok(!!(await tab(scripted.id)), 'script-opened links stay alive and join the current space');

    await api(`chrome.tabs.update(${essential}, {active:true})`);
    await click(source, '#l');
    await wait(async () => (await tab(essential))?.url === base + '/other' && (await tab(essential))?.status === 'complete');
    ok((await tab(essential)).pinned, 'same-site in-app navigation stays in the Essential');
    await send('updateSettings', { patch: { peekOnAltClick: true } });
    await click(source, '#far', 1);
    await wait(async () => Object.keys((await rt()).peeks).length === 1);
    ok((await tab(essential)).url === base + '/other', 'Option-click still explicitly opens Peek');
    const popup = Number(Object.keys((await rt()).peeks)[0]);
    await send('peekClose', { windowId: popup });

    // A stale Essential marker must not cause a swallowed click if the worker rejects it.
    await send('unpin', { pinId, windowId: W });
    await api(`chrome.scripting.executeScript({target:{tabId:${essential}},func:()=>globalThis.__coveEssential=true})`);
    await api(`chrome.tabs.update(${essential}, {active:true})`);
    await click(source, '#far');
    await wait(async () => (await tab(essential))?.url === external.href);
    ok(true, 'failed routing falls back to navigation instead of swallowing the link');
  } catch (error) { log.push('FAIL ' + error.stack); }
  return log.join('\n');
}
