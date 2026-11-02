// Antigravity Turn Navigator — plugin sidecar entry.
// Auto-launched from sidecars/panel/. Injects the turn sidebar via CDP (no
// app.asar changes) and serves a minimal side-panel page when the host
// provides a web port. Turn data comes from the conversation SQLite DB.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { startTurnNav } from './turn-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = process.env.AG_PROFILE
  || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort');

startTurnNav({ profile: PROFILE, widgetSource: readFileSync(join(HERE, 'turns-widget.js'), 'utf8') });

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><html><head><meta charset="utf-8">' +
      '<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#1e1f22;color:#e6e7ea;padding:16px;font-size:13px;line-height:1.7}' +
      'kbd{background:rgba(255,255,255,.1);border-radius:5px;padding:2px 6px;font-size:11px}b{color:#5b8cff}</style></head><body>' +
      '<b>轮次侧边栏</b><br>右侧面板列出当前会话的每一轮用户输入，点击跳到对应轮次。<br>' +
      '若看不到面板，用独立版 <kbd>run-turns.bat</kbd> 启动。</body></html>');
  });
  server.listen(port, '127.0.0.1', () => console.log('[turn-nav] panel on', port));
}
