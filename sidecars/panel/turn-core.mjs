// Antigravity Turn Navigator — data side (CDP injection + SQLite turn reader).
// Injects a sidebar listing every user turn of the current conversation. Turn
// text comes from the per-conversation SQLite DB (~/.gemini/antigravity/
// conversations/<id>.db, steps.step_type = 14 = user input). No app.asar edits.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CJK = /[\u3400-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/;
const SNAKE = /^[a-z0-9_]+$/;
const ART = /^(agy-customizations|antigravity_guide|automation|generative_ui|image\/png|JFIF|mntrRGB|https?:\/\/|data:)/i;

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method: 'GET' }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', c => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('timeout'))); req.end();
  });
}

export function discoverTargets(profile) {
  const text = readFileSync(profile, 'utf8');
  if (text.length > 1024) throw new Error('Invalid DevToolsActivePort');
  const port = Number(text.split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid renderer port');
  return httpGet(port, '/json/list').then(targets => {
    if (!Array.isArray(targets)) throw new Error('Invalid discovery response');
    return { port, targets: targets.filter(t => {
      try {
        const page = new URL(t.url), ws = new URL(t.webSocketDebuggerUrl);
        return t.type === 'page' && ['http:', 'https:'].includes(page.protocol) && LOOPBACK.has(page.hostname)
          && ws.protocol === 'ws:' && LOOPBACK.has(ws.hostname) && Number(ws.port) === port;
      } catch { return false; }
    }) };
  });
}

class Cdp {
  constructor(url, onEvent) { this.url = url; this.onEvent = onEvent; this.pending = new Map(); this.nextId = 0; this.closed = false; }
  open() {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === 'undefined') return reject(new Error('no WebSocket'));
      this.ws = new WebSocket(this.url);
      const timer = setTimeout(() => { this.close(); reject(new Error('connect timeout')); }, 5000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('connect failed')); }, { once: true });
      this.ws.addEventListener('message', ev => {
        try {
          const m = JSON.parse(ev.data);
          if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); clearTimeout(p.t); p.resolve(m.result); }
          else if (m.method) this.onEvent?.(this, m);
        } catch {}
      });
      this.ws.addEventListener('close', () => this.close());
    });
  }
  cmd(method, params = {}) {
    if (this.closed || this.ws?.readyState !== 1) return Promise.reject(new Error('disconnected'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('cmd timeout ' + method)); }, 6000);
      this.pending.set(id, { resolve, reject, t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { if (this.closed) return; this.closed = true; for (const p of this.pending.values()) { clearTimeout(p.t); p.reject(new Error('closed')); } this.pending.clear(); this.ws?.close(); }
}

// ---- SQLite turn reader ----
function runs(buf, minLen = 2) {
  const out = []; let cur = [];
  const push = () => { if (cur.length >= minLen) out.push(Buffer.from(cur)); cur = []; };
  for (let i = 0; i < buf.length; i++) { const b = buf[i]; if ((b >= 32 && b !== 127) || b >= 0xC0) cur.push(b); else push(); }
  push();
  return out.map(r => r.toString('utf8')).filter(s => !/\uFFFD/.test(s));
}
function score(s) { let n = 0; if (CJK.test(s)) n += 1000; if (/\s/.test(s)) n += 200; if (s.length > 6) n += 50; return n; }
function cleanPrompt(payload) {
  let cs = runs(Buffer.from(payload)).map(s => s.replace(/\s+/g, ' ').trim()).filter(s => s.length >= 1);
  cs = cs.filter(s => !UUID.test(s) && !(SNAKE.test(s) && s.includes('_')) && !ART.test(s) && !/^[0-9a-f]{8}-/.test(s) && !/^[A-Za-z0-9+/=]{40,}$/.test(s));
  const set = new Set(cs);
  const keep = cs.filter(s => !(s.length > 1 && set.has(s.slice(1))));
  keep.sort((a, b) => score(b) - score(a) || b.length - a.length);
  let s = keep[0] || '';
  // strip a trailing nested-string quote
  if (s.endsWith('"')) s = s.slice(0, -1);
  // strip a leading protobuf length byte: its value equals the byte length of the rest
  const c0 = s.charCodeAt(0), rest = s.slice(1);
  if (c0 < 128 && rest && Buffer.byteLength(rest, 'utf8') === c0) s = rest;
  return s.trim();
}
export async function readTurns(conversationId, dbDir = join(homedir(), '.gemini', 'antigravity', 'conversations')) {
  if (!UUID.test(conversationId)) throw new Error('bad conversation id');
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { throw new Error('此 Node 不支持 node:sqlite（需 22.5+）'); }
  const db = new DatabaseSync(join(dbDir, conversationId + '.db'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT idx, step_payload FROM steps WHERE step_type = 14 ORDER BY idx').all();
    return rows.map(r => ({ idx: r.idx, text: cleanPrompt(r.step_payload) }));
  } finally { db.close(); }
}

// ---- injection ----
export function startTurnNav({ profile, widgetSource, dbDir, log = console.log, interval = 2500 } = {}) {
  const BINDING = '__agTurnBridge';
  const sessions = new Map();
  // Derive the expected widget version from its source so style-only updates
  // re-inject automatically without restarting this sidecar.
  const expectedVersion = (widgetSource.match(/const VERSION = '([^']+)'/) || [])[1] || '';

  const onEvent = async (cdp, msg) => {
    if (msg.method === 'Runtime.executionContextsCleared') { cdp.contexts?.clear(); cdp.mounted = false; return; }
    if (msg.method === 'Runtime.executionContextCreated') {
      const p = msg.params?.context;
      if (p?.auxData?.isDefault) { cdp.contexts = cdp.contexts || new Set(); cdp.contexts.add(p.id); }
      return;
    }
    if (msg.method !== 'Runtime.bindingCalled' || msg.params?.name !== BINDING) return;
    let input;
    try { input = JSON.parse(msg.params.payload); } catch { return; }
    let result;
    try {
      if (input.type === 'turns' && input.conversationId) {
        const turns = await readTurns(input.conversationId, dbDir);
        result = { id: input.id, turns };
      } else result = { id: input.id, error: 'bad request' };
    } catch (e) { result = { id: input.id, error: String(e.message || e) }; }
    // Reply in the default main-world context (not the event's contextId, which
    // can be stale right after a conversation switch) so the widget always
    // receives the answer instead of timing out.
    cdp.cmd('Runtime.evaluate', { expression: `window.__agTurnResolve?.(${JSON.stringify(result)});` }).catch(() => {});
  };

  async function attach(target) {
    const cdp = new Cdp(target.webSocketDebuggerUrl, onEvent);
    cdp.contexts = new Set();
    await cdp.open();
    await cdp.cmd('Page.enable');
    await cdp.cmd('Runtime.enable');
    await cdp.cmd('Runtime.addBinding', { name: BINDING });
    await cdp.cmd('Page.addScriptToEvaluateOnNewDocument', { source: widgetSource });
    const r = await cdp.cmd('Runtime.evaluate', { expression: widgetSource });
    if (r.exceptionDetails) throw new Error('widget init failed');
    return cdp;
  }

  async function tick() {
    let disc;
    try { disc = await discoverTargets(profile); } catch { return; }
    const active = new Set(disc.targets.map(t => t.webSocketDebuggerUrl));
    for (const [url, c] of sessions) if (!active.has(url) || c.closed) { try { c.close(); } catch {} sessions.delete(url); }
    for (const t of disc.targets) {
      if (sessions.has(t.webSocketDebuggerUrl)) continue;
      try { const c = await attach(t); sessions.set(t.webSocketDebuggerUrl, c); log('[turn-nav] attached:', t.url); }
      catch (e) { log('[turn-nav] attach failed:', e.message); }
    }
    for (const [url, c] of sessions) {
      if (c.closed) continue;
      try {
        // Re-assert the binding each tick so it survives renderer navigations.
        await c.cmd('Runtime.addBinding', { name: BINDING }).catch(() => {});
        const st = await c.cmd('Runtime.evaluate', { returnByValue: true, expression: `Boolean(window.__agTurnNavInstalled && window.__agTurnNavVersion === ${JSON.stringify(expectedVersion)})` });
        if (st.exceptionDetails) { c.close(); sessions.delete(url); continue; }
        if (st.result?.value !== true) {
          const r = await c.cmd('Runtime.evaluate', { expression: widgetSource });
          if (r.exceptionDetails) { c.close(); sessions.delete(url); }
        }
      } catch { try { c.close(); } catch {} }
    }
  }

  log('[turn-nav] starting; profile =', profile);
  const safeTick = () => { tick().catch(e => log('[turn-nav] tick error:', e?.message || e)); };
  safeTick();
  const timer = setInterval(safeTick, interval);
  return { stop: () => { clearInterval(timer); for (const c of sessions.values()) try { c.close(); } catch {} } };
}
