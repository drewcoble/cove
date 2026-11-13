// Minimal CDP-over-pipe harness: launches Chrome with a throwaway profile, loads the unpacked
// extension, opens an extension page and evaluates a test script inside it.
//
//   node test/harness.mjs . test/scenarios.js test/phase2.js     # behaviour tests
//   SHOT=/tmp/panel node test/harness.mjs . test/visual.js      # screenshots of the panel
//
// Branded Chrome ignores --load-extension, but still allows Extensions.loadUnpacked over a
// DevTools pipe when started with --enable-unsafe-extension-debugging.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [extArg, testFile, phase2File] = process.argv.slice(2);
const extPath = path.resolve(extArg);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: '/home' }); return res.end(); }
  const headers = { 'content-type': 'text/html' };
  if (req.url.startsWith('/strict-csp')) headers['Content-Security-Policy'] = "default-src 'none'; script-src 'none'; style-src 'none'; connect-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
  res.writeHead(200, headers);
  // #far points at another site (localhost vs 127.0.0.1) for Essential-link tests; #blank opens a same-site tab.
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
const pageErrors = [];
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
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (process.env.TRACE && msg.method === 'Runtime.consoleAPICalled') console.log(msg.params.args.map(a => a.value || a.description || '').join(' '));
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

try {
  const { id: extId } = await cdp('Extensions.loadUnpacked', { path: extPath });
  await new Promise(r => setTimeout(r, 1500));
  const { targetId } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/src/sidepanel.html` });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  await new Promise(r => setTimeout(r, 1500));
  let res;
  if (testFile.endsWith('.mjs')) {
    const driver = await import(pathToFileURL(path.resolve(testFile)).href);
    res = { result: { value: await driver.run({ cdp, sessionId, targetId, extId, base }) } };
  } else {
    const script = fs.readFileSync(testFile, 'utf8').replaceAll('__BASE__', base);
    res = await cdp('Runtime.evaluate', { expression: script, awaitPromise: true, returnByValue: true }, sessionId);
  }
  if (res.exceptionDetails) { console.error('EXCEPTION', JSON.stringify(res.exceptionDetails, null, 2)); done(1); }
  console.log(res.result.value);
  if (process.env.SHOT) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: 300, height: 760, deviceScaleFactor: 2, mobile: false }, sessionId);
    await cdp('Runtime.evaluate', { expression: "document.body.style.transition='none'" }, sessionId);
    for (const scheme of ['dark', 'light']) {
      await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
      await new Promise(r => setTimeout(r, 600));
      for (const view of process.env.SHOT_VIEWS ? ['sidebar', 'commands', 'archive'] : ['sidebar']) {
        if (view !== 'sidebar') {
          const selector = view === 'commands' ? '#command-launch' : '#archive-launch';
          await cdp('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)}).click()` }, sessionId);
        } else await cdp('Runtime.evaluate', { expression: 'document.querySelector("dialog[open]")?.close()' }, sessionId);
        await new Promise(r => setTimeout(r, 100));
        const bounds = await cdp('Runtime.evaluate', { expression: `JSON.stringify({ overflow: document.body.scrollWidth > innerWidth, dialog: (() => { const d = document.querySelector('dialog[open]'); return d ? d.getBoundingClientRect().bottom > innerHeight : false; })() })`, returnByValue: true }, sessionId);
        if (JSON.parse(bounds.result.value).overflow || JSON.parse(bounds.result.value).dialog) throw new Error('Layout overflow: ' + scheme + '/' + view);
        const shot = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
        const suffix = process.env.SHOT_VIEWS ? '-' + view : '';
        fs.writeFileSync(process.env.SHOT + '-' + scheme + suffix + '.png', Buffer.from(shot.data, 'base64'));
      }
    }
  }
  let out = res.result.value;
  if (phase2File) {
    await cdp('Target.closeTarget', { targetId }).catch(() => {});
    const again = await cdp('Extensions.loadUnpacked', { path: extPath });
    if (again.id !== extId) console.error('extension id changed', again.id, extId);
    let s2;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const t2 = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/src/sidepanel.html` });
        s2 = await cdp('Target.attachToTarget', { targetId: t2.targetId, flatten: true });
        await new Promise(r => setTimeout(r, 1000));
        const probe = await cdp('Runtime.evaluate', { expression: 'typeof chrome?.storage?.local', returnByValue: true }, s2.sessionId);
        if (probe.result.value === 'object') break;
        await cdp('Target.closeTarget', { targetId: t2.targetId }).catch(() => {});
      } catch (e) { /* extension still reloading */ }
    }
    let phase2Script = fs.readFileSync(phase2File, 'utf8');
    if (phase2Script.includes('__PAYLOAD__')) phase2Script = phase2Script.replaceAll('__PAYLOAD__', JSON.stringify(JSON.parse(res.result.value).payload));
    const res2 = await cdp('Runtime.evaluate', { expression: phase2Script, awaitPromise: true, returnByValue: true }, s2.sessionId);
    if (res2.exceptionDetails) { console.error('EXCEPTION', JSON.stringify(res2.exceptionDetails, null, 2)); done(1); }
    console.log('--- after extension reload (session state wiped) ---\n' + res2.result.value);
    out += res2.result.value;
  }
  for (const error of pageErrors) console.error('FAIL browser exception: ' + error);
  done(/FAIL/.test(out) || pageErrors.length ? 1 : 0);
} catch (e) {
  console.error(e, stderr.slice(-2000));
  done(1);
}
