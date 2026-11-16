import { fileURLToPath } from 'node:url';

export async function run({ cdp, sessionId: control, base }) {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = async (session, expression) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const api = expression => evaluate(control, expression);
  const wait = async predicate => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await sleep(60); }
    throw new Error('Timed out waiting for a link after extension reload');
  };
  const send = (type, payload) => api(`chrome.runtime.sendMessage(${JSON.stringify({ type, ...payload })}).then(r => { if (!r.ok) throw new Error(r.error); return r.result; })`);
  const sourceUrl = base + '/essential-before-reload';
  const destination = new URL(base + '/external-after-reload'); destination.hostname = 'localhost';
  const log = [];
  try {
    const spaceId = await api("chrome.storage.local.get('config').then(r => r.config.spaces[0].id)");
    const windowId = await api('chrome.windows.getCurrent().then(w => w.id)');
    const id = await send('newTab', { windowId, spaceId, url: sourceUrl });
    await wait(() => api(`chrome.tabs.get(${id}).then(t => t.status === 'complete')`));
    await send('pinTab', { tabId: id, spaceId: null });
    await wait(() => api(`chrome.scripting.executeScript({ target: { tabId: ${id} }, func: () => globalThis.__coveEssential === true }).then(r => r[0].result)`));
    const { targetInfos } = await cdp('Target.getTargets');
    const source = targetInfos.find(target => target.url === sourceUrl);
    const { sessionId } = await cdp('Target.attachToTarget', { targetId: source.targetId, flatten: true });
    await evaluate(sessionId, `document.body.innerHTML = '<a id="external" target="_blank" rel="noopener" href="${destination.href}">External link</a>'; window.__pageSawClick = false; window.addEventListener('click', () => window.__pageSawClick = true, true);`);
    // Keep the web document alive while replacing its extension context.
    await cdp('Extensions.loadUnpacked', { path: fileURLToPath(new URL('../', import.meta.url)) });
    const rect = await evaluate(sessionId, "(() => { const r = document.querySelector('#external').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, ...rect, button: 'left', clickCount: 1 }, sessionId);
    await wait(async () => (await cdp('Target.getTargets')).targetInfos.some(target => target.url === destination.href));
    const stillOriginal = await evaluate(sessionId, `location.href === ${JSON.stringify(sourceUrl)}`);
    const pageSawClick = await evaluate(sessionId, 'window.__pageSawClick');
    log.push(`${stillOriginal ? 'PASS' : 'FAIL'} an external link after Cove reload opens separately and preserves the Essential`);
    log.push(`${pageSawClick ? 'PASS' : 'FAIL'} a stale content script leaves native link and page handlers intact`);
  } catch (error) { log.push('FAIL ' + error.stack); }
  return log.join('\n');
}
