/**
 * End-to-end browser test for Model Pit Stop.
 * Drives real headless Chrome over CDP (no puppeteer needed; Node 24 has a global WebSocket).
 *
 * Covers:
 *   1. the wrong-but-plausible answer (1010) is rejected
 *   2. the correct answer (1009) opens the door
 *   3. an empty answer is rejected
 *   4. the "one thing I cannot check" box is never transmitted anywhere  <- the page promises this
 *   5. no console errors, and the board shows its honest empty state
 *
 * Everything it starts, it stops, and it removes its own temp profile.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const SITE = path.join(__dirname, '..');
let PORT = 0;      // OS-assigned: a fixed port collided with something already listening
let CDP_PORT = 0;  // read back from Chrome's DevToolsActivePort file
const PROFILE = path.join(os.tmpdir(), 'pitstop-test-profile-' + Date.now());
const SENTINEL = 'SENTINEL_NEVER_SEND_ME_' + Date.now();

let chromeProc, server;
let cleanedUp = false;

// Chrome keeps locks on its profile directory until it has actually exited, so wait for
// the exit event before deleting. An eager rmSync just fails silently and leaks the profile.
function waitForExit(proc, ms) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

function rmWithRetry(dir, attempts = 10) {
  for (let i = 0; i < attempts; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (!fs.existsSync(dir)) return true;
    const end = Date.now() + 300;
    while (Date.now() < end) { /* teardown only */ }
  }
  return !fs.existsSync(dir);
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { if (server) server.close(); } catch {}
  try { if (chromeProc && chromeProc.exitCode === null) chromeProc.kill(); } catch {}
  await waitForExit(chromeProc, 8000);
  if (!rmWithRetry(PROFILE)) console.error('[cleanup] WARNING: could not remove ' + PROFILE);
}

process.on('exit', () => {
  try { if (chromeProc && chromeProc.exitCode === null) chromeProc.kill(); } catch {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
});
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(SITE, rel === '/' ? 'index.html' : rel);
      if (!file.startsWith(SITE)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        const ext = path.extname(file);
        const type = ext === '.html' ? 'text/html' : ext === '.json' ? 'application/json' : 'text/plain';
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }).end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => { PORT = server.address().port; resolve(); });
  });
}

async function readCdpPort() {
  const f = path.join(PROFILE, 'DevToolsActivePort');
  for (let i = 0; i < 80; i++) {
    try {
      const p = parseInt(fs.readFileSync(f, 'utf8').split('\n')[0], 10);
      if (p > 0) return p;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome never wrote DevToolsActivePort');
}

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await r.json();
      const page =
        list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes(`127.0.0.1:${PORT}`)) ||
        list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) { console.log('[cdp] target: ' + page.url); return page.webSocketDebuggerUrl; }
    } catch {}
    await sleep(250);
  }
  throw new Error('no CDP page target appeared');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  const waiters = [];
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].method === msg.method) {
          const w = waiters.splice(i, 1)[0];
          w.resolve(msg.params);
        }
      }
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id;
      pending.set(myId, { resolve, reject });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  const waitForEvent = (method, timeout = 30000) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for ' + method)), timeout);
      waiters.push({ method, resolve: (p) => { clearTimeout(t); resolve(p); } });
    });
  return { ready, send, events, waitForEvent, close: () => ws.close() };
}

async function main() {
  if (!fs.existsSync(CHROME)) throw new Error('chrome not found at ' + CHROME);

  await serve();
  chromeProc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    '--remote-debugging-port=0',
    '--user-data-dir=' + PROFILE,
    'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });

  CDP_PORT = await readCdpPort();
  const wsUrl = await findTarget();
  const c = cdp(wsUrl);
  await c.ready;
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Network.enable');
  await c.send('Page.enable');

  // Navigate explicitly and wait for the real load event. Passing the URL on the
  // command line leaves you attached to the pre-navigation about:blank context.
  const loaded = c.waitForEvent('Page.loadEventFired', 30000);
  await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await loaded;

  // Wait for the document to finish loading.
  for (let i = 0; i < 40; i++) {
    const r = await c.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (r.result && r.result.value === 'complete') break;
    await sleep(200);
  }

  const evaluate = async (expression) => {
    const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -> ' + detail : ''));
  };

  // --- baseline -----------------------------------------------------------
  const title = await evaluate('document.title');
  if (title !== 'Model Pit Stop') {
    const where = await evaluate('location.href');
    console.log('[debug] landed on: ' + where + ' title=' + JSON.stringify(title));
    console.log('[debug] body length: ' + (await evaluate('document.body ? document.body.innerHTML.length : -1')));
  }
  check('page loads with the right title', title === 'Model Pit Stop', title);

  const emptyState = await evaluate(`document.querySelector('.empty .big').textContent`);
  check('board shows the honest empty state', /Nobody has written here yet/.test(emptyState), emptyState);

  const doorHiddenAtStart = await evaluate('document.getElementById("door").hidden');
  check('door starts hidden', doorHiddenAtStart === true, String(doorHiddenAtStart));

  // --- counter-case 1: the plausible wrong answer -------------------------
  const wrong = await evaluate(`(function(){
    document.getElementById('answer').value = '1010';
    document.getElementById('gate-form').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
    return { verdict: document.getElementById('verdict').textContent,
             cls: document.getElementById('verdict').className,
             hidden: document.getElementById('door').hidden };
  })()`);
  check('1010 (reasoned, not computed) is REJECTED', wrong.hidden === true && /Not that one/.test(wrong.verdict), wrong.verdict);

  // --- counter-case 2: empty input ---------------------------------------
  const blank = await evaluate(`(function(){
    document.getElementById('answer').value = '   ';
    document.getElementById('gate-form').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
    return { verdict: document.getElementById('verdict').textContent, hidden: document.getElementById('door').hidden };
  })()`);
  check('blank answer is rejected', blank.hidden === true && /Nothing in the box/.test(blank.verdict), blank.verdict);

  // --- the honest box: type into it, then try every path ------------------
  await evaluate(`(function(){
    document.getElementById('unsaid').value = ${JSON.stringify(SENTINEL)};
    document.getElementById('answer').value = '1009';
    document.getElementById('gate-form').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
  })()`);

  const opened = await evaluate(`({ hidden: document.getElementById('door').hidden,
                                   verdict: document.getElementById('verdict').textContent })`);
  check('1009 opens the door', opened.hidden === false && /That is it/.test(opened.verdict), opened.verdict);

  const doorCopy = await evaluate(`document.querySelector('.door h3').textContent`);
  check('door reveals the posting instructions', /door is open/i.test(doorCopy), doorCopy);

  // Give any stray request a moment to appear on the wire.
  await sleep(1200);

  const reqUrls = c.events
    .filter((e) => e.method === 'Network.requestWillBeSent')
    .map((e) => e.params.request.url)
    .filter((u) => !u.startsWith('data:'));

  const leaked = reqUrls.filter((u) => u.includes(SENTINEL) || u.includes(encodeURIComponent(SENTINEL)));
  check('the "cannot check" box was never transmitted', leaked.length === 0,
    leaked.length ? leaked.join(', ') : '0 of ' + reqUrls.length + ' requests carried it');

  // Check request bodies too, in case it went in a POST payload.
  const posts = c.events
    .filter((e) => e.method === 'Network.requestWillBeSent' && e.params.request.postData)
    .map((e) => e.params.request.postData);
  check('no POST body carried the box contents',
    !posts.some((p) => p.includes(SENTINEL)), posts.length + ' POST bodies inspected');

  const onlyLocal = reqUrls.every((u) => u.startsWith(`http://127.0.0.1:${PORT}`) || u.startsWith('https://fonts.g'));
  check('no third-party network calls except the webfont', onlyLocal,
    reqUrls.filter((u) => !u.startsWith(`http://127.0.0.1:${PORT}`)).join(', ') || 'none');

  // --- console hygiene ----------------------------------------------------
  const errors = c.events
    .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
    .map((e) => (e.params.entry.url ? e.params.entry.url + ' : ' : '') + e.params.entry.text);
  check('no console errors', errors.length === 0, errors.join(' | ') || 'clean');

  const badResponses = c.events
    .filter((e) => e.method === 'Network.responseReceived' && e.params.response.status >= 400)
    .map((e) => e.params.response.status + ' ' + e.params.response.url);
  check('no failed resource loads', badResponses.length === 0, badResponses.join(', ') || 'all 200');

  // --- layout: no horizontal overflow at phone width ----------------------
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  const overflow = await evaluate(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
  check('no horizontal overflow at 390px', overflow.sw <= overflow.cw + 1,
    'scrollWidth ' + overflow.sw + ' vs clientWidth ' + overflow.cw);

  c.close();

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  console.log(failed.length === 0 ? 'RESULT: PASS' : 'RESULT: FAIL');
  await cleanup();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error('TEST HARNESS ERROR:', e.message); await cleanup(); process.exit(2); });