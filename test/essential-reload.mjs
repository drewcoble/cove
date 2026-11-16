// Minimal CDP-over-pipe harness: launches Chrome with a throwaway profile, loads the unpacked
// extension, opens an extension page and evaluates a test script inside it.
//
// Links in an Essential keep working after the extension is reloaded or updated while the
// Essential stays open (its old content script can no longer reach the extension).
//   node test/essential-reload.mjs .
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
async function attachTo(match) {
  for (let i = 0; i < 40; i++) {
    const { targetInfos } = await cdp('Target.getTargets');
    const t = targetInfos.find(t => t.type === 'page' && t.url.includes(match));
    if (t) return { sessionId: (await cdp('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId, targetId: t.targetId };
    await sleep(250);
  }
  throw new Error('no target ' + match);
}
const click = async (s, x, y) => {
  for (const type of ['mousePressed', 'mouseReleased'])
    await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, modifiers: 0 }, s);
};
const log = [];
const ok = (c, m) => log.push((c ? 'PASS ' : 'FAIL ') + m);
try {
  const { id: extId } = await cdp('Extensions.loadUnpacked', { path: extPath });
  await sleep(1500);
  let ext = await attachTo(`chrome-extension://${extId}`).catch(async () => {
    const { targetId } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/src/sidepanel.html` });
    await sleep(1200);
    return attachTo(`chrome-extension://${extId}/src/sidepanel.html`);
  });
  const api = expr => evalIn(ext.sessionId, expr);
  const W = await api(`chrome.windows.create({ url: '${base}/essential', focused: true }).then(w => w.id)`);
  await sleep(1500);
  const essId = await api(`chrome.tabs.query({ windowId: ${W} }).then(t => t[0].id)`);
  await api(`chrome.runtime.sendMessage({ type: 'pinTab', tabId: ${essId}, spaceId: null }).then(() => 1)`);
  await sleep(1000);

  // Reload the extension while the Essential stays open, as a dev reload or an update does.
  await cdp('Target.closeTarget', { targetId: ext.targetId }).catch(() => {});
  await cdp('Extensions.loadUnpacked', { path: extPath });
  await sleep(2500);
  const { targetId: t2 } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/src/sidepanel.html` });
  await sleep(1500);
  ext = { sessionId: (await cdp('Target.attachToTarget', { targetId: t2, flatten: true })).sessionId, targetId: t2 };
  await sleep(1500);

  const page = (await attachTo('/essential')).sessionId;
  const far = JSON.parse(await evalIn(page, `(() => { const r = document.getElementById('far').getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`));
  await click(page, far.x, far.y);
  await sleep(2000);
  const peeks = await api(`chrome.storage.session.get('rt').then(r => Object.keys(r.rt.peeks || {}).length)`);
  const essUrl = await api(`chrome.tabs.get(${essId}).then(t => t.url)`);
  ok(peeks === 0 && !essUrl.endsWith('/essential'), 'after a reload, clicking an other-site link in an Essential still does something (Peek or navigate): peeks=' + peeks + ' url=' + essUrl);
  ok(peeks === 0, 'after a reload, native links do not become automatic Peeks');
  console.log(log.join('\n'));
  done(/FAIL/.test(log.join()) ? 1 : 0);
} catch (e) {
  console.log(log.join('\n'));
  console.error(e);
  done(1);
}
