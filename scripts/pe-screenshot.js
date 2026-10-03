'use strict';

/**
 * PE-Workbench · CDP 界面验证与截图工具。
 *
 *   node scripts/pe-screenshot.js [--out DIR] [--login demo.qa] [routes...]
 *
 * 通过 Chrome DevTools Protocol 驱动 Edge headless：导航、等待、检查 DOM 标记、
 * 收集 JS 错误、截图。用于验证"视图真的渲染了"（参考原 GxP 项目的 CDP 截屏工具）。
 *
 * 用法示例：
 *   node scripts/pe-screenshot.js --out shots
 *   node scripts/pe-screenshot.js --login demo.qa --out shots dashboard inbox records
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.PE_SCREENSHOT_BASE || 'http://127.0.0.1:8899';
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
];
const PORT = 9231;

function parseArgs(argv) {
  const opts = { out: 'shots', login: null, routes: null, width: 1440, height: 950 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--login') opts.login = argv[++i];
    else if (argv[i] === '--width') opts.width = Number(argv[++i]);
    else if (argv[i] === '--height') opts.height = Number(argv[++i]);
    else opts.routes = (opts.routes || []).concat(argv[i]);
  }
  if (!opts.routes) opts.routes = ['/', '/#/domains', '/#/domain/MDL', '/#/workflow/MODEL', '/#/philosophy'];
  return opts;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function findEdge() {
  for (const c of EDGE_CANDIDATES) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function getWsTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('CDP endpoint did not come up');
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method && ['Runtime.exceptionThrown', 'Log.entryAdded', 'Runtime.consoleAPICalled'].includes(msg.method)) {
        this.events.push(msg);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
    return res.result ? res.result.value : null;
  }
  errors() {
    const out = [];
    for (const e of this.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = (e.params.exceptionDetails || {});
        const loc = (d.url && (d.url.split('/').pop() + ':' + d.lineNumber)) || '';
        const txt = d.text || 'exception';
        const exc = d.exception && d.exception.description;
        out.push(`${txt} ${loc} ${exc ? exc.split('\n').slice(0, 3).join(' | ') : ''}`.trim());
      }
    }
    return out;
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  const edge = findEdge();
  if (!edge) { console.error('Edge not found'); process.exit(1); }
  fs.mkdirSync(path.resolve(opts.out), { recursive: true });

  // Resolve a session cookie for --login (HttpOnly cookie set via CDP).
  let cookie = null;
  if (opts.login) {
    const res = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: opts.login, password: process.env.PE_DEMO_PASSWORD || 'PE-Demo-2026!' }),
    });
    const body = await res.json();
    if (!body.ok) { console.error('login failed:', body.message || body.code); process.exit(1); }
    const setCookie = res.headers.get('set-cookie') || '';
    const m = /pe_session=([^;]+)/.exec(setCookie);
    if (!m) { console.error('no session cookie in response'); process.exit(1); }
    cookie = m[1];
    console.log(`logged in as ${opts.login}`);
  }

  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pe-shot-'));
  const child = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*',
    '--user-data-dir=' + profile, '--window-size=' + opts.width + ',' + opts.height,
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const wsUrl = await getWsTarget();
    const cdp = new Cdp(wsUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    if (cookie) {
      await cdp.send('Network.enable');
      await cdp.send('Network.setCookie', { name: 'pe_session', value: cookie, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Strict' });
    }

    const results = [];
    for (const raw of opts.routes) {
      // SPA routes are hash-based: normalize 'dashboard' -> '#/dashboard'.
      const route = raw.includes('#') ? raw : '#/' + raw.replace(/^\/+/, '');
      const url = BASE + '/' + route;
      await cdp.send('Page.navigate', { url });
      // Let the SPA boot (bootstrap + view fetches).
      await sleep(route.includes('#') ? 5000 : 3000);
      const marker = await cdp.evaluate(`(() => {
        const root = document.getElementById('root');
        const text = document.body.innerText || '';
        const extras = ${JSON.stringify((process.env.PE_SHOT_EXTRAS || '').split('|').filter(Boolean))};
        const dom = {};
        for (const sel of extras) dom[sel] = !!document.querySelector(sel);
        return {
          bootSplash: !!document.querySelector('.boot-splash'),
          loginWrap: !!document.querySelector('.login-wrap'),
          shell: !!document.querySelector('.shell'),
          h1: (document.querySelector('h1') || {}).textContent || '',
          bodyLen: text.length,
          bodyHead: text.slice(0, 300),
          hasError: text.includes('错误') || text.includes('failed') || text.includes('Failed'),
          dom,
        };
      })()`);
      if (process.env.PE_SHOT_VERBOSE) {
        console.log('  bodyHead:', JSON.stringify(marker.bodyHead));
      }
      if (process.env.PE_SHOT_EXTRAS) {
        for (const [sel, present] of Object.entries(marker.dom || {})) {
          console.log(`  dom ${present ? 'OK ' : 'MISS'} ${sel}`);
        }
      }
      const shotName = route.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'home';
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(opts.out, `${String(results.length + 1).padStart(2, '0')}-${shotName}.png`), Buffer.from(shot.data, 'base64'));
      results.push({ route, shotName, ...marker });
      console.log(`[ok] ${route} -> ${shotName}.png | h1=${marker.h1} | body=${marker.bodyLen} chars | errors=${cdp.errors().length}`);
      cdp.events = [];
    }
    console.log('\nMarkers:');
    for (const r of results) {
      const ok = r.bootSplash === false && (r.loginWrap || r.shell) && r.bodyLen > 50;
      console.log(`  ${ok ? 'PASS' : 'FAIL'} ${r.route} boot=${r.bootSplash} h1="${r.h1}"`);
    }
  } finally {
    try { child.kill(); } catch { /* noop */ }
  }
}

if (require.main === module) main().catch((err) => { console.error('FATAL:', err.message); process.exit(1); });