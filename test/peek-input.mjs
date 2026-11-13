// Minimal CDP-over-pipe harness: launches Chrome with a throwaway profile, loads the unpacked
// extension, opens an extension page and evaluates a test script inside it.
//
// Peek with real (trusted) mouse/keyboard input: Option-click, Esc, plain click.
//   node test/peek-input.mjs .
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

const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'zt-profile-'));
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
    }
  }
});
const cdp = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    chrome.stdio[3].write(JSON.stringify({ id: msgId, method, params, sessionId }) + '\0');
  });

const done = code => { try { chrome.kill(); } catch {} server.close(); setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(code); }, 500); return; process.exit(code); };
setTimeout(() => { console.error('TIMEOUT\n', stderr.slice(-2000)); done(2); }, 90000);


const sleep = ms => new Promise(r => setTimeout(r, ms));
async function evalIn(sessionId, expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function attachTo(match) {
  for (let i = 0; i < 20; i++) {
    const { targetInfos } = await cdp('Target.getTargets');
    const t = targetInfos.find(t => t.type === 'page' && t.url.includes(match));
    if (t) return (await cdp('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
    await sleep(250);
  }
  throw new Error('no target ' + match);
}
const click = async (s, x, y, modifiers) => {
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, modifiers }, s);
};
const log = [];
const ok = (c, m) => log.push((c ? 'PASS ' : 'FAIL ') + m);
const step = message => { if (process.env.TRACE) console.log(message); };
try {
  const { id: extId } = await cdp('Extensions.loadUnpacked', { path: extPath });
  await sleep(1500);
  const { targetId } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/src/sidepanel.html` });
  const ext = (await cdp('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await sleep(1200);
  const W = await evalIn(ext, `chrome.windows.create({ url: '${base}/linkpage', focused: true }).then(w => w.id)`);
  await sleep(1500);
  step('window ' + W);
  const page = await attachTo('/linkpage');
  step('attached');
  const { x, y } = JSON.parse(await evalIn(page, `(() => { const r = document.getElementById('l').getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));

  step('coords ' + x + ',' + y);
  await click(page, x, y, 1); // Alt
  step('clicked');
  await sleep(1500);
  let peeks = await evalIn(ext, `chrome.storage.session.get('rt').then(r => JSON.stringify(r.rt.peeks))`);
  const peekIds = Object.keys(JSON.parse(peeks));
  ok(peekIds.length === 1, 'real Option-click on a link opens a Peek: ' + peeks);
  ok((await evalIn(page, 'location.pathname')) === '/linkpage', 'the page under the Peek did not navigate');

  await sleep(1000);
  const { targetInfos } = await cdp('Target.getTargets');
  step(JSON.stringify(targetInfos.filter(t => t.type === 'page').map(t => t.url)));
  const peekPage = await attachTo('/other');
  step('peek attached');
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, peekPage).catch(() => {});
  await sleep(800);
  peeks = await evalIn(ext, `chrome.storage.session.get('rt').then(r => JSON.stringify(r.rt.peeks))`);
  ok(peeks === '{}', 'Esc inside the Peek closes it');

  await evalIn(ext, `(window.__focus = [], chrome.windows.onFocusChanged.addListener(id => window.__focus.push(id)), 1)`);
  await click(page, x, y, 1);
  await sleep(1500);
  step('peeks before focus: ' + await evalIn(ext, `chrome.storage.session.get('rt').then(r => JSON.stringify(r.rt.peeks))`));
  await evalIn(ext, `chrome.windows.update(${W}, { focused: true }).then(() => 1)`);
  await sleep(800);
  step('focus events seen: ' + await evalIn(ext, 'JSON.stringify(window.__focus)'));
  await sleep(800);
  peeks = await evalIn(ext, `chrome.storage.session.get('rt').then(r => JSON.stringify(r.rt.peeks))`);
  step('(focus-close not testable in headless: Chrome emits no focus event for the main window here)');
  for (const id of Object.keys(JSON.parse(peeks))) await evalIn(ext, `chrome.runtime.sendMessage({ type: 'peekClose', windowId: ${'${id}'} }).then(() => 1)`.replace('${id}', id));
  await sleep(500);

  await evalIn(ext, `chrome.runtime.sendMessage({ type: 'updateSettings', patch: { peekOnAltClick: false } }).then(() => 1)`);
  await sleep(500);
  await evalIn(page, `location.href = '${base}/linkpage2'`);
  await sleep(1000);
  const page2 = await attachTo('/linkpage2');
  await click(page2, x, y, 0);
  await sleep(1200);
  peeks = await evalIn(ext, `chrome.storage.session.get('rt').then(r => JSON.stringify(r.rt.peeks))`);
  const url = await evalIn(ext, `chrome.tabs.query({ windowId: ${W}, active: true }).then(([t]) => t.url)`);
  ok(peeks === '{}' && url.endsWith('/other'), 'plain click still navigates normally (no Peek)');
  // Real Essential clicks: external links open in the current space; internal navigation stays put.
  const essId = await evalIn(ext, `chrome.tabs.create({ windowId: ${W}, url: '${base}/essential', active: true }).then(t => t.id)`);
  await sleep(1200);
  await evalIn(ext, `chrome.runtime.sendMessage({ type: 'pinTab', tabId: ${essId}, spaceId: null }).then(() => 1)`);
  await sleep(800);
  const ess = await attachTo('/essential');
  const far = JSON.parse(await evalIn(ess, `(() => { const r = document.getElementById('far').getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
  await click(ess, far.x, far.y, 0);
  await sleep(1500);
  peeks = JSON.parse(await evalIn(ext, `chrome.storage.session.get('rt').then(r => JSON.stringify(r.rt.peeks))`));
  const linked = await evalIn(ext, `chrome.tabs.query({ windowId: ${W}, active: true }).then(([t]) => ({ id: t.id, url: t.url }))`);
  const linkState = JSON.parse(await evalIn(ext, `chrome.storage.session.get('rt').then(r => JSON.stringify(r.rt))`));
  ok(Object.keys(peeks).length === 0 && linked.url.includes('/far') && linkState.tabSpace[linked.id] === linkState.activeSpace[W] && (await evalIn(ess, 'location.pathname')) === '/essential',
    'clicking an external link in an Essential opens it in the current space and preserves the Essential');
  for (const id of Object.keys(peeks)) await evalIn(ext, `chrome.runtime.sendMessage({ type: 'peekClose', windowId: ${id} }).then(() => 1)`);
  await sleep(500);
  await evalIn(ext, `chrome.tabs.update(${essId}, { active: true })`);
  await click(ess, x, y, 0);
  await sleep(1200);
  const essUrl = await evalIn(ext, `chrome.tabs.get(${essId}).then(t => t.url)`);
  ok(essUrl.endsWith('/other'), 'same-site link in an Essential navigates normally');

  // Essential target=_blank links remain regular tabs, in windowed and fullscreen layouts.
  const essPage = ess;
  const blank = JSON.parse(await evalIn(essPage, `(() => { const r = document.getElementById('blank').getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
  const tabsBefore = await evalIn(ext, `chrome.tabs.query({ windowId: ${W} }).then(t => t.length)`);
  await click(essPage, blank.x, blank.y, 0);
  await sleep(1000);
  const opened = await evalIn(ext, `chrome.tabs.query({ windowId: ${W}, active: true }).then(([t]) => ({id:t.id,url:t.url}))`);
  peeks = JSON.parse(await evalIn(ext, `chrome.storage.session.get('rt').then(r => JSON.stringify(r.rt.peeks))`));
  ok(!Object.keys(peeks).length && opened.url.endsWith('/opened') &&
    (await evalIn(ext, `chrome.tabs.query({ windowId: ${W} }).then(t => t.length)`)) === tabsBefore + 1,
    'target=_blank link from an Essential stays open as a normal tab');
  await evalIn(ext, `chrome.windows.update(${W}, { state: 'fullscreen' }).then(() => 1)`);
  await sleep(500);
  await evalIn(ext, `chrome.tabs.update(${essId}, { active: true }).then(() => 1)`);
  await click(essPage, blank.x, blank.y, 0);
  await sleep(1000);
  const fullscreenLink = await evalIn(ext, `chrome.tabs.query({ windowId: ${W}, active: true }).then(([t]) => ({url:t.url,split:t.splitViewId}))`);
  ok(fullscreenLink.url.endsWith('/opened') && fullscreenLink.split === (await evalIn(ext, 'chrome.tabs.SPLIT_VIEW_ID_NONE')) &&
    (await evalIn(ess, 'location.pathname')) === '/other', 'full screen: Essential links open as normal tabs and preserve the Essential');

  console.log(log.join('\n'));
  done(/FAIL/.test(log.join()) ? 1 : 0);
} catch (e) {
  console.log(log.join('\n'));
  console.error(e);
  done(1);
}
