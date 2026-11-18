// Minimal CDP-over-pipe harness: launches Chrome with a throwaway profile, loads the unpacked
// extension, opens an extension page and evaluates a test script inside it.
//
// Search over real pages: the overlay frame, what the page can and can't see, results and
// actions, the restricted-page fallback, and token checks.
//   node test/search.mjs .
//
// Branded Chrome ignores --load-extension, but still allows Extensions.loadUnpacked over a
// DevTools pipe when started with --enable-unsafe-extension-debugging.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [extArg, testFile, phase2File] = process.argv.slice(2);
const extPath = path.resolve(extArg);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: '/home' }); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html' });
  // #far points at another site (localhost vs 127.0.0.1); #blank opens a new tab on the same site.
  res.end(`<title>Page ${req.url}</title><a id="l" href="/other">x</a> <a id="far" href="http://localhost:${server.address().port}/far">far</a> <a id="blank" href="/opened" target="_blank">blank</a>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cove-profile-'));
const chrome = spawn(CHROME, [
  '--headless', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let stderr = '';
chrome.stderr.on('data', d => (stderr += d));

let id = 0;
const pending = new Map();
let buf = '';
chrome.stdio[4].on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\0')) !== -1) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method === 'Target.attachedToTarget') {
      onAttached(msg.params);
    }
  }
});

// Headless windows never have OS focus, so pages and frames report document.hasFocus() as
// false. Emulate a focused window on every page and frame (as a real browser in front would
// be), so behaviour that depends on focus, like the search overlay, is tested as users see it.
async function onAttached({ sessionId, targetInfo, waitingForDebugger }) {
  if (targetInfo.type === 'page' || targetInfo.type === 'iframe') {
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
    await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId).catch(() => {});
  }
  if (waitingForDebugger) await cdp('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
}
const cdp = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    chrome.stdio[3].write(JSON.stringify({ id: msgId, method, params, sessionId }) + '\0');
  });

const done = code => { try { chrome.kill(); } catch {} server.close(); setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(code); }, 500); return; process.exit(code); };
setTimeout(() => { console.error('TIMEOUT\n', stderr.slice(-2000)); done(2); }, 180000);



const sleep = ms => new Promise(r => setTimeout(r, ms));
async function evalIn(sessionId, expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}
async function attachTo(match, type = 'page') {
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await cdp('Target.getTargets');
    const t = targetInfos.find(t => t.type === type && t.url.includes(match));
    if (t) return (await cdp('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
    await sleep(250);
  }
  throw new Error('no target ' + type + ' ' + match);
}
const log = [];
const ok = (c, m) => log.push((c ? 'PASS ' : 'FAIL ') + m);
try {
  await cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const { id: extId } = await cdp('Extensions.loadUnpacked', { path: extPath });
  await sleep(1500);
  const { targetId } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/src/sidepanel.html` });
  const ext = (await cdp('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await sleep(1200);
  const api = expr => evalIn(ext, expr);
  const msg = (type, payload = {}) => api(`chrome.runtime.sendMessage(${JSON.stringify({ type, ...payload })})`);
  const rt = () => api(`chrome.storage.session.get('rt').then(r => r.rt)`);

  const W = await api(`chrome.windows.create({ url: '${base}/page-one', focused: true }).then(w => w.id)`);
  await sleep(1200);
  const pinTab = await api(`chrome.tabs.create({ windowId: ${W}, url: '${base}/secret-pin', active: false }).then(t => t.id)`);
  await sleep(800);
  await msg('pinTab', { tabId: pinTab, spaceId: (await api(`chrome.storage.local.get('config').then(r => r.config.spaces[0].id)`)) });
  const pinId = await api(`chrome.storage.local.get('config').then(r => r.config.spaces[0].pins.at(-1))`);
  await msg('renamePin', { pinId, title: 'Quarterly Board Deck' });
  await api(`chrome.history.addUrl({ url: '${base}/only-in-history' })`);
  const page = await attachTo('/page-one');
  await evalIn(page, `window.__keys = []; addEventListener('keydown', e => __keys.push(e.key), true); 1`);

  // A site's own Cmd/Ctrl+K still works: nothing is listening on pages until search opens.
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 4, windowsVirtualKeyCode: 75 }, page);
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 4, windowsVirtualKeyCode: 75 }, page);
  await sleep(300);
  ok((await evalIn(page, 'JSON.stringify(__keys)')).includes('"k"'), 'the page still receives its own Cmd+K');
  ok((await evalIn(page, '!!globalThis.__coveSearch')) === false, 'no Cove script runs on the page before search opens');

  // Open search over the page.
  let res = await msg('openSearch', { windowId: W });
  await sleep(1200);
  let r = await rt();
  const session = Object.entries(r.searches).find(([, s]) => s.windowId === W);
  ok(session && session[1].overlay, 'search opens as an overlay on an ordinary page');
  const pageView = JSON.parse(await evalIn(page, `JSON.stringify({
    host: !!document.querySelector('cove-search'),
    shadow: document.querySelector('cove-search')?.shadowRoot ?? null,
    frames: document.querySelectorAll('iframe').length,
    text: document.documentElement.innerText })`));
  ok(pageView.host && pageView.shadow === null && pageView.frames === 0, 'the page sees only a closed host element, not the frame');
  ok(!pageView.text.includes('Quarterly') && !pageView.text.includes('secret-pin'), 'none of your data appears in the page');

  const launcher = await attachTo('launcher.html', 'iframe');
  await sleep(800);
  const L = expr => evalIn(launcher, expr);
  const typeQuery = async q => {
    await L(`(() => { const i = document.querySelector('#search'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input')); return 1; })()`);
    await sleep(250);
  };
  const titles = () => L(`JSON.stringify([...document.querySelectorAll('.result-title')].map(n => n.textContent))`).then(JSON.parse);
  const badges = () => L(`JSON.stringify([...document.querySelectorAll('.result-kind')].map(n => n.textContent))`).then(JSON.parse);
  ok((await titles()).length > 0, 'the launcher frame shows results');
  await typeQuery('quarterly');
  ok((await titles())[0] === 'Quarterly Board Deck', 'pinned tabs are found by their custom name');
  await typeQuery('only-in-history');
  ok((await badges()).includes('History'), 'pages from history are found');
  await typeQuery('> archive');
  ok((await titles()).includes('View archive'), '> lists commands');

  // Choosing a result switches to it and closes the overlay.
  await typeQuery('quarterly');
  await L(`document.querySelector('.result').click(), 1`);
  await sleep(1000);
  const activeUrl = await api(`chrome.tabs.query({ windowId: ${W}, active: true }).then(t => t[0].url)`);
  ok(activeUrl.endsWith('/secret-pin'), 'choosing a pinned tab switches to it');
  ok(!(await evalIn(page, `!!document.querySelector('cove-search')`)) && !Object.keys((await rt()).searches).length, 'choosing a result closes search');

  // Toggle with the same shortcut; Esc closes.
  await api(`chrome.tabs.update(${await api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.find(x => x.url.endsWith('/page-one')).id)`)}, { active: true })`);
  await sleep(400);
  await msg('openSearch', { windowId: W });
  await sleep(800);
  await msg('openSearch', { windowId: W });
  await sleep(600);
  ok(!(await evalIn(page, `!!document.querySelector('cove-search')`)), 'the search shortcut closes search when it is open');
  await msg('openSearch', { windowId: W });
  await sleep(1000);
  const launcher2 = await attachTo('launcher.html', 'iframe');
  await sleep(500);
  await evalIn(launcher2, `dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), 1`);
  await sleep(700);
  ok(!(await evalIn(page, `!!document.querySelector('cove-search')`)), 'Esc closes search');

  // Typing a URL opens it in a new tab in the current space.
  await msg('openSearch', { windowId: W });
  await sleep(1000);
  const launcher3 = await attachTo('launcher.html', 'iframe');
  await sleep(500);
  await evalIn(launcher3, `(() => { const i = document.querySelector('#search'); i.value = '${base.replace('http://', '')}/typed'; i.dispatchEvent(new Event('input')); return 1; })()`);
  await sleep(300);
  await evalIn(launcher3, `dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })), 1`);
  await sleep(1000);
  r = await rt();
  const typed = await api(`chrome.tabs.query({ windowId: ${W}, active: true }).then(t => t[0])`);
  ok((typed.pendingUrl || typed.url).endsWith('/typed') && r.tabSpace[typed.id] === r.activeSpace[W], 'a typed URL opens in a new tab in the current space');

  // Pages where nothing can be injected get a temporary launcher tab.
  const restricted = await api(`chrome.tabs.create({ windowId: ${W}, url: 'chrome://version', active: true }).then(t => t.id)`);
  await sleep(800);
  await msg('openSearch', { windowId: W });
  await sleep(1000);
  r = await rt();
  const fallback = Object.values(r.searches).find(s => s.windowId === W);
  const fallbackTab = await api(`chrome.tabs.query({ windowId: ${W}, active: true }).then(t => t[0].url)`);
  ok(fallback && !fallback.overlay && fallbackTab.includes('launcher.html'), 'on a chrome:// page, search opens as a tab');
  const launcherTab = await attachTo('launcher.html', 'page');
  await sleep(500);
  await evalIn(launcherTab, `dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), 1`);
  await sleep(800);
  const back = await api(`chrome.tabs.query({ windowId: ${W}, active: true }).then(t => t[0].id)`);
  const leftover = await api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.some(x => x.url.includes('launcher.html')))`);
  ok(back === restricted && !leftover, 'closing the launcher tab returns to where you were');

  // When the overlay can't get keyboard focus (Chrome's address bar still has it), the
  // launcher swaps itself for the tab version, which can.
  const sourceTab = await api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.find(x => x.url.endsWith('/page-one')).id)`);
  await api(`chrome.tabs.update(${sourceTab}, { active: true }).then(() => 1)`);
  await sleep(500);
  const sourcePage = await attachTo('/page-one');
  await msg('openSearch', { windowId: W });
  await sleep(1000);
  const unfocused = await attachTo('launcher.html', 'iframe');
  await sleep(400);
  // Fire and forget: the swap removes this frame, so it never sees the reply.
  await evalIn(unfocused, `chrome.runtime.sendMessage({ type: 'launcherFallback', token: new URLSearchParams(location.hash.slice(1)).get('token') }), 1`);
  await sleep(1200);
  r = await rt();
  const swapped = Object.values(r.searches).find(s => s.windowId === W);
  const swappedTab = await api(`chrome.tabs.query({ windowId: ${W}, active: true }).then(t => t[0])`);
  ok(swapped && !swapped.overlay && swappedTab.url.includes('launcher.html') && swappedTab.url.includes('view=tab'),
    'an overlay that can’t get focus is swapped for the search tab');
  ok(!(await evalIn(sourcePage, `!!document.querySelector('cove-search')`)), 'the overlay is removed from the page when it swaps');
  const swappedLauncher = await attachTo('view=tab', 'page');
  await sleep(500);
  ok(await evalIn(swappedLauncher, `document.querySelector('#search') === document.activeElement`), 'the search tab has the cursor in the search box');
  await evalIn(swappedLauncher, `dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })), 1`);
  await sleep(800);
  ok((await api(`chrome.tabs.query({ windowId: ${W}, active: true }).then(t => t[0].id)`)) === sourceTab, 'Esc in the search tab returns to the page you were on');

  // Token checks.
  await msg('openSearch', { windowId: W });
  await sleep(1000);
  const live = Object.entries((await rt()).searches).find(([, s]) => s.windowId === W)?.[0];
  const forged = await msg('launcherAction', { token: 'forged', kind: 'navigate', text: 'evil.example' });
  ok(forged && !forged.ok, 'a forged token is refused');
  const wrongPage = await msg('launcherAction', { token: live, kind: 'navigate', text: 'evil.example' });
  ok(wrongPage && !wrongPage.ok, 'a real token is refused from anything but its own launcher');
  const copy = await api(`chrome.tabs.create({ windowId: ${W}, url: chrome.runtime.getURL('src/launcher.html') + '#token=${live}&view=tab', active: false }).then(t => t.id)`);
  await sleep(1200);
  const copySession = await attachTo(`token=${live}&view=tab`, 'page');
  const copyText = await evalIn(copySession, `document.body.innerText`);
  ok(copyText.includes('This search has closed') && !copyText.includes('Quarterly'), 'a copy of the launcher opened elsewhere shows nothing');
  await api(`chrome.tabs.remove(${copy})`);

  // Sites can't detect Cove by fetching the launcher at its fixed address.
  const probe = await evalIn(page, `fetch('chrome-extension://${extId}/src/launcher.html').then(() => 'loaded', () => 'blocked')`);
  ok(probe === 'blocked', 'a web page cannot fetch the launcher to detect Cove');

  // History search can be turned off.
  await msg('openSearch', { windowId: W }); // the shortcut again closes the search left open above
  await sleep(500);
  await api(`chrome.storage.local.get('config').then(r => chrome.runtime.sendMessage({ type: 'updateSettings', patch: { searchHistory: false } }))`);
  await api(`chrome.tabs.update(${await api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.find(x => x.url.endsWith('/page-one')).id)`)}, { active: true })`);
  await sleep(500);
  await msg('openSearch', { windowId: W });
  await sleep(1000);
  const launcher4 = await attachTo('launcher.html', 'iframe');
  await sleep(500);
  await evalIn(launcher4, `(() => { const i = document.querySelector('#search'); i.value = 'only-in-history'; i.dispatchEvent(new Event('input')); return 1; })()`);
  await sleep(300);
  const noHistory = await evalIn(launcher4, `[...document.querySelectorAll('.result-kind')].some(n => n.textContent === 'History')`);
  ok(!noHistory, 'with history turned off, search doesn’t show history');
  if (process.env.SHOT) {
    await evalIn(launcher4, `(() => { const i = document.querySelector('#search'); i.value = ''; i.dispatchEvent(new Event('input')); return 1; })()`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 720, deviceScaleFactor: 1, mobile: false }, page);
    await sleep(500);
    const shot = await cdp('Page.captureScreenshot', { format: 'png' }, page);
    fs.writeFileSync(process.env.SHOT + '-overlay.png', Buffer.from(shot.data, 'base64'));
  }

  // The content-script whitelist doesn't include search.
  const pageTab = await api(`chrome.tabs.query({ windowId: ${W} }).then(t => t.find(x => x.url.endsWith('/page-one')).id)`);
  const fromPage = await api(`chrome.scripting.executeScript({ target: { tabId: ${pageTab} }, func: () => chrome.runtime.sendMessage({ type: 'launcherHello', token: 'x' }).then(r => r ?? null, () => 'rejected') }).then(r => r[0].result)`);
  ok(fromPage === null || fromPage === 'rejected', 'web pages cannot call search handlers');
  console.log(log.join('\n'));
  done(/FAIL/.test(log.join()) ? 1 : 0);
} catch (e) {
  console.log(log.join('\n'));
  console.error(e);
  done(1);
}
