// Shared test harness: a tiny static file server + headless Chrome driven over the DevTools
// protocol. No test framework, no puppeteer — just node and whatever Chrome is installed.
import { createServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export async function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { await access(p); return p; } catch {}
  }
  return null;
}

const MIME = {
  '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.json':'application/json', '.png':'image/png', '.css':'text/css', '.svg':'image/svg+xml',
};

// prettyUrls mimics Cloudflare Pages, which 308-redirects /page.html to /page and serves
// /page from page.html. The service worker has to cope with that redirect.
export function serveRepo(port, { prettyUrls = false } = {}) {
  const server = createServer(async (req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (prettyUrls && p.endsWith('.html') && p !== '/index.html') {
      res.writeHead(308, { Location: p.slice(0, -'.html'.length) }).end(); return;
    }
    if (prettyUrls && p !== '/' && !extname(p)) p += '.html';
    if (p === '/') p = '/index.html';
    const file = normalize(join(REPO_ROOT, p));
    if (!file.startsWith(normalize(REPO_ROOT))) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  return new Promise(r => server.listen(port, () => r(server)));
}

// Boots Chrome on `page`, attaches to it, and returns helpers.
export async function launch({ page = 'app.html', port = 8790, debugPort = 9290, label = 'test', prettyUrls = false } = {}) {
  const chromePath = await findChrome();
  if (!chromePath) throw new Error('No Chrome/Edge found. Set CHROME_PATH to run browser tests.');
  const server = await serveRepo(port, { prettyUrls });
  const profile = join(tmpdir(), `satledger-test-${label}`);
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    `http://localhost:${port}/${page}`,
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const list = await (await fetch(`http://localhost:${debugPort}/json/list`)).json();
      const t = list.find(t => t.type === 'page' && t.url.includes(page));
      if (t) wsUrl = t.webSocketDebuggerUrl;
    } catch {}
  }
  if (!wsUrl) { chrome.kill(); server.close(); throw new Error('could not attach to Chrome'); }

  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const errors = [], warnings = [];
  let msgId = 0;
  const send = (method, params = {}) => new Promise(res => {
    const id = ++msgId; pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push('UNCAUGHT: ' + (d.exception?.description || d.text));
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map(a => a.value ?? a.description ?? a.type).join(' ');
      if (m.params.type === 'error') errors.push('console.error: ' + text);
      else if (m.params.type === 'warning') warnings.push(text);
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');

  const evaluate = async (body) => {
    const r = await send('Runtime.evaluate', {
      expression: `(function(){${body}})()`, returnByValue: true, awaitPromise: true,
    });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r?.result?.value;
  };
  const reload = async (ms = 4500) => { await send('Page.reload', {}); await new Promise(r => setTimeout(r, ms)); };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const seed = (obj) => evaluate(
    `localStorage.clear();` +
    Object.entries(obj).map(([k, v]) =>
      `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(typeof v === 'string' ? v : JSON.stringify(v))});`
    ).join('') + `return 1;`
  );
  const press = async (key, code) => {
    const vk = code === 'Tab' ? 9 : code === 'Escape' ? 27 : 0;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  };
  const close = () => { try { ws.close(); } catch {} chrome.kill(); server.close(); };

  return { send, evaluate, reload, wait, seed, press, close, errors, warnings };
}

// Minimal assertion collector
export function createChecks() {
  const state = { pass: 0, fail: 0 };
  const check = (name, cond, detail = '') => {
    if (cond) { state.pass++; console.log('  ok   ' + name); }
    else { state.fail++; console.log('  FAIL ' + name + (detail ? ' — ' + String(detail).slice(0, 220) : '')); }
  };
  const eq = (actual, expected, name) => {
    const a = JSON.stringify(actual), b = JSON.stringify(expected);
    check(name, a === b, a === b ? '' : `expected ${b}, got ${a}`);
  };
  const report = () => {
    console.log(`\n${state.pass} passed, ${state.fail} failed`);
    return state.fail;
  };
  return { check, eq, report, state };
}
