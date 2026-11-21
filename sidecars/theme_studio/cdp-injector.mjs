// 通过本地 DevToolsActivePort / 调试端口孤立世界向 Antigravity 桌面端注入主题 CSS 与右侧自适应立绘
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { BUILTIN_EXPRESSIONS, BUILTIN_PORTRAITS } from './presets.mjs';
import { LocalTelemetry as DefaultLocalTelemetry } from './telemetry.mjs';

const execFileAsync = promisify(execFile);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const WORLD_NAME = 'agy-theme-studio';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function pickDifferent(pool, current) {
  if (!Array.isArray(pool) || pool.length === 0) return current;
  const candidates = pool.filter((id) => id !== current);
  const src = candidates.length > 0 ? candidates : pool;
  return src[Math.floor(Math.random() * src.length)];
}
const APP_CHECK = `(() => {
  try {
    if (window.top !== window) return false;
    if (!['http:', 'https:', 'file:', 'app:'].includes(location.protocol)) return false;
    let score = 0;
    if (window.__APP_CONFIG__) score += 2;
    if (document.querySelector('script[src="/main.js"], script[src*="main"][src$=".js"], script[type="module"][src*="index"]')) score += 2;
    if (document.querySelector('.agy-shell, .agy-sheet, .agy-composer-footer')) score += 2;
    if (document.getElementById('root') && document.querySelector('textarea, [contenteditable="true"]')) score += 1;
    if (document.title && /Antigravity/i.test(document.title)) score += 1;
    return score >= 3;
  } catch {
    return false;
  }
})()`;

export function profileDirectory({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Antigravity');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Antigravity');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Antigravity');
}

export function profileDirectories(opts = {}) {
  const env = opts.env || process.env;
  const dirs = [];
  if (env.ANTIGRAVITY_USER_DATA_DIR) dirs.push(env.ANTIGRAVITY_USER_DATA_DIR);
  const baseDir = profileDirectory(opts);
  dirs.push(baseDir);
  const parent = dirname(baseDir);
  for (const variant of ['Antigravity - Insiders', 'Antigravity Next', 'Antigravity Beta']) {
    dirs.push(join(parent, variant));
  }
  return [...new Set(dirs.filter(Boolean))];
}

export function parseCdpArgs(commandLine) {
  const cmd = String(commandLine || '');
  const ports = [];
  const userDataDirs = [];
  const portRe = /--remote-debugging-port(?:=|\s+)(\d+)/gi;
  let m;
  while ((m = portRe.exec(cmd)) !== null) {
    const port = Number(m[1]);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.push(port);
  }
  const dirRe = /--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"']+))/gi;
  while ((m = dirRe.exec(cmd)) !== null) {
    const dir = (m[1] || m[2] || m[3] || '').trim();
    if (dir) userDataDirs.push(dir);
  }
  return { ports: [...new Set(ports)], userDataDirs: [...new Set(userDataDirs)] };
}

function httpGetJson(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port) || 80,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : []);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('HTTP request timed out')));
    req.end();
  });
}

export class CompatWebSocket {
  constructor(url) {
    this.readyState = 0;
    this._listeners = new Map();
    this._buf = Buffer.alloc(0);
    this._fragChunks = [];
    this._socket = null;
    this._closed = false;

    const parsed = new URL(url);
    const key = randomBytes(16).toString('base64');
    const expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64');
    const port = Number(parsed.port) || 80;
    const path = `${parsed.pathname}${parsed.search}` || '/';

    const req = httpRequest({
      hostname: parsed.hostname,
      port,
      path,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Host: `${parsed.hostname}:${port}`,
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    this._req = req;

    req.on('upgrade', (res, socket, head) => {
      if (this._closed || res.headers['sec-websocket-accept'] !== expectedAccept) {
        try { socket.destroy(); } catch {}
        this._fail(new Error('WebSocket upgrade rejected'));
        return;
      }
      this._socket = socket;
      this.readyState = 1;
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (err) => this._fail(err));
      socket.on('close', () => this._finishClose());
      this._emit('open', {});
      if (head && head.length) this._onData(head);
    });
    req.on('response', (res) => {
      res.resume();
      this._fail(new Error(`Unexpected WebSocket status ${res.statusCode}`));
    });
    req.on('error', (err) => this._fail(err));
    req.end();
  }

  addEventListener(type, fn, opts = {}) {
    if (typeof fn !== 'function') return;
    let list = this._listeners.get(type);
    if (!list) {
      list = [];
      this._listeners.set(type, list);
    }
    list.push({ fn, once: !!opts?.once });
  }

  _emit(type, event) {
    const list = this._listeners.get(type);
    if (!list || list.length === 0) return;
    const remaining = [];
    for (const entry of [...list]) {
      if (!entry.once) remaining.push(entry);
    }
    this._listeners.set(type, remaining);
    for (const entry of [...list]) {
      try {
        entry.fn(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  _fail(err) {
    if (this._closed) return;
    this._emit('error', { error: err });
    this._finishClose();
  }

  _finishClose() {
    if (this._closed) return;
    this._closed = true;
    this.readyState = 3;
    this._emit('close', {});
  }

  _writeFrame(opcode, payloadBuf) {
    if (!this._socket || this._socket.destroyed) return;
    const len = payloadBuf.length;
    const mask = randomBytes(4);
    let hdr;
    if (len < 126) {
      hdr = Buffer.allocUnsafe(6);
      hdr[0] = 0x80 | opcode;
      hdr[1] = 0x80 | len;
      mask.copy(hdr, 2);
    } else if (len <= 0xffff) {
      hdr = Buffer.allocUnsafe(8);
      hdr[0] = 0x80 | opcode;
      hdr[1] = 0x80 | 126;
      hdr.writeUInt16BE(len, 2);
      mask.copy(hdr, 4);
    } else {
      hdr = Buffer.allocUnsafe(14);
      hdr[0] = 0x80 | opcode;
      hdr[1] = 0x80 | 127;
      hdr.writeBigUInt64BE(BigInt(len), 2);
      mask.copy(hdr, 10);
    }
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) {
      masked[i] = payloadBuf[i] ^ mask[i & 3];
    }
    this._socket.write(Buffer.concat([hdr, masked]));
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : Buffer.from(chunk);
    while (this._buf.length >= 2) {
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        len = Number(this._buf.readBigUInt64BE(2));
        offset = 10;
      }
      const need = offset + (masked ? 4 : 0) + len;
      if (this._buf.length < need) return;

      const maskKey = masked ? this._buf.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(this._buf.subarray(offset + (masked ? 4 : 0), need));
      this._buf = this._buf.subarray(need);

      if (maskKey) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this._writeFrame(0x0a, payload);
        continue;
      }
      if (opcode === 0x0a) continue;

      if (opcode !== 0x0) {
        this._fragChunks = [payload];
      } else {
        this._fragChunks.push(payload);
      }
      if (fin) {
        const full = Buffer.concat(this._fragChunks);
        this._fragChunks = [];
        this._emit('message', { data: full.toString('utf8') });
      }
    }
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('WebSocket is not open');
    this._writeFrame(0x01, Buffer.from(String(data), 'utf8'));
  }

  close() {
    if (this._closed) return;
    if (this.readyState === 1) {
      try {
        this._writeFrame(0x08, Buffer.alloc(0));
      } catch {
        // ignore
      }
    }
    try {
      this._req?.destroy();
    } catch {
      // ignore
    }
    try {
      this._socket?.end();
      this._socket?.destroy();
    } catch {
      // ignore
    }
    this._finishClose();
  }
}

function createWebSocket(url) {
  return typeof globalThis.WebSocket === 'function' ? new globalThis.WebSocket(url) : new CompatWebSocket(url);
}

function isAppWindow(target, port) {
  try {
    const page = new URL(target.url);
    const socket = new URL(target.webSocketDebuggerUrl);
    const isWeb = ['http:', 'https:'].includes(page.protocol) && LOOPBACK.has(page.hostname);
    const isPackaged = ['file:', 'app:'].includes(page.protocol);
    return (
      target.type === 'page' &&
      (isWeb || isPackaged) &&
      socket.protocol === 'ws:' &&
      LOOPBACK.has(socket.hostname) &&
      Number(socket.port) === port
    );
  } catch {
    return false;
  }
}

class CdpSession {
  constructor(url, onEvent, onClose) {
    this.url = url;
    this.onEvent = onEvent;
    this.onClose = onClose;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.contextId = null;
    this.knownImageHashes = new Set();
    this.sentExprHash = null;
    this.sentBgHash = null;
    this.controllerReady = false;
  }

  open(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const ws = createWebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP connection timed out'));
      }, timeout);
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve(this);
        },
        { once: true }
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP connection failed'));
        },
        { once: true }
      );
      ws.addEventListener('close', () => this.dispose());
      ws.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.id) {
          const item = this.pending.get(msg.id);
          if (!item) return;
          this.pending.delete(msg.id);
          clearTimeout(item.timer);
          if (msg.error) item.reject(new Error(msg.error.message || 'CDP error'));
          else item.resolve(msg.result || {});
        } else if (msg.method) {
          this.onEvent?.(this, msg);
        }
      });
    });
  }

  command(method, params = {}, timeout = 8000) {
    if (this.closed || this.ws?.readyState !== 1) return Promise.reject(new Error('CDP disconnected'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('CDP disconnected'));
    }
    this.pending.clear();
    this.onClose?.(this);
  }

  close() {
    this.dispose();
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}

function mimeForExt(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml';
  return 'image/png';
}

function buildThemeCss(theme, settings, hasCustomBg = false) {
  const p = theme.palette;
  const e = settings.effects;
  const pr = settings.portrait;
  const radius = `${e.borderRadius}px`;
  const blur = `${e.glassBlur}px`;
  const isDark = theme.scheme === 'dark';
  const bgImgOp = Math.min(1, Math.max(0.1, Number(e.customBgOpacity ?? 0.48)));
  const washPct = Math.round((1 - bgImgOp) * 100);
  const fontDecl = e.fontFamily
    ? `--ats-font: ${e.fontFamily}, "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif;`
    : '';

  const syntaxVars = isDark
    ? `
  --syntax-default-fg: #EFEAFF !important;
  --syntax-comment: #A294C7 !important;
  --syntax-string: #B4E8A8 !important;
  --syntax-function: #FF9EC7 !important;
  --syntax-tag: #E2A6FF !important;
  --syntax-property: #C7B2FF !important;
  --syntax-attr-name: #C2EB9F !important;
  --syntax-attr-value: #9BD4FF !important;
  --syntax-builtin: #A8E5B8 !important;
  --syntax-regex: #FFD28A !important;
  --code-foreground: #E3D9FF !important;
  --color-code: #E3D9FF !important;
  --placeholder: #ABA0CC !important;
  --color-placeholder: #ABA0CC !important;`
    : `
  --syntax-default-fg: #2B1F47 !important;
  --code-foreground: color-mix(in oklab, ${p.foreground} 78%, ${p.accent}) !important;
  --color-code: color-mix(in oklab, ${p.foreground} 78%, ${p.accent}) !important;`;

  return `
:root,
body,
body.theme-light,
body.theme-dark {
  color-scheme: ${isDark ? 'dark' : 'light'} !important;
  --background: ${p.bgPage} !important;
  --color-background: ${p.bgPage} !important;
  --content: ${p.bgPage} !important;
  --shell: ${p.bgSidebar} !important;
  --sidebar: ${p.bgSidebar} !important;
  --color-sidebar: ${p.bgSidebar} !important;
  --sidebar-muted: color-mix(in srgb, ${p.accent} 10%, transparent) !important;
  --color-sidebar-muted: color-mix(in srgb, ${p.accent} 10%, transparent) !important;
  --color-sidebar-secondary: color-mix(in srgb, ${p.accent} 14%, transparent) !important;
  --foreground: ${p.foreground} !important;
  --card: ${p.bgCard} !important;
  --color-card: ${p.bgCard} !important;
  --card-foreground: ${p.foreground} !important;
  --card-border: ${p.border} !important;
  --color-card-border: ${p.border} !important;
  --onyx-raised: ${p.bgCard} !important;
  --onyx-frame: ${p.bgSidebar} !important;
  --onyx-key: ${p.bgCard} !important;
  --popover: ${p.bgCard} !important;
  --popover-foreground: ${p.foreground} !important;
  --primary: ${p.accent} !important;
  --color-primary: ${p.accent} !important;
  --primary-foreground: ${p.accentForeground} !important;
  --color-primary-foreground: ${p.accentForeground} !important;
  --secondary: ${p.bgCardUser} !important;
  --color-secondary: ${p.bgCardUser} !important;
  --secondary-foreground: ${p.foreground} !important;
  --color-secondary-foreground: ${p.foreground} !important;
  --muted: color-mix(in srgb, ${p.accent} 9%, transparent) !important;
  --color-muted: color-mix(in srgb, ${p.accent} 9%, transparent) !important;
  --muted-foreground: ${p.mutedForeground} !important;
  --accent: ${p.bgCardUser} !important;
  --accent-foreground: ${p.foreground} !important;
  --border: ${p.border} !important;
  --glass-border: ${p.border} !important;
  --input: ${p.border} !important;
  --ring: ${p.accent} !important;
  --focus-ring-color: color-mix(in srgb, ${p.accent} 45%, transparent) !important;
  --nux-focus-ring: color-mix(in srgb, ${p.accent} 55%, transparent) !important;
  --home-glow: color-mix(in srgb, ${p.accent} 14%, transparent) !important;
  --editor-code-block-background: ${p.bgCode} !important;
  --editor-selection-background: ${p.selectionBg} !important;
  --bg-selection-overlay: ${p.selectionBg} !important;
  --focus-ring-offset-color: ${p.bgPage} !important;
  ${syntaxVars}
  ${fontDecl}
}

html, body, #root, .agy-shell {
  background-color: ${p.bgPage} !important;
  ${hasCustomBg
    ? `background-image: linear-gradient(155deg, color-mix(in srgb, ${p.bgPage} ${washPct}%, transparent) 0%, color-mix(in srgb, ${p.bgGradientEnd} ${washPct}%, transparent) 100%), var(--ats-custom-bg, none) !important;
  background-size: 100% 100%, cover !important;
  background-position: center, center !important;
  background-repeat: no-repeat, no-repeat !important;
  background-attachment: fixed, fixed !important;`
    : `background-image: linear-gradient(145deg, ${p.bgPage} 0%, ${p.bgGradientEnd} 100%) !important;`}
  color: ${p.foreground} !important;
  ${e.fontFamily ? 'font-family: var(--ats-font) !important;' : ''}
}

.agy-inset-shell,
[data-ats-shell="1"] {
  background-color: ${hasCustomBg ? 'transparent' : `color-mix(in srgb, ${p.bgSidebar} 90%, transparent)`} !important;
}

/* 主对话画布与内层容器：有自定义背景时全透明直接透出画布背景图 */
.agy-inset-shell > div.flex-1,
.agy-sheet,
.agy-sheet > div > div:first-child,
.agy-sheet > div > div:first-child div.flex-1.min-h-0.flex.flex-col,
.agy-sheet > div > div:last-child div.flex-grow,
.agy-sheet > div > div:last-child div.flex-grow > div,
.agy-sheet .browser-hole-opaque,
[data-ats-canvas="1"],
[data-ats-transparent="1"] {
  background: ${hasCustomBg ? 'transparent' : `linear-gradient(155deg, ${p.bgPage} 0%, ${p.bgGradientEnd} 100%)`} !important;
}

/* 对话气泡与卡片 */
[class*="message" i][class*="user" i],
[data-role="user"] {
  background-color: color-mix(in srgb, ${p.bgCardUser} ${hasCustomBg ? '78' : '88'}%, transparent) !important;
  border-radius: ${radius} !important;
  border-color: ${p.border} !important;
}

.bg-card,
[role="dialog"],
[role="menu"] {
  background-color: color-mix(in srgb, ${p.bgCard} ${hasCustomBg ? '82' : '94'}%, transparent) !important;
  ${hasCustomBg ? 'backdrop-filter: blur(8px) saturate(1.1) !important; -webkit-backdrop-filter: blur(8px) saturate(1.1) !important;' : ''}
  border-color: ${p.border} !important;
  border-radius: ${radius} !important;
}

/* 底部输入栏毛玻璃效果 */
form:has(.agy-composer-footer),
div:has(> .agy-composer-footer),
[data-ats-composer="1"] {
  background-color: color-mix(in srgb, ${p.bgInput} ${Math.round(e.glassOpacity * 100)}%, transparent) !important;
  backdrop-filter: blur(${blur}) saturate(1.25) !important;
  -webkit-backdrop-filter: blur(${blur}) saturate(1.25) !important;
  border-color: ${p.border} !important;
  border-radius: ${radius} !important;
  box-shadow: 0 8px 28px ${isDark ? 'rgba(18, 10, 36, 0.36)' : 'rgba(92, 66, 158, 0.14)'} !important;
}

/* 代码块美化 */
pre,
pre code,
.hljs {
  background-color: ${p.bgCode} !important;
  border-color: ${p.border} !important;
  border-radius: ${Math.max(8, e.borderRadius - 2)}px !important;
}
pre {
  border: 1px solid ${p.border} !important;
}

/* 选中文本高亮 */
::selection {
  background: ${p.selectionBg} !important;
}

/* 紫韵细滚动条 */
::-webkit-scrollbar {
  width: 7px;
  height: 7px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: ${p.scrollbarThumb};
  border-radius: 999px;
}
::-webkit-scrollbar-thumb:hover {
  background: ${p.accent};
}

/* 右侧成年版哈基米立绘与星空装饰层 */
#agy-theme-studio-backdrop {
  position: fixed;
  inset: 0;
  pointer-events: none !important;
  user-select: none !important;
  z-index: 4;
  overflow: hidden;
  contain: layout style;
}

#agy-theme-studio-portrait-wrap {
  position: absolute;
  right: ${pr.offsetRight}px;
  bottom: ${pr.offsetBottom}px;
  height: min(64vh, 660px);
  transform-origin: bottom right;
  transform: translate3d(calc(-1 * var(--ats-aux-shift, 0px)), 0, 0) scale(${pr.scale});
  opacity: ${pr.enabled ? pr.opacity : 0};
  will-change: transform, opacity;
  transition: opacity 0.24s ease, transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
  pointer-events: none !important;
}

#agy-theme-studio-backdrop[data-aux-dragging="true"] #agy-theme-studio-portrait-wrap {
  transition: opacity 0.18s ease;
}

#agy-theme-studio-backdrop[data-aux-open="true"] #agy-theme-studio-portrait-wrap {
  opacity: ${pr.enabled ? pr.auxAvoidOpacity : 0};
}

#agy-theme-studio-portrait {
  -webkit-mask-image:
    linear-gradient(to top, transparent 0%, #000 ${pr.featherBottom}%, #000 100%),
    linear-gradient(to right, transparent 0%, #000 ${pr.featherLeft}%, #000 100%);
  -webkit-mask-composite: source-in;
  mask-image:
    linear-gradient(to top, transparent 0%, #000 ${pr.featherBottom}%, #000 100%),
    linear-gradient(to right, transparent 0%, #000 ${pr.featherLeft}%, #000 100%);
  mask-composite: intersect;
}

#agy-theme-studio-portrait,
#agy-theme-studio-canvas,
#agy-theme-studio-shadow {
  display: block;
  height: 100%;
  width: auto;
  max-width: 34vw;
  object-fit: contain;
  transform: translateZ(0)${pr.flipX ? ' scaleX(-1)' : ''};
  backface-visibility: hidden;
  pointer-events: none !important;
}

#agy-theme-studio-shadow {
  position: absolute;
  top: -8%;
  left: -8%;
  width: 116%;
  height: 116%;
  max-width: none;
  z-index: 0;
  transform: translateZ(0);
  -webkit-mask-image:
    linear-gradient(to top, transparent 0%, #000 ${pr.featherBottom}%, #000 100%),
    linear-gradient(to right, transparent 0%, #000 ${pr.featherLeft}%, #000 100%);
  -webkit-mask-composite: source-in;
  mask-image:
    linear-gradient(to top, transparent 0%, #000 ${pr.featherBottom}%, #000 100%),
    linear-gradient(to right, transparent 0%, #000 ${pr.featherLeft}%, #000 100%);
  mask-composite: intersect;
}

#agy-theme-studio-portrait,
#agy-theme-studio-canvas {
  position: relative;
  z-index: 1;
}

#agy-theme-studio-canvas {
  position: absolute;
  top: -8%;
  left: -8%;
  width: 116%;
  height: 116%;
  max-width: none;
  display: none;
}

/* 顶部标题栏右侧自定义背景开关 */
#agy-theme-studio-topbar-pill {
  position: fixed;
  top: 41px;
  right: 112px;
  height: 26px;
  padding: 2px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  border-radius: 999px;
  border: 1px solid ${p.border};
  background: color-mix(in srgb, ${p.bgCard} 82%, transparent);
  backdrop-filter: blur(10px) saturate(1.2);
  -webkit-backdrop-filter: blur(10px) saturate(1.2);
  user-select: none;
  pointer-events: auto;
  -webkit-app-region: no-drag;
  z-index: 40;
  box-shadow: 0 2px 10px ${isDark ? 'rgba(12, 8, 24, 0.28)' : 'rgba(92, 66, 158, 0.12)'};
  transition: border-color 0.16s ease, background-color 0.16s ease, opacity 0.16s ease;
}
#agy-theme-studio-topbar-pill:hover {
  border-color: ${p.accent};
}
#agy-theme-studio-topbar-pill button {
  appearance: none;
  border: none;
  background: transparent;
  color: ${p.foreground};
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: background-color 0.14s ease, color 0.14s ease;
}
#agy-theme-studio-topbar-pill button:hover {
  background: color-mix(in srgb, ${p.accent} 16%, transparent);
}
#agy-theme-studio-topbar-pill button.is-on {
  background: ${p.accent};
  color: ${p.accentForeground};
}
#agy-theme-studio-topbar-pill button#ats-bg-clear {
  padding: 0 6px;
  opacity: 0.72;
}
#agy-theme-studio-topbar-pill button#ats-bg-clear:hover {
  opacity: 1;
}
#agy-theme-studio-topbar-pill button#ats-random-look {
  padding: 0 5px;
  min-width: 24px;
  justify-content: center;
  overflow: visible;
}
#agy-theme-studio-topbar-pill .ats-die-scene {
  width: 14px;
  height: 14px;
  perspective: 68px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: visible;
}
#agy-theme-studio-topbar-pill .ats-die-cube {
  width: 12px;
  height: 12px;
  position: relative;
  transform-style: preserve-3d;
  transition: transform 0.56s cubic-bezier(0.22, 1.18, 0.36, 1);
}
#agy-theme-studio-topbar-pill .ats-die-face {
  position: absolute;
  inset: 0;
  border-radius: 2.5px;
  display: grid;
  grid-template: repeat(3, 1fr) / repeat(3, 1fr);
  padding: 1.5px;
  box-sizing: border-box;
  place-items: center;
  backface-visibility: hidden;
  background: color-mix(in srgb, ${p.bgCard} 94%, #ffffff);
  border: 1px solid color-mix(in srgb, ${p.accent} 62%, ${p.border});
  box-shadow: inset 0 0 2px color-mix(in srgb, ${p.accent} 20%, transparent);
}
#agy-theme-studio-topbar-pill .ats-pip {
  width: 2.1px;
  height: 2.1px;
  border-radius: 50%;
  background: ${p.accent};
}
#agy-theme-studio-topbar-pill .ats-pip.is-one {
  width: 3.5px;
  height: 3.5px;
  background: #e84c7f;
}
#agy-theme-studio-topbar-pill .ats-pill-sep {
  width: 1px;
  height: 12px;
  flex-shrink: 0;
  background: color-mix(in srgb, ${p.border} 90%, transparent);
  margin: 0 1px;
}
`;
}

// 注入到孤立世界的轻量控制器（原生函数序列化，避免手写模板字符串转义错误）
function pageController(payload) {
  const STYLE_ID = 'agy-theme-studio-style';
  const ADAPT_STYLE_ID = 'agy-theme-studio-adapt-style';
  const BG_LAYER_ID = 'agy-theme-studio-bg-layer';
  const BACKDROP_ID = 'agy-theme-studio-backdrop';
  const PILL_ID = 'agy-theme-studio-topbar-pill';

  function teardown() {
    const wrapEl = document.getElementById('agy-theme-studio-portrait-wrap');
    if (wrapEl) {
      wrapEl.style.removeProperty('--ats-yield-mul');
    }
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById(ADAPT_STYLE_ID)?.remove();
    document.getElementById(BG_LAYER_ID)?.remove();
    document.getElementById(BACKDROP_ID)?.remove();
    document.getElementById(PILL_ID)?.remove();
    for (const attr of ['data-ats-composer', 'data-ats-canvas', 'data-ats-shell', 'data-ats-transparent']) {
      for (const el of document.querySelectorAll('[' + attr + ']')) el.removeAttribute(attr);
    }
    document.documentElement.removeAttribute('data-agy-theme-studio');
    document.documentElement.style.removeProperty('color-scheme');
    document.documentElement.style.removeProperty('--ats-custom-bg');
    document.documentElement.style.removeProperty('--ats-yield-mul');
    delete document.documentElement.dataset.atsBgHash;
    if (window.__atsObserver) {
      window.__atsObserver.disconnect();
      window.__atsObserver = null;
    }
    if (window.__atsResizeObs) {
      window.__atsResizeObs.disconnect();
      window.__atsResizeObs = null;
    }
    if (window.__atsResizeHandler) {
      window.removeEventListener('resize', window.__atsResizeHandler);
      window.__atsResizeHandler = null;
    }
    if (window.__atsPointerHandler) {
      document.removeEventListener('pointerdown', window.__atsPointerHandler, true);
      window.__atsPointerHandler = null;
      window.__atsPointerVer = 0;
    }
    if (window.__atsKeyHandler) {
      document.removeEventListener('keydown', window.__atsKeyHandler, true);
      window.__atsKeyHandler = null;
    }
    if (window.__atsWheelHandler) {
      document.removeEventListener('wheel', window.__atsWheelHandler, true);
      window.__atsWheelHandler = null;
      window.__atsWheelVer = 0;
    }
    if (window.__atsMoveHandler) {
      document.removeEventListener('pointermove', window.__atsMoveHandler, true);
      window.__atsMoveHandler = null;
      window.__atsMoveVer = 0;
    }
    if (window.__atsSelHandler) {
      document.removeEventListener('selectionchange', window.__atsSelHandler);
      window.__atsSelHandler = null;
    }
    if (window.__atsFocusHandler) {
      window.removeEventListener('focus', window.__atsFocusHandler);
      window.__atsFocusHandler = null;
    }
    if (window.__atsVisHandler) {
      document.removeEventListener('visibilitychange', window.__atsVisHandler);
      window.__atsVisHandler = null;
    }
    if (window.__atsBounceRaf) {
      cancelAnimationFrame(window.__atsBounceRaf);
      window.__atsBounceRaf = 0;
    }
    clearTimeout(window.__atsDragTimer);
    window.__atsDragTimer = null;
    clearTimeout(window.__atsDyn?.transTimer);
    window.__atsLastShift = 0;
    window.__atsUpdateLayout = null;
    window.__atsTopBarEl = null;
    window.__atsLocalExprLock = null;
    window.__atsDiscoveredVars = null;
    window.__atsDiscoveredSig = null;
    window.__atsBounce = null;
    window.__atsDyn = null;
    window.__atsOnSignal = null;
    window.__atsBgRim = null;
    window.__atsBgSampleHash = '';
    window.__atsShowCustomBg = false;
    window.__atsBgHash = '';
    window.__atsPhase = 'day';
    window.__atsMode = 'auto';
    window.__atsDesiredHash = '';
    window.__atsPendingLoads = null;
    window.__atsRefreshExpr = null;
  }

  if (!payload || payload.enabled === false) {
    teardown();
    return { ok: true, state: 'disabled' };
  }

  // 1. 更新样式标签
  let styleEl = document.getElementById(STYLE_ID);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(styleEl);
  }
  if (styleEl.textContent !== payload.css) {
    styleEl.textContent = payload.css;
  }
  document.documentElement.setAttribute('data-agy-theme-studio', payload.phase);

  // 2. 更新画布自定义背景图 CSS 变量、右侧立绘容器与顶部自定义背景开关
  document.getElementById(BG_LAYER_ID)?.remove();
  let needBgImage = false;
  if (payload.showCustomBg) {
    const hasSameBg =
      document.documentElement.dataset.atsBgHash === (payload.bgHash || '') &&
      !!document.documentElement.style.getPropertyValue('--ats-custom-bg');
    if (payload.bgDataUrl && !hasSameBg) {
      document.documentElement.dataset.atsBgHash = payload.bgHash || '';
      document.documentElement.style.setProperty('--ats-custom-bg', 'url("' + payload.bgDataUrl + '")');
    } else if (!hasSameBg) {
      needBgImage = true;
    }
  } else {
    document.documentElement.style.removeProperty('--ats-custom-bg');
    delete document.documentElement.dataset.atsBgHash;
  }

  // 清理旧版误挂在 html 根节点的全局样式变量，避免引发整页样式继承失效
  document.documentElement.style.removeProperty('--ats-yield-mul');

  let backdrop = document.getElementById(BACKDROP_ID);
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = BACKDROP_ID;

    const wrap = document.createElement('div');
    wrap.id = 'agy-theme-studio-portrait-wrap';
    const shadow = document.createElement('canvas');
    shadow.id = 'agy-theme-studio-shadow';
    const img = document.createElement('img');
    img.id = 'agy-theme-studio-portrait';
    img.alt = '';
    img.draggable = false;
    const canvas = document.createElement('canvas');
    canvas.id = 'agy-theme-studio-canvas';
    wrap.appendChild(shadow);
    wrap.appendChild(img);
    wrap.appendChild(canvas);

    backdrop.appendChild(wrap);
    document.body.appendChild(backdrop);
  } else {
    document.getElementById('agy-theme-studio-stars')?.remove();
  }

  window.__atsHasSavedBg = !!payload.hasSavedBg;
  window.__atsCustomBgOn = !!payload.customBgEnabled;

  let topPill = document.getElementById(PILL_ID);
  if (!topPill || !topPill.querySelector('#ats-bg-toggle') || !topPill.querySelector('#ats-random-look .ats-die-cube')) {
    topPill?.remove();
    topPill = document.createElement('div');
    topPill.id = PILL_ID;

    const pipLayouts = {
      1: [[2, 2]],
      2: [[1, 3], [3, 1]],
      3: [[1, 3], [2, 2], [3, 1]],
      4: [[1, 1], [1, 3], [3, 1], [3, 3]],
      5: [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3]],
      6: [[1, 1], [1, 3], [2, 1], [2, 3], [3, 1], [3, 3]],
    };
    const facePose = {
      1: { faceXf: 'translateZ(6px)', rx: 0, ry: 0 },
      2: { faceXf: 'rotateX(90deg) translateZ(6px)', rx: -90, ry: 0 },
      3: { faceXf: 'rotateY(90deg) translateZ(6px)', rx: 0, ry: -90 },
      4: { faceXf: 'rotateY(-90deg) translateZ(6px)', rx: 0, ry: 90 },
      5: { faceXf: 'rotateX(-90deg) translateZ(6px)', rx: 90, ry: 0 },
      6: { faceXf: 'rotateY(180deg) translateZ(6px)', rx: 0, ry: 180 },
    };

    const randomBtn = document.createElement('button');
    randomBtn.id = 'ats-random-look';
    randomBtn.type = 'button';
    const scene = document.createElement('span');
    scene.className = 'ats-die-scene';
    const cube = document.createElement('span');
    cube.className = 'ats-die-cube';
    for (let f = 1; f <= 6; f++) {
      const faceEl = document.createElement('span');
      faceEl.className = 'ats-die-face';
      faceEl.style.transform = facePose[f].faceXf;
      for (const [r, c] of pipLayouts[f]) {
        const pip = document.createElement('span');
        pip.className = f === 1 ? 'ats-pip is-one' : 'ats-pip';
        pip.style.gridArea = r + ' / ' + c;
        faceEl.appendChild(pip);
      }
      cube.appendChild(faceEl);
    }
    scene.appendChild(cube);
    randomBtn.appendChild(scene);

    if (!window.__atsDieState) {
      window.__atsDieState = { face: 1 + Math.floor(Math.random() * 6), kX: 0, kY: 0 };
    }
    const initPose = facePose[window.__atsDieState.face] || facePose[1];
    cube.style.transform = 'rotateX(' + (initPose.rx + window.__atsDieState.kX * 360) + 'deg) rotateY(' + (initPose.ry + window.__atsDieState.kY * 360) + 'deg)';
    randomBtn.title = '当前 ' + window.__atsDieState.face + ' 点 · 点击掷骰随机切换穿搭与表情';

    randomBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const st = window.__atsDieState || { face: 1, kX: 0, kY: 0 };
      const candidates = [1, 2, 3, 4, 5, 6].filter((n) => n !== st.face);
      const nextFace = candidates[Math.floor(Math.random() * candidates.length)];
      st.face = nextFace;
      st.kX += 1 + Math.floor(Math.random() * 2);
      st.kY += 1 + Math.floor(Math.random() * 2);
      window.__atsDieState = st;
      const pose = facePose[nextFace];
      cube.style.transform = 'rotateX(' + (pose.rx + st.kX * 360) + 'deg) rotateY(' + (pose.ry + st.kY * 360) + 'deg)';
      randomBtn.title = '掷出 ' + nextFace + ' 点 · 点击随机切换穿搭与表情';
      if (scene.animate) {
        scene.animate(
          [
            { transform: 'translateY(0px) scale(1)' },
            { transform: 'translateY(-2.5px) scale(1.16)', offset: 0.42 },
            { transform: 'translateY(0.5px) scale(0.96)', offset: 0.8 },
            { transform: 'translateY(0px) scale(1)' },
          ],
          { duration: 520, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
        );
      }
      if (typeof window.__atsBridge === 'function') {
        window.__atsBridge(JSON.stringify({ action: 'randomLook' }));
      }
    });

    const sep = document.createElement('span');
    sep.className = 'ats-pill-sep';

    const toggleBtn = document.createElement('button');
    toggleBtn.id = 'ats-bg-toggle';
    toggleBtn.type = 'button';
    toggleBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (typeof window.__atsBridge !== 'function') return;
      if (!window.__atsHasSavedBg) {
        window.__atsBridge(JSON.stringify({ action: 'pickCustomBg' }));
      } else {
        const nextOn = !window.__atsCustomBgOn;
        window.__atsCustomBgOn = nextOn;
        window.__atsBridge(JSON.stringify({ effects: { customBgEnabled: nextOn } }));
      }
    });

    const pickBtn = document.createElement('button');
    pickBtn.id = 'ats-bg-pick';
    pickBtn.type = 'button';
    pickBtn.textContent = '换图';
    pickBtn.title = '选择图片替换整个 Antigravity 底层背景';
    pickBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (typeof window.__atsBridge === 'function') {
        window.__atsBridge(JSON.stringify({ action: 'pickCustomBg' }));
      }
    });

    const clearBtn = document.createElement('button');
    clearBtn.id = 'ats-bg-clear';
    clearBtn.type = 'button';
    clearBtn.textContent = '✕';
    clearBtn.title = '清除自定义背景图';
    clearBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (typeof window.__atsBridge === 'function') {
        window.__atsBridge(JSON.stringify({ effects: { customBgEnabled: false, customBgImage: '' } }));
      }
    });

    topPill.appendChild(randomBtn);
    topPill.appendChild(sep);
    topPill.appendChild(toggleBtn);
    topPill.appendChild(pickBtn);
    topPill.appendChild(clearBtn);
    document.body.appendChild(topPill);
  }

  const toggleEl = topPill.querySelector('#ats-bg-toggle');
  const pickEl = topPill.querySelector('#ats-bg-pick');
  const clearEl = topPill.querySelector('#ats-bg-clear');
  if (toggleEl) {
    if (!window.__atsHasSavedBg) {
      toggleEl.textContent = '🖼 自定义背景';
      toggleEl.classList.remove('is-on');
      toggleEl.title = '点击选择图片作为 Antigravity 最底层背景';
    } else if (window.__atsCustomBgOn) {
      toggleEl.textContent = '🖼 背景 · 开';
      toggleEl.classList.add('is-on');
      toggleEl.title = '点击关闭自定义背景图（保留已选图片）';
    } else {
      toggleEl.textContent = '🖼 背景 · 关';
      toggleEl.classList.remove('is-on');
      toggleEl.title = '点击重新开启已选背景图';
    }
  }
  if (pickEl) pickEl.style.display = window.__atsHasSavedBg ? 'inline-flex' : 'none';
  if (clearEl) clearEl.style.display = window.__atsHasSavedBg ? 'inline-flex' : 'none';

  const imgEl = document.getElementById('agy-theme-studio-portrait');
  let shadowEl = document.getElementById('agy-theme-studio-shadow');
  if (!shadowEl && imgEl?.parentElement) {
    shadowEl = document.createElement('canvas');
    shadowEl.id = 'agy-theme-studio-shadow';
    imgEl.parentElement.insertBefore(shadowEl, imgEl);
  }
  let canvasEl = document.getElementById('agy-theme-studio-canvas');
  if (!canvasEl && imgEl?.parentElement) {
    canvasEl = document.createElement('canvas');
    canvasEl.id = 'agy-theme-studio-canvas';
    imgEl.parentElement.appendChild(canvasEl);
  }
  window.__atsClickBounce = payload.clickBounce !== false;
  window.__atsBounceRange = Number.isFinite(Number(payload.clickBounceRange)) ? Number(payload.clickBounceRange) : 0.45;
  window.__atsIdleAmp = payload.idleMotion !== false ? Math.min(2.0, Math.max(0.5, Number(payload.idleMotionAmp ?? 0.75))) : 0;
  window.__atsMicroMotion = payload.microMotion !== false;
  window.__atsAmbientLight = payload.ambientLight !== false;
  window.__atsPhase = payload.phase === 'night' ? 'night' : 'day';
  window.__atsMode = payload.mode || 'auto';
  window.__atsAiCompanion = payload.aiCompanion !== false;
  window.__atsFlipX = payload.flipX === true;
  window.__atsPortraitScale = Number.isFinite(Number(payload.portraitScale)) && Number(payload.portraitScale) > 0 ? Number(payload.portraitScale) : 1;
  window.__atsShowPortrait = !!payload.showPortrait;
  window.__atsShowCustomBg = !!payload.showCustomBg;
  window.__atsBgHash = payload.bgHash || '';
  window.__atsOutfitKey = typeof payload.outfitKey === 'string' ? payload.outfitKey : '';
  window.__atsFeather = {
    left: Math.max(0, Math.min(45, Number(payload.featherLeft ?? 14))) / 100,
    bottom: Math.max(0, Math.min(45, Number(payload.featherBottom ?? 12))) / 100,
  };
  window.__atsAllowExpr = !!payload.allowExpression;
  window.__atsClickExpr = payload.clickExpression !== false;
  const rawAnchor = payload.exprAnchor && typeof payload.exprAnchor === 'object' ? payload.exprAnchor : null;
  window.__atsExprAnchor = {
    dx: Number.isFinite(Number(rawAnchor?.dx)) ? Number(rawAnchor.dx) : Number(payload.exprOffsetX || 0),
    dy: Number.isFinite(Number(rawAnchor?.dy)) ? Number(rawAnchor.dy) : 0,
    scale: Number.isFinite(Number(rawAnchor?.scale)) && Number(rawAnchor.scale) > 0 ? Number(rawAnchor.scale) : 1,
  };
  const nextBaseExpr = typeof payload.expression === 'string' && payload.expression ? payload.expression : 'default';
  const exprLock = window.__atsLocalExprLock;
  if (exprLock && performance.now() - exprLock.at < 6000) {
    if (nextBaseExpr === exprLock.expr) {
      window.__atsLocalExprLock = null;
      window.__atsBaseExpr = nextBaseExpr;
    } else if (nextBaseExpr === exprLock.prevExpr) {
      // 防止 3 秒轮询竞态把刚戳头切换的新表情覆写回旧表情；若超过 1.2s 未同步则补发一次写回
      window.__atsBaseExpr = exprLock.expr;
      if (!exprLock.retried && performance.now() - exprLock.at > 1200 && typeof window.__atsBridge === 'function') {
        exprLock.retried = true;
        window.__atsBridge(JSON.stringify({ portrait: { expression: exprLock.expr } }));
      }
    } else {
      window.__atsLocalExprLock = null;
      window.__atsBaseExpr = nextBaseExpr;
    }
  } else {
    window.__atsLocalExprLock = null;
    window.__atsBaseExpr = nextBaseExpr;
  }

  function parseHexRgb(hex, fallback) {
    if (typeof hex === 'string' && /^#[0-9a-f]{6}$/i.test(hex.trim())) {
      const n = parseInt(hex.trim().slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return fallback;
  }
  const ac = parseHexRgb(payload.accentColor, [124, 92, 230]);
  window.__atsAccentRgb = [ac[0] / 255, ac[1] / 255, ac[2] / 255];

  if (!window.__atsExprPack) {
    window.__atsExprPack = { hash: '', imgs: {} };
  }
  if (!window.__atsPortraitCache) {
    window.__atsPortraitCache = { order: [], map: {} };
  }

  if (payload.showCustomBg && payload.bgDataUrl && payload.bgHash && (window.__atsBgSampleHash !== payload.bgHash || window.__atsBgRim?.ver !== 2)) {
    window.__atsBgSampleHash = payload.bgHash;
    const bgS = new Image();
    bgS.onload = () => {
      try {
        const sc = document.createElement('canvas');
        sc.width = 16;
        sc.height = 16;
        const sctx = sc.getContext('2d', { willReadFrequently: true });
        sctx.drawImage(bgS, 0, 0, 16, 16);
        const px = sctx.getImageData(0, 0, 16, 16).data;
        let msR = 0, msG = 0, msB = 0, msCnt = 0;
        let bsR = 0, bsG = 0, bsB = 0, bsCnt = 0;
        for (let y = 0; y < 16; y++) {
          for (let x = 0; x < 16; x++) {
            const i = (y * 16 + x) * 4;
            if (x <= 4 || y <= 2) {
              msR += px[i];
              msG += px[i + 1];
              msB += px[i + 2];
              msCnt++;
            }
            if (x >= 11 || y >= 13) {
              bsR += px[i];
              bsG += px[i + 1];
              bsB += px[i + 2];
              bsCnt++;
            }
          }
        }
        const acc = window.__atsAccentRgb || [0.55, 0.42, 0.9];
        const toneRimColor = (rs, gs, bs, cnt, fallback) => {
          if (cnt <= 0) return fallback;
          let r = rs / cnt / 255;
          let g = gs / cnt / 255;
          let b = bs / cnt / 255;
          const avg = (r + g + b) / 3;
          r = Math.min(1, Math.max(0, avg + (r - avg) * 1.65));
          g = Math.min(1, Math.max(0, avg + (g - avg) * 1.65));
          b = Math.min(1, Math.max(0, avg + (b - avg) * 1.65));
          const peak = Math.max(r, g, b);
          if (peak < 0.02) {
            r = acc[0];
            g = acc[1];
            b = acc[2];
          } else if (peak < 0.78) {
            const boost = 0.78 / peak;
            r = Math.min(1, r * boost);
            g = Math.min(1, g * boost);
            b = Math.min(1, b * boost);
          }
          return [
            r * 0.85 + acc[0] * 0.15,
            g * 0.85 + acc[1] * 0.15,
            b * 0.85 + acc[2] * 0.15,
            avg,
          ];
        };
        if (msCnt > 0 || bsCnt > 0) {
          const mainC = toneRimColor(msR, msG, msB, msCnt, [acc[0], acc[1], acc[2], 0.5]);
          const fillC = toneRimColor(bsR, bsG, bsB, bsCnt, mainC);
          const avg = (mainC[3] + fillC[3]) * 0.5;
          window.__atsBgRim = {
            ver: 2,
            hash: payload.bgHash,
            r: mainC[0],
            g: mainC[1],
            b: mainC[2],
            fr: fillC[0],
            fg: fillC[1],
            fb: fillC[2],
            str: 0.58 + Math.min(0.10, avg * 0.10),
            auraAlpha: 0.40,
          };
          window.__atsRefreshExpr?.();
        }
      } catch {
        // ignore
      }
    };
    bgS.src = payload.bgDataUrl;
  } else if (!payload.showCustomBg) {
    window.__atsBgRim = null;
    window.__atsBgSampleHash = '';
    window.__atsShowCustomBg = false;
    window.__atsBgHash = '';
  }

  let needExprPack = false;
  if (window.__atsShowPortrait && window.__atsAllowExpr && payload.exprPackHash) {
    const sameExprPack = window.__atsExprPack.hash === payload.exprPackHash && Object.keys(window.__atsExprPack.imgs).length > 0;
    if (payload.exprPack && !sameExprPack) {
      const nextImgs = {};
      for (const [eid, entry] of Object.entries(payload.exprPack)) {
        if (!entry?.dataUrl) continue;
        const pImg = new Image();
        pImg.onload = () => {
          const st = window.__atsBounce;
          if (st?.exprTexMap) {
            delete st.exprTexMap[eid];
          }
          if (st && (st.curEye === eid || st.curMouth === eid)) {
            st.exprFadeStart = performance.now();
          }
          window.__atsRefreshExpr?.();
        };
        pImg.src = entry.dataUrl;
        nextImgs[eid] = { img: pImg, x: Number(entry.x || 0), y: Number(entry.y || 0) };
      }
      window.__atsExprPack = { hash: payload.exprPackHash, imgs: nextImgs };
    } else if (!sameExprPack) {
      needExprPack = true;
    }
  }

  if (!window.__atsDyn) {
    window.__atsDyn = {
      now: performance.now(),
      lastTickAt: performance.now(),
      lastInputAt: performance.now(),
      lastTypingAt: 0,
      lastAfkMicroAt: performance.now(),
      afkSleepy: false,
      aiBusy: false,
      aiPhase: 'idle',
      lastErrCount: 0,
      transient: null,
      subagentMode: false,
      manualExprCooldownUntil: 0,
      typingBoost: 0,
      backspaceTimes: [],
      headTilt: 0,
      headTiltTarget: 0,
      ahogeX: 0,
      ahogeVx: 0,
      ahogeY: 0,
      ahogeVy: 0,
      ahogeDroop: 0,
      earL: 0,
      earLV: 0,
      earR: 0,
      earRV: 0,
      nextEarFlickAt: performance.now() + 4500,
      blushCur: 0,
      blushTarget: 0,
      glintBurst: 0,
      tailPhase: 0,
      breathPhase: 0,
      lastRimCss: '',
      transTimer: null,
    };
  }
  if (window.__atsDyn.lastRimCss === undefined) window.__atsDyn.lastRimCss = '';
  if (!window.__atsDyn.aiBusy && window.__atsShowPortrait && performance.now() - window.__atsDyn.lastInputAt >= 600000) {
    window.__atsDyn.afkSleepy = true;
  }

  function setTransientExpr(eye, mouth, durationMs, blush = 0, reason = 'signal') {
    const dyn = window.__atsDyn;
    if (!dyn) return;
    clearTimeout(dyn.transTimer);
    dyn.transient = {
      eye: eye || 'default',
      mouth: mouth || eye || 'default',
      blush,
      reason,
      expiresAt: durationMs > 0 ? performance.now() + durationMs : Infinity,
    };
    if (durationMs > 0 && Number.isFinite(durationMs)) {
      dyn.transTimer = setTimeout(() => {
        window.__atsRefreshExpr?.();
      }, durationMs + 30);
    }
    window.__atsRefreshExpr?.();
  }

  function getActiveExprPair() {
    const dyn = window.__atsDyn;
    if (!window.__atsAllowExpr) return { eye: 'default', mouth: 'default', blush: 0 };
    const now = performance.now();
    if (dyn?.transient) {
      if (now < dyn.transient.expiresAt) {
        return {
          eye: dyn.transient.eye || 'default',
          mouth: dyn.transient.mouth || 'default',
          blush: Number(dyn.transient.blush || 0),
        };
      }
      dyn.transient = null;
    }
    if (dyn?.afkSleepy && !dyn.aiBusy) {
      return { eye: 'sleepy', mouth: 'sleepy', blush: 0 };
    }
    const base = window.__atsBaseExpr || 'default';
    return { eye: base, mouth: base, blush: base === 'shy' ? 0.15 : 0 };
  }

  if (!window.__atsBounce) {
    window.__atsBounce = {
      hitW: 96,
      hitH: 144,
      hitAlpha: null,
      hitHash: '',
      gl: null,
      isWebGL2: false,
      shaderFailed: false,
      shaderVer: 0,
      prog: null,
      tex: null,
      texPrev: null,
      emptyTex: null,
      exprTexMap: {},
      exprPackTexHash: '',
      texReady: false,
      texHash: '',
      outfitWipeStart: 0,
      exprFadeStart: 0,
      curEye: 'default',
      curMouth: 'default',
      prevEye: 'default',
      prevMouth: 'default',
      baseW: 844,
      baseH: 1255,
      indexCount: 0,
      impulseBuf: new Float32Array(24),
      impulses: [],
      aspect: 0.67,
      lastRenderMs: 0,
      canvasShown: null,
      shadowShown: null,
      shadowSig: '',
      shadowTmp: null,
      rimCache: null,
      rimCacheAt: 0,
      rimCacheKey: '',
      loc: {},
    };
  }

  function getAmbientRim() {
    if (!window.__atsAmbientLight) return { r: 0, g: 0, b: 0, fr: 0, fg: 0, fb: 0, str: 0, auraAlpha: 0 };
    if (window.__atsShowCustomBg && window.__atsBgRim && window.__atsBgRim.hash === window.__atsBgHash) {
      return window.__atsBgRim;
    }
    const st = window.__atsBounce;
    const nowMs = performance.now();
    const dbg = typeof window.__atsDebugHour === 'number' ? String(window.__atsDebugHour) : '';
    const cacheKey = window.__atsPhase + '|' + dbg;
    if (st?.rimCache && st.rimCacheKey === cacheKey && nowMs - st.rimCacheAt < 5000) {
      return st.rimCache;
    }
    const nightDeep = { r: 0.42, g: 0.88, b: 1.00, fr: 0.76, fg: 0.52, fb: 1.00, str: 0.64, auraAlpha: 0.42 };
    const dawn =      { r: 1.00, g: 0.76, b: 0.38, fr: 1.00, fg: 0.56, fb: 0.74, str: 0.64, auraAlpha: 0.38 };
    const daySun =    { r: 1.00, g: 0.89, b: 0.44, fr: 0.44, fg: 0.88, fb: 1.00, str: 0.62, auraAlpha: 0.38 };
    const dusk =      { r: 1.00, g: 0.52, b: 0.30, fr: 0.98, fg: 0.40, fb: 0.76, str: 0.68, auraAlpha: 0.42 };
    const nightNeon = { r: 0.46, g: 0.90, b: 1.00, fr: 0.86, fg: 0.50, fb: 1.00, str: 0.65, auraAlpha: 0.44 };

    const nowD = new Date();
    const h = typeof window.__atsDebugHour === 'number' ? window.__atsDebugHour : (nowD.getHours() + nowD.getMinutes() / 60);

    const blendRim = (a, b, rawT) => {
      const x = Math.max(0, Math.min(1, rawT));
      const t = x * x * (3 - 2 * x);
      return {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
        fr: a.fr + (b.fr - a.fr) * t,
        fg: a.fg + (b.fg - a.fg) * t,
        fb: a.fb + (b.fb - a.fb) * t,
        str: a.str + (b.str - a.str) * t,
        auraAlpha: a.auraAlpha + (b.auraAlpha - a.auraAlpha) * t,
      };
    };

    let res;
    if (window.__atsPhase === 'night' && h >= 5.5 && h < 18.8) res = nightNeon;
    else if (window.__atsPhase === 'day' && (h >= 19.2 || h < 5.2)) res = daySun;
    else if (h >= 5.0 && h < 6.5) res = blendRim(nightDeep, dawn, (h - 5.0) / 1.5);
    else if (h >= 6.5 && h < 9.0) res = dawn;
    else if (h >= 9.0 && h < 10.25) res = blendRim(dawn, daySun, (h - 9.0) / 1.25);
    else if (h >= 10.25 && h < 15.75) res = daySun;
    else if (h >= 15.75 && h < 16.75) res = blendRim(daySun, dusk, (h - 15.75) / 1.0);
    else if (h >= 16.75 && h < 18.5) res = dusk;
    else if (h >= 18.5 && h < 19.5) res = blendRim(dusk, nightNeon, (h - 18.5) / 1.0);
    else if (h >= 19.5 && h < 23.0) res = nightNeon;
    else if (h >= 23.0) res = blendRim(nightNeon, nightDeep, (h - 23.0) / 1.0);
    else res = nightDeep;

    if (st) {
      st.rimCache = res;
      st.rimCacheAt = nowMs;
      st.rimCacheKey = cacheKey;
    }
    return res;
  }

  function updatePortraitShadow(img, hash, rim) {
    const st = window.__atsBounce;
    if (!st || !shadowEl || !img || !img.complete || !img.naturalWidth) return;
    const isDark = window.__atsPhase === 'night';
    const hasCustomRim = rim && rim.str > 0.002;
    const rr = hasCustomRim ? Math.round(rim.r * 255) : (isDark ? 18 : 104);
    const rg = hasCustomRim ? Math.round(rim.g * 255) : (isDark ? 10 : 78);
    const rb = hasCustomRim ? Math.round(rim.b * 255) : (isDark ? 36 : 176);
    const aa = hasCustomRim ? Number((rim.auraAlpha ?? 0.38).toFixed(2)) : (isDark ? 0.38 : 0.18);
    const dx = hasCustomRim ? (window.__atsFlipX ? 5 : -5) : 0;
    const dy = hasCustomRim ? 6 : 12;
    const sig = hash + '|' + (window.__atsFlipX ? 1 : 0) + '|' + rr + ',' + rg + ',' + rb + ',' + aa + '|' + dx + ',' + dy;
    if (st.shadowSig === sig) return;
    st.shadowSig = sig;
    try {
      const aspect = Math.max(0.2, img.naturalWidth / img.naturalHeight);
      const w = 240;
      const h = Math.round(w / aspect);
      const cw = Math.round(w * 1.16);
      const ch = Math.round(h * 1.16);
      const ox = (cw - w) * 0.5;
      const oy = (ch - h) * 0.5;
      if (!st.shadowTmp) st.shadowTmp = document.createElement('canvas');
      if (st.shadowTmp.width !== cw || st.shadowTmp.height !== ch) {
        st.shadowTmp.width = cw;
        st.shadowTmp.height = ch;
      }
      const tctx = st.shadowTmp.getContext('2d');
      tctx.clearRect(0, 0, cw, ch);
      tctx.save();
      if (window.__atsFlipX) {
        tctx.translate(cw, 0);
        tctx.scale(-1, 1);
      }
      tctx.drawImage(img, ox, oy, w, h);
      tctx.restore();
      tctx.globalCompositeOperation = 'source-in';
      tctx.fillStyle = 'rgb(' + rr + ',' + rg + ',' + rb + ')';
      tctx.fillRect(0, 0, cw, ch);
      tctx.globalCompositeOperation = 'source-over';

      if (shadowEl.width !== cw || shadowEl.height !== ch) {
        shadowEl.width = cw;
        shadowEl.height = ch;
      }
      const sctx = shadowEl.getContext('2d');
      sctx.clearRect(0, 0, cw, ch);
      sctx.save();
      sctx.globalAlpha = aa;
      sctx.filter = 'blur(6px)';
      sctx.drawImage(st.shadowTmp, dx * (w / 440), dy * (h / 660));
      sctx.restore();
    } catch {
      // ignore
    }
  }

  function getExprTex(gl, eid) {
    const st = window.__atsBounce;
    if (!st) return null;
    if (!eid || eid === 'default') return st.emptyTex;
    if (st.exprTexMap[eid]) return st.exprTexMap[eid];
    const entry = window.__atsExprPack?.imgs?.[eid];
    if (!entry?.img || !entry.img.complete || !entry.img.naturalWidth) return st.emptyTex;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, entry.img);
    st.exprTexMap[eid] = t;
    return t;
  }

  function kickAnimLoop() {
    const st = window.__atsBounce;
    const dyn = window.__atsDyn;
    if (!st || st.shaderFailed || !imgEl || document.hidden || !window.__atsShowPortrait) return;
    const pair = getActiveExprPair();
    const isMixedOrExpr = pair.eye !== 'default' || pair.mouth !== 'default' || pair.blush > 0.01;
    const now = performance.now();
    const isExprFading = st.exprFadeStart > 0 && now - st.exprFadeStart < 340;
    const isWiping = st.outfitWipeStart > 0 && now - st.outfitWipeStart < 380;
    const hasRim = !!window.__atsAmbientLight;
    const needAnim = st.gl && (
      window.__atsIdleAmp > 0 ||
      window.__atsMicroMotion ||
      st.impulses.length > 0 ||
      isExprFading ||
      isWiping ||
      Math.abs(dyn?.headTilt || 0) > 0.002
    );
    if ((needAnim || isMixedOrExpr || hasRim) && !window.__atsBounceRaf) {
      window.__atsBounceRaf = requestAnimationFrame(renderFrame);
    } else if (!needAnim && !isMixedOrExpr && !hasRim && canvasEl) {
      if (st.canvasShown !== false) {
        st.canvasShown = false;
        imgEl.style.visibility = 'visible';
        canvasEl.style.display = 'none';
      }
    }
  }

  function computeHitAlpha(img) {
    const st = window.__atsBounce;
    try {
      const hc = document.createElement('canvas');
      hc.width = st.hitW;
      hc.height = st.hitH;
      const ctx = hc.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, st.hitW, st.hitH);
      const raw = ctx.getImageData(0, 0, st.hitW, st.hitH).data;
      const alpha = new Uint8Array(st.hitW * st.hitH);
      for (let i = 0, j = 3; i < alpha.length; i++, j += 4) alpha[i] = raw[j];
      return alpha;
    } catch {
      return null;
    }
  }

  function clearExprTextures(gl) {
    const st = window.__atsBounce;
    if (!st?.exprTexMap) return;
    for (const texObj of Object.values(st.exprTexMap)) {
      try { gl.deleteTexture(texObj); } catch {}
    }
    st.exprTexMap = {};
  }

  function ensureHitMapAndTexture(img, hashOverride = '', hitAlphaOverride = null) {
    const st = window.__atsBounce;
    const hash = hashOverride || img?.dataset?.hash || '';
    if (!img || !img.complete || !img.naturalWidth || !hash) return;
    const newAspect = img.naturalWidth / img.naturalHeight;
    const prevAspect = st.aspect;
    st.aspect = newAspect;
    st.baseW = img.naturalWidth;
    st.baseH = img.naturalHeight;

    if (st.hitHash !== hash) {
      st.hitAlpha = hitAlphaOverride || computeHitAlpha(img);
      st.hitHash = hash;
    }

    if (canvasEl && !st.shaderFailed) {
      if (!st.gl || st.shaderVer !== 5) {
        let gl = st.gl;
        let isWebGL2 = st.isWebGL2;
        if (!gl) {
          gl = canvasEl.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' });
          isWebGL2 = !!gl;
          if (!gl) {
            gl = canvasEl.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' });
          }
        }
        if (gl) {
          const precHdr = [
            '#ifdef GL_FRAGMENT_PRECISION_HIGH',
            'precision highp float;',
            '#else',
            'precision mediump float;',
            '#endif',
          ].join('\n');
          const vsSrc = [
            precHdr,
            'attribute vec2 a_uv;',
            'uniform float u_aspect;',
            'uniform float u_time;',
            'uniform float u_idle;',
            'uniform float u_expr_pulse;',
            'uniform float u_is_builtin;',
            'uniform float u_ear_style;',
            'uniform float u_ear_l;',
            'uniform float u_ear_r;',
            'uniform vec3 u_ahoge;',
            'uniform vec2 u_tail;',
            'uniform float u_head_tilt;',
            'uniform int u_count;',
            'uniform vec4 u_impulses[6];',
            'varying vec2 v_uv;',
            'void main() {',
            '  v_uv = a_uv;',
            '  float u = a_uv.x;',
            '  float v = a_uv.y;',
            '  float bottomAnchor = smoothstep(0.99, 0.82, v);',
            '  vec2 disp = vec2(0.0);',
            '  float headMask = smoothstep(0.37, 0.21, v) * smoothstep(0.01, 0.09, v);',
            '  if (abs(u_expr_pulse) > 0.0005) {',
            '    disp.y += 0.0085 * u_expr_pulse * headMask;',
            '    disp.x += (u - 0.5) * -0.006 * u_expr_pulse * headMask;',
            '  }',
            '  if (abs(u_head_tilt) > 0.0005) {',
            '    float hm = smoothstep(0.36, 0.22, v) * exp(-pow((u - 0.44) / 0.34, 2.0));',
            '    vec2 relH = vec2((u - 0.44) * u_aspect, v - 0.34);',
            '    float ang = u_head_tilt * hm;',
            '    disp.x += (-relH.y * ang) / max(u_aspect, 0.2);',
            '    disp.y += relH.x * ang;',
            '  }',
            '  if (u_idle > 0.001) {',
            '    float breath = sin(u_time);',
            '    vec2 cRel = vec2((u - 0.45) / 0.19, (v - 0.43) / 0.11);',
            '    float chestMask = exp(-0.5 * dot(cRel, cRel)) * smoothstep(0.27, 0.38, v) * bottomAnchor;',
            '    disp.y += -0.0055 * u_idle * breath * chestMask;',
            '    disp += vec2((u - 0.45) * 0.8, (v - 0.43)) * (0.014 * u_idle * breath * chestMask);',
            '    disp.y += -0.0022 * u_idle * sin(u_time - 0.45) * headMask;',
            '    float outerSide = smoothstep(0.26, 0.08, u) + smoothstep(0.67, 0.88, u);',
            '    float outerMask = clamp(outerSide, 0.0, 1.0) * smoothstep(0.18, 0.42, v) * smoothstep(0.95, 0.72, v);',
            '    float sway = sin(u_time * 0.77 + v * 4.2 + u * 2.1) + 0.30 * sin(u_time * 1.45 + v * 6.5 - u * 1.7);',
            '    disp.x += 0.0062 * u_idle * sway * outerMask;',
            '    disp.y += 0.0022 * u_idle * cos(u_time * 0.77 + v * 3.8) * outerMask;',
            '  }',
            '  if (u_is_builtin > 0.5) {',
            '    float aMask = smoothstep(0.08, 0.015, v) * exp(-pow((u - 0.435) / 0.072, 2.0));',
            '    disp.x += clamp(u_ahoge.x, -0.5, 0.5) * 0.048 * aMask;',
            '    disp.y += (clamp(u_ahoge.y, -0.5, 0.5) * 0.048 + u_ahoge.z * 0.012) * aMask;',
            '    float earTip = u_ear_style > 0.5 ? smoothstep(0.145, 0.01, v) : smoothstep(0.14, 0.04, v);',
            '    float earLM = u_ear_style > 0.5 ? smoothstep(0.08, 0.24, u) * smoothstep(0.38, 0.28, u) : smoothstep(0.22, 0.29, u) * smoothstep(0.39, 0.31, u);',
            '    float earRM = u_ear_style > 0.5 ? smoothstep(0.47, 0.56, u) * smoothstep(0.66, 0.57, u) : smoothstep(0.50, 0.58, u) * smoothstep(0.68, 0.60, u);',
            '    float bunnySway = u_ear_style > 0.5 ? sin(u_time * 1.15) * 0.0065 : 0.0;',
            '    disp.x += (u_ear_l * 0.014 + bunnySway) * earLM * earTip;',
            '    disp.y += (abs(u_ear_l) * 0.012 + bunnySway * 0.4) * earLM * earTip;',
            '    disp.x += (-u_ear_r * 0.014 + bunnySway * 0.8) * earRM * earTip;',
            '    disp.y += (abs(u_ear_r) * 0.012 - bunnySway * 0.3) * earRM * earTip;',
            '    if (u_tail.y > 0.0005) {',
            '      float tailMask = smoothstep(0.75, 0.82, u) * smoothstep(0.62, 0.70, v) * smoothstep(0.96, 0.88, v);',
            '      vec2 tRel = vec2(u - 0.80, v - 0.80);',
            '      float ang = atan(tRel.y, tRel.x);',
            '      float w = sin(u_tail.x - ang * 1.35) * u_tail.y;',
            '      disp += vec2(-tRel.y, tRel.x) * (w * tailMask * 1.65);',
            '    }',
            '  }',
            '  for (int i = 0; i < 6; i++) {',
            '    if (i >= u_count) break;',
            '    vec4 imp = u_impulses[i];',
            '    float age = imp.z;',
            '    float str = imp.w;',
            '    float sigma = mix(0.052, 0.135, clamp(str, 0.0, 1.0)) + max(0.0, str - 1.0) * 0.04;',
            '    vec2 rel = vec2((u - imp.x) * u_aspect, v - imp.y);',
            '    float r2 = dot(rel, rel);',
            '    float falloff = exp(-r2 / (2.0 * sigma * sigma));',
            '    float env = exp(-age * 5.2) * str;',
            '    float oscY = (sin(age * 27.0 + 0.32) - 0.314 * exp(-age * 24.0)) * env;',
            '    float oscR = sin(age * 22.0 - 0.5) * env;',
            '    float dy = -0.046 * oscY * falloff * bottomAnchor;',
            '    vec2 radial = vec2(rel.x / max(u_aspect, 0.2), rel.y) * (0.24 * oscR * falloff * bottomAnchor);',
            '    float bias = clamp((imp.x - 0.5) * 2.0, -1.0, 1.0);',
            '    float dx = 0.013 * sin(age * 20.0 + 0.4) * env * falloff * bottomAnchor * (abs(bias) < 0.1 ? 1.0 : -sign(bias));',
            '    disp.x += dx + radial.x;',
            '    disp.y += dy + radial.y;',
            '  }',
            '  vec2 p = vec2(((u + disp.x) * 2.0 - 1.0) / 1.16, (1.0 - (v + disp.y) * 2.0) / 1.16);',
            '  gl_Position = vec4(p, 0.0, 1.0);',
            '}',
          ].join('\n');

          const fsSrc = [
            precHdr,
            'uniform sampler2D u_tex;',
            'uniform sampler2D u_tex_prev;',
            'uniform sampler2D u_expr_eye;',
            'uniform sampler2D u_expr_mouth;',
            'uniform sampler2D u_expr_prev_eye;',
            'uniform sampler2D u_expr_prev_mouth;',
            'uniform float u_outfit_wipe;',
            'uniform float u_expr_fade;',
            'uniform float u_expr_enabled;',
            'uniform float u_is_builtin;',
            'uniform float u_flip_x;',
            'uniform vec4 u_expr_rect;',
            'uniform float u_blush;',
            'uniform float u_time;',
            'uniform vec3 u_rim_color;',
            'uniform vec3 u_rim_fill;',
            'uniform float u_rim_strength;',
            'uniform vec3 u_accent;',
            'uniform vec2 u_glint;',
            'uniform vec2 u_feather;',
            'varying vec2 v_uv;',
            'void main() {',
            '  vec4 cur = texture2D(u_tex, v_uv);',
            '  vec4 base = cur;',
            '  if (u_outfit_wipe < 0.999) {',
            '    vec4 prev = texture2D(u_tex_prev, v_uv);',
            '    float diag = v_uv.x * 0.65 + v_uv.y * 0.35;',
            '    float edge = mix(-0.18, 1.18, u_outfit_wipe);',
            '    float mask = 1.0 - smoothstep(edge - 0.13, edge + 0.13, diag);',
            '    base = mix(prev, cur, mask);',
            '    float band = exp(-pow((diag - edge) / 0.055, 2.0)) * sin(u_outfit_wipe * 3.1415926);',
            '    base.rgb += u_accent * band * 0.55 * base.a;',
            '  }',
            '  if (u_expr_enabled > 0.5) {',
            '    vec2 euv = (v_uv - u_expr_rect.xy) / max(u_expr_rect.zw, vec2(0.0001));',
            '    if (euv.x >= 0.0 && euv.x <= 1.0 && euv.y >= 0.0 && euv.y <= 1.0) {',
            '      float isM = smoothstep(0.68, 0.78, euv.y);',
            '      vec4 eEye = isM < 0.999 ? texture2D(u_expr_eye, euv) : vec4(0.0);',
            '      vec4 eMouth = isM > 0.001 ? texture2D(u_expr_mouth, euv) : vec4(0.0);',
            '      vec4 eCur = mix(eEye, eMouth, isM);',
            '      vec4 eCol = eCur;',
            '      if (u_expr_fade < 0.999) {',
            '        vec4 pEye = isM < 0.999 ? texture2D(u_expr_prev_eye, euv) : vec4(0.0);',
            '        vec4 pMouth = isM > 0.001 ? texture2D(u_expr_prev_mouth, euv) : vec4(0.0);',
            '        vec4 ePrev = mix(pEye, pMouth, isM);',
            '        eCol = mix(ePrev, eCur, u_expr_fade);',
            '      }',
            '      base.rgb = eCol.rgb + base.rgb * (1.0 - eCol.a);',
            '    }',
            '  }',
            '  if (u_is_builtin > 0.5 && u_blush > 0.005) {',
            '    vec2 buv = (v_uv - u_expr_rect.xy) / max(u_expr_rect.zw, vec2(0.0001));',
            '    if (buv.x >= 0.05 && buv.x <= 0.95 && buv.y >= 0.52 && buv.y <= 0.80) {',
            '      vec2 dL = vec2((buv.x - 0.25) / 0.11, (buv.y - 0.67) / 0.058);',
            '      vec2 dR = vec2((buv.x - 0.71) / 0.11, (buv.y - 0.67) / 0.058);',
            '      float bSpot = clamp(exp(-dot(dL, dL)) + exp(-dot(dR, dR)), 0.0, 1.0);',
            '      float skinW = smoothstep(0.72, 0.92, base.r) * smoothstep(0.15, 0.35, base.r - base.b * 0.72);',
            '      float bw = bSpot * skinW * u_blush * 0.42 * base.a;',
            '      base.rgb = mix(base.rgb, vec3(0.99, 0.44, 0.52) * base.a, bw);',
            '    }',
            '  }',
            '  if (u_rim_strength > 0.002 && base.a > 0.03) {',
            '    float dir = u_flip_x > 0.5 ? 1.0 : -1.0;',
            '    float footFade = smoothstep(0.99, 0.89, v_uv.y);',
            '    float aCrisp = texture2D(u_tex, clamp(v_uv + vec2(dir * 0.0068, -0.0052), 0.0, 1.0), 1.3).a;',
            '    float aWide  = texture2D(u_tex, clamp(v_uv + vec2(dir * 0.0240, -0.0135), 0.0, 1.0), 3.9).a;',
            '    float aBack  = texture2D(u_tex, clamp(v_uv + vec2(-dir * 0.0135, -0.0055), 0.0, 1.0), 2.6).a;',
            '    float rimCrisp = clamp(base.a - aCrisp, 0.0, 1.0) * footFade;',
            '    float rimSoft  = clamp(base.a - aWide, 0.0, 1.0) * footFade;',
            '    float rimBack  = clamp(base.a - aBack, 0.0, 1.0) * footFade;',
            '    vec2 fRel = vec2((v_uv.x - 0.455) / 0.115, (v_uv.y - 0.242) / 0.085);',
            '    float faceSafe = 1.0 - 0.85 * exp(-dot(fRel, fRel));',
            '    rimSoft *= faceSafe;',
            '    float chatSide = u_flip_x > 0.5 ? v_uv.x : (1.0 - v_uv.x);',
            '    float shimmer = 0.90 + 0.10 * sin(u_time * 0.95);',
            '    float topWash = smoothstep(0.60, 0.02, v_uv.y) * smoothstep(0.12, 0.88, chatSide) * faceSafe * shimmer;',
            '    vec3 c = base.rgb / max(base.a, 0.001);',
            '    float tintW = clamp(rimSoft * 0.52 + topWash * 0.34, 0.0, 0.62) * u_rim_strength;',
            '    c = mix(c, clamp(c * (0.68 + 0.62 * u_rim_color), 0.0, 1.0), tintW);',
            '    vec3 glow = u_rim_color * (rimCrisp * 1.15 + rimSoft * 0.56 + topWash * 0.22)',
            '              + u_rim_fill  * (rimBack  * 0.55 + topWash * 0.10);',
            '    c = clamp(c + (vec3(1.0) - c * 0.68) * glow * u_rim_strength, 0.0, 1.0);',
            '    base.rgb = c * base.a;',
            '  }',
            '  if (u_is_builtin > 0.5 && u_glint.x > 0.01 && base.a > 0.1) {',
            '    vec2 starCenter = vec2(0.5805, 0.1535);',
            '    vec2 gs = (v_uv - starCenter) / vec2(0.056, 0.046);',
            '    float gr = dot(gs, gs);',
            '    if (gr < 1.8) {',
            '      float luma = dot(base.rgb / max(base.a, 0.001), vec3(0.299, 0.587, 0.114));',
            '      float bandPos = (gs.x * 0.72 + gs.y * 0.68) - u_glint.y * 1.15;',
            '      float band = exp(-bandPos * bandPos * 13.0) * exp(-gr * 1.25) * smoothstep(0.45, 0.84, luma);',
            '      vec2 fc = (v_uv - starCenter) * vec2(1.0, 1.487);',
            '      float flareEnv = exp(-u_glint.y * u_glint.y * 4.5);',
            '      float cross = (exp(-abs(fc.y) * 205.0) * exp(-abs(fc.x) * 24.0)',
            '                   + exp(-abs(fc.x) * 205.0) * exp(-abs(fc.y) * 24.0)) * flareEnv;',
            '      float sparkle = (band * 0.78 + cross * 0.96) * u_glint.x;',
            '      vec3 glintCol = mix(vec3(1.0, 0.99, 1.0), u_rim_color * 0.45 + vec3(0.65), 0.35);',
            '      base.rgb = clamp(base.rgb + glintCol * sparkle * base.a, 0.0, base.a);',
            '    }',
            '  }',
            '  float fAlpha = 1.0;',
            '  if (u_feather.x > 0.001) {',
            '    float screenX = u_flip_x > 0.5 ? (1.0 - v_uv.x) : v_uv.x;',
            '    fAlpha *= smoothstep(0.0, u_feather.x, screenX);',
            '  }',
            '  if (u_feather.y > 0.001) {',
            '    fAlpha *= smoothstep(1.0, 1.0 - u_feather.y, v_uv.y);',
            '  }',
            '  gl_FragColor = base * fAlpha;',
            '}',
          ].join('\n');

          const compile = (type, src) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
              console.warn('[agy-theme-studio] shader compile failed:', gl.getShaderInfoLog(sh));
              gl.deleteShader(sh);
              return null;
            }
            return sh;
          };
          const vs = compile(gl.VERTEX_SHADER, vsSrc);
          const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
          const prog = vs && fs ? gl.createProgram() : null;
          let linked = false;
          if (prog) {
            gl.attachShader(prog, vs);
            gl.attachShader(prog, fs);
            gl.linkProgram(prog);
            linked = !!gl.getProgramParameter(prog, gl.LINK_STATUS);
            if (!linked) {
              console.warn('[agy-theme-studio] program link failed:', gl.getProgramInfoLog(prog));
            }
          }
          if (!linked) {
            st.shaderFailed = true;
            st.gl = null;
          } else {
            gl.useProgram(prog);
            const cols = 36;
            const rows = 52;
            const verts = [];
            const idx = [];
            for (let r = 0; r <= rows; r++) {
              for (let c = 0; c <= cols; c++) {
                verts.push(c / cols, r / rows);
              }
            }
            for (let r = 0; r < rows; r++) {
              for (let c = 0; c < cols; c++) {
                const a = r * (cols + 1) + c;
                const b = a + 1;
                const d = a + cols + 1;
                const e = d + 1;
                idx.push(a, d, b, b, d, e);
              }
            }
            if (st.vb) { try { gl.deleteBuffer(st.vb); } catch {} }
            if (st.ib) { try { gl.deleteBuffer(st.ib); } catch {} }
            const vb = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, vb);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
            const locUv = gl.getAttribLocation(prog, 'a_uv');
            gl.enableVertexAttribArray(locUv);
            gl.vertexAttribPointer(locUv, 2, gl.FLOAT, false, 0, 0);

            const ib = gl.createBuffer();
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);

            if (st.prog && st.prog !== prog) {
              try { gl.deleteProgram(st.prog); } catch {}
            }
            st.gl = gl;
            st.isWebGL2 = isWebGL2;
            st.shaderVer = 5;
            st.prog = prog;
            st.vb = vb;
            st.ib = ib;
            st.indexCount = idx.length;
            const u = {};
            for (const name of [
              'u_aspect', 'u_time', 'u_idle', 'u_expr_pulse', 'u_is_builtin', 'u_ear_style',
              'u_ear_l', 'u_ear_r', 'u_ahoge', 'u_tail', 'u_head_tilt', 'u_count', 'u_impulses',
              'u_tex', 'u_tex_prev', 'u_expr_eye', 'u_expr_mouth', 'u_expr_prev_eye', 'u_expr_prev_mouth',
              'u_outfit_wipe', 'u_expr_fade', 'u_expr_enabled', 'u_flip_x', 'u_expr_rect', 'u_blush',
              'u_rim_color', 'u_rim_fill', 'u_rim_strength', 'u_accent', 'u_glint', 'u_feather',
            ]) {
              u[name] = gl.getUniformLocation(prog, name);
            }
            st.loc = u;

            if (!st.tex) st.tex = gl.createTexture();
            if (!st.texPrev) st.texPrev = gl.createTexture();
            if (!st.emptyTex) st.emptyTex = gl.createTexture();
            const initBlank = (texObj) => {
              gl.bindTexture(gl.TEXTURE_2D, texObj);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
            };
            initBlank(st.texPrev);
            initBlank(st.emptyTex);
            st.texReady = false;
            st.texHash = '';
          }
        }
      }

      if (st.gl && !st.shaderFailed) {
        const gl = st.gl;
        if (st.exprPackTexHash !== (window.__atsExprPack?.hash || '')) {
          clearExprTextures(gl);
          st.exprPackTexHash = window.__atsExprPack?.hash || '';
        }
        const rawH = Math.round(img.naturalHeight * 1.16);
        const dispH = canvasEl.parentElement?.clientHeight || 660;
        const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const scaleMul = Math.max(1, Number(window.__atsPortraitScale || 1));
        const maxPhysH = Math.round(dispH * 1.16 * dpr * scaleMul);
        const targetH = Math.max(256, Math.min(rawH, maxPhysH));
        const targetW = Math.max(128, Math.round(targetH * (img.naturalWidth / img.naturalHeight)));
        if (canvasEl.width !== targetW || canvasEl.height !== targetH || st.texHash !== hash) {
          canvasEl.width = targetW;
          canvasEl.height = targetH;
          gl.viewport(0, 0, canvasEl.width, canvasEl.height);
        }

        if (st.texHash !== hash) {
          const uploadBodyTex = (texObj) => {
            gl.bindTexture(gl.TEXTURE_2D, texObj);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            if (st.isWebGL2) {
              gl.generateMipmap(gl.TEXTURE_2D);
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            } else {
              gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            }
          };
          const canWipe = st.texReady && prevAspect > 0 && Math.abs(prevAspect - newAspect) < 0.04;
          if (canWipe) {
            const oldTex = st.tex;
            st.tex = st.texPrev;
            st.texPrev = oldTex;
            uploadBodyTex(st.tex);
            st.outfitWipeStart = performance.now();
          } else {
            uploadBodyTex(st.tex);
            st.outfitWipeStart = 0;
            st.texReady = true;
          }
          st.texHash = hash;
        }
      }
    }
    updatePortraitShadow(img, hash, getAmbientRim());
    kickAnimLoop();
  }

  function stepDynamics(now) {
    const dyn = window.__atsDyn;
    if (!dyn) return;
    const dt = Math.min(0.08, Math.max(0.001, (now - dyn.lastTickAt) / 1000));
    dyn.lastTickAt = now;

    // 挂机自主小剧场（3 分钟小动作，10 分钟进入轻打盹）
    const idleDur = now - dyn.lastInputAt;
    if (!dyn.aiBusy && idleDur >= 600000 && !dyn.afkSleepy) {
      dyn.afkSleepy = true;
    } else if (!dyn.aiBusy && !dyn.afkSleepy && idleDur >= 180000 && now - dyn.lastAfkMicroAt > 24000) {
      dyn.lastAfkMicroAt = now;
      dyn.earRV += (Math.random() > 0.5 ? 1 : -1) * 3.8;
      dyn.ahogeVy -= 2.2;
      dyn.headTiltTarget = (Math.random() - 0.5) * 0.04;
    }

    // 连续呼吸相位累积（确保入睡慢呼吸与惊醒切回零跳变）
    dyn.breathPhase = (dyn.breathPhase + dt * (dyn.afkSleepy ? 1.08 : 1.75)) % 6283.1853;

    // 打字热度与歪头衰减
    if (now - dyn.lastTypingAt > 900) {
      dyn.typingBoost = Math.max(0, dyn.typingBoost - dt * 1.4);
    }

    const toChatX = window.__atsFlipX ? 1.0 : -1.0;
    let baseTilt = 0;
    if (dyn.aiPhase === 'waiting') baseTilt = toChatX * 0.042;
    else if (dyn.typingBoost > 0.05) baseTilt = toChatX * (0.022 + 0.015 * dyn.typingBoost);
    const tiltTarget = baseTilt + dyn.headTiltTarget * 0.6;
    dyn.headTilt += (tiltTarget - dyn.headTilt) * Math.min(1, dt * 5.0);
    dyn.headTiltTarget *= Math.exp(-dt * 1.6);

    // 呆毛二阶弹簧（发送/开心弹性跃动，困/报错轻低垂）
    const droopGoal = dyn.afkSleepy || dyn.aiPhase === 'waiting' ? 0.55 : dyn.transient?.eye === 'teary' || dyn.transient?.eye === 'dizzy' ? 0.72 : 0.0;
    dyn.ahogeDroop += (droopGoal - dyn.ahogeDroop) * Math.min(1, dt * 4.0);
    const axEq = dyn.typingBoost > 0.1 ? Math.sin(now * 0.018) * 0.16 * dyn.typingBoost : 0;
    dyn.ahogeVx = Math.max(-7, Math.min(7, dyn.ahogeVx + ((axEq - dyn.ahogeX) * 140 - dyn.ahogeVx * 11) * dt));
    dyn.ahogeX += dyn.ahogeVx * dt;
    dyn.ahogeVy = Math.max(-7, Math.min(7, dyn.ahogeVy + ((0 - dyn.ahogeY) * 160 - dyn.ahogeVy * 11) * dt));
    dyn.ahogeY += dyn.ahogeVy * dt;

    // 猫耳/兔耳随机单侧轻颤弹簧
    if (window.__atsMicroMotion && now >= dyn.nextEarFlickAt && !dyn.afkSleepy) {
      dyn.nextEarFlickAt = now + 3800 + Math.random() * 5500;
      if (Math.random() > 0.45) dyn.earLV += 4.5 + Math.random() * 2.5;
      else dyn.earRV += 4.5 + Math.random() * 2.5;
    }
    dyn.earLV += (-dyn.earL * 180 - dyn.earLV * 14) * dt;
    dyn.earL += dyn.earLV * dt;
    dyn.earRV += (-dyn.earR * 180 - dyn.earRV * 14) * dt;
    dyn.earR += dyn.earRV * dt;

    // 猫尾外弧情绪节奏
    let tailSpeed = 2.0;
    let tailAmp = window.__atsMicroMotion ? 0.015 : 0;
    if (dyn.afkSleepy) {
      tailSpeed = 0.7;
      tailAmp = 0.004;
    } else if (dyn.aiPhase === 'subagents') {
      tailSpeed = 3.2;
      tailAmp = 0.022;
    } else if (dyn.aiPhase === 'thinking' || dyn.aiPhase === 'tool') {
      tailSpeed = 3.6;
      tailAmp = 0.020;
    } else if (dyn.transient?.eye === 'pout') {
      tailSpeed = 6.2;
      tailAmp = 0.024;
    }
    dyn.tailPhase += dt * tailSpeed;

    // 程序化渐进颊红与星饰流光
    const pair = getActiveExprPair();
    dyn.blushTarget = Math.max(pair.blush || 0, dyn.transient?.blush || 0);
    dyn.blushCur += (dyn.blushTarget - dyn.blushCur) * Math.min(1, dt * 4.5);
    dyn.glintBurst *= Math.exp(-dt * 2.8);

    return { dt, pair, tailAmp };
  }

  function renderFrame() {
    const st = window.__atsBounce;
    const dyn = window.__atsDyn;
    if (!st || st.shaderFailed || !imgEl) {
      window.__atsBounceRaf = 0;
      return;
    }
    const now = performance.now();
    if (document.hidden || !window.__atsShowPortrait) {
      if (st.canvasShown !== false) {
        st.canvasShown = false;
        imgEl.style.visibility = 'visible';
        if (canvasEl) canvasEl.style.display = 'none';
      }
      if (shadowEl && st.shadowShown !== false) {
        st.shadowShown = false;
        shadowEl.style.display = 'none';
      }
      window.__atsBounceRaf = 0;
      return;
    }
    if (shadowEl && st.shadowShown !== true) {
      st.shadowShown = true;
      shadowEl.style.display = 'block';
    }

    // 常态动效节流至 ~60fps，交互/转场突发期跑满原生刷新率
    const prelimHighRate =
      st.impulses.length > 0 ||
      st.outfitWipeStart > 0 ||
      st.exprFadeStart > 0 ||
      dyn.glintBurst > 0.05;
    if (!prelimHighRate && now - st.lastRenderMs < 15.5) {
      window.__atsBounceRaf = requestAnimationFrame(renderFrame);
      return;
    }
    st.lastRenderMs = now;

    const step = stepDynamics(now);
    const pair = step.pair;

    st.impulses = st.impulses.filter((item) => now - item.t0 < 950);
    const hasImpulses = st.impulses.length > 0;
    const idleAmp = window.__atsIdleAmp || 0;
    const wipeAgeMs = st.outfitWipeStart > 0 ? Math.max(0, now - st.outfitWipeStart) : 9999;
    const isWiping = st.outfitWipeStart > 0 && wipeAgeMs < 380;
    if (!isWiping) st.outfitWipeStart = 0;
    const wipeRaw = isWiping ? Math.min(1, wipeAgeMs / 340) : 1;
    const wipeT = 1 - Math.pow(1 - wipeRaw, 3);

    // 检查双层表情是否发生变化（与持久态/瞬态分离，绝不被 3 秒 syncAll 覆写）
    const wantKey = pair.eye + '+' + pair.mouth;
    if (window.__atsAllowExpr && wantKey !== st.exprKey && st.texReady) {
      st.prevEye = st.curEye || 'default';
      st.prevMouth = st.curMouth || 'default';
      st.curEye = pair.eye;
      st.curMouth = pair.mouth;
      st.exprKey = wantKey;
      st.exprFadeStart = now;
    } else if (!st.exprKey) {
      st.curEye = pair.eye;
      st.curMouth = pair.mouth;
      st.prevEye = pair.eye;
      st.prevMouth = pair.mouth;
      st.exprKey = wantKey;
    }

    const exprAgeMs = st.exprFadeStart > 0 ? Math.max(0, now - st.exprFadeStart) : 9999;
    const isExprFading = st.exprFadeStart > 0 && exprAgeMs < 340;
    if (!isExprFading) st.exprFadeStart = 0;
    const exprFadeRaw = isExprFading ? Math.min(1, exprAgeMs / 260) : 1;
    const exprFadeT = 1 - Math.pow(1 - exprFadeRaw, 3);
    const exprPulse = isExprFading
      ? Math.sin((exprAgeMs / 1000) * 18.0) * Math.exp(-(exprAgeMs / 1000) * 9.5)
      : 0;

    const isBuiltin = !!window.__atsOutfitKey;
    const hasRim = !!window.__atsAmbientLight;
    const hasDynamicMicro = window.__atsMicroMotion && (idleAmp > 0 || step.tailAmp > 0);
    const hasSpring =
      Math.abs(dyn.ahogeX) > 0.0005 ||
      Math.abs(dyn.ahogeY) > 0.0005 ||
      Math.abs(dyn.earL) > 0.01 ||
      Math.abs(dyn.earR) > 0.01 ||
      Math.abs(dyn.blushCur - dyn.blushTarget) > 0.01;
    const hasAnyExpr = pair.eye !== 'default' || pair.mouth !== 'default' || dyn.blushCur > 0.01;
    const activeAnim = hasImpulses || isWiping || isExprFading || hasDynamicMicro || hasSpring || idleAmp > 0 || Math.abs(dyn.headTilt) > 0.002 || dyn.glintBurst > 0.02;

    if (!activeAnim && !hasAnyExpr && !hasRim) {
      if (st.canvasShown !== false) {
        st.canvasShown = false;
        imgEl.style.visibility = 'visible';
        if (canvasEl) canvasEl.style.display = 'none';
      }
      window.__atsBounceRaf = 0;
      return;
    }

    if (st.gl && canvasEl && st.texHash === (imgEl.dataset.hash || '')) {
      const gl = st.gl;
      const u = st.loc;
      const flat = st.impulseBuf;
      const count = Math.min(6, st.impulses.length);
      for (let i = 0; i < count; i++) {
        const it = st.impulses[i];
        flat[i * 4] = it.ux;
        flat[i * 4 + 1] = it.uy;
        flat[i * 4 + 2] = Math.max(0, (now - it.t0) / 1000);
        flat[i * 4 + 3] = it.str;
      }

      gl.useProgram(st.prog);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, st.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, st.texPrev || st.tex);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, getExprTex(gl, st.curEye));
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, getExprTex(gl, st.curMouth));
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, getExprTex(gl, st.prevEye));
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, getExprTex(gl, st.prevMouth));

      gl.uniform1i(u.u_tex, 0);
      gl.uniform1i(u.u_tex_prev, 1);
      gl.uniform1i(u.u_expr_eye, 2);
      gl.uniform1i(u.u_expr_mouth, 3);
      gl.uniform1i(u.u_expr_prev_eye, 4);
      gl.uniform1i(u.u_expr_prev_mouth, 5);

      gl.uniform1f(u.u_aspect, st.aspect);
      gl.uniform1f(u.u_time, dyn.breathPhase);
      gl.uniform1f(u.u_idle, idleAmp);
      gl.uniform1f(u.u_expr_pulse, exprPulse);
      gl.uniform1f(u.u_is_builtin, isBuiltin ? 1.0 : 0.0);
      gl.uniform1f(u.u_ear_style, window.__atsOutfitKey === 'bunny' ? 1.0 : 0.0);
      gl.uniform1f(u.u_ear_l, window.__atsMicroMotion ? dyn.earL : 0);
      gl.uniform1f(u.u_ear_r, window.__atsMicroMotion ? dyn.earR : 0);
      gl.uniform3f(u.u_ahoge, window.__atsMicroMotion ? dyn.ahogeX : 0, window.__atsMicroMotion ? dyn.ahogeY : 0, dyn.ahogeDroop);
      gl.uniform2f(u.u_tail, dyn.tailPhase, step.tailAmp);
      gl.uniform1f(u.u_head_tilt, window.__atsMicroMotion ? dyn.headTilt : 0);
      gl.uniform1i(u.u_count, count);
      gl.uniform4fv(u.u_impulses, flat);

      gl.uniform1f(u.u_outfit_wipe, wipeT);
      gl.uniform1f(u.u_expr_fade, exprFadeT);
      const exprActive = window.__atsAllowExpr && isBuiltin && (st.curEye !== 'default' || st.curMouth !== 'default' || isExprFading);
      gl.uniform1f(u.u_expr_enabled, exprActive ? 1.0 : 0.0);
      gl.uniform1f(u.u_flip_x, window.__atsFlipX ? 1.0 : 0.0);

      const anchor = window.__atsExprAnchor || { dx: 0, dy: 0, scale: 1 };
      const refEntry = window.__atsExprPack?.imgs?.wink || Object.values(window.__atsExprPack?.imgs || {})[0];
      const rx = (Number(refEntry?.x ?? 265) + Number(anchor.dx || 0)) / Math.max(st.baseW, 1);
      const ry = (Number(refEntry?.y ?? 195) + Number(anchor.dy || 0)) / Math.max(st.baseH, 1);
      const rw = (210 * (Number(anchor.scale) > 0 ? Number(anchor.scale) : 1)) / Math.max(st.baseW, 1);
      const rh = (160 * (Number(anchor.scale) > 0 ? Number(anchor.scale) : 1)) / Math.max(st.baseH, 1);
      gl.uniform4f(u.u_expr_rect, rx, ry, rw, rh);

      gl.uniform1f(u.u_blush, dyn.blushCur);
      const rim = getAmbientRim();
      gl.uniform3f(u.u_rim_color, rim.r, rim.g, rim.b);
      gl.uniform3f(u.u_rim_fill, rim.fr ?? rim.r, rim.fg ?? rim.g, rim.fb ?? rim.b);
      gl.uniform1f(u.u_rim_strength, rim.str);
      updatePortraitShadow(imgEl, st.texHash, rim);

      const acc = window.__atsAccentRgb || [0.49, 0.36, 0.90];
      gl.uniform3f(u.u_accent, acc[0], acc[1], acc[2]);

      const sec = now / 1000;
      const period = dyn.aiBusy ? 2.4 : 4.2;
      const sweepDur = 1.15;
      const cyclePos = sec % period;
      const isSweeping = cyclePos < sweepDur;
      const periodicSweep = isSweeping ? (cyclePos / sweepDur) * 2.0 - 1.0 : -2.0;
      const periodicAmp = isSweeping ? Math.sin((cyclePos / sweepDur) * Math.PI) * 1.1 : 0;
      const burstAmp = dyn.glintBurst > 0.02 ? Math.min(1.25, dyn.glintBurst * 1.25) : 0;
      const glintAmp = window.__atsAmbientLight ? Math.min(1.25, Math.max(periodicAmp, burstAmp)) : 0;
      const glintSweep = burstAmp > periodicAmp ? (1.0 - Math.min(1.0, dyn.glintBurst)) * 0.55 : periodicSweep;
      gl.uniform2f(u.u_glint, glintAmp, glintSweep);

      const ft = window.__atsFeather || { left: 0.14, bottom: 0.12 };
      gl.uniform2f(u.u_feather, ft.left, ft.bottom);

      gl.drawElements(gl.TRIANGLES, st.indexCount, gl.UNSIGNED_SHORT, 0);
      if (st.canvasShown !== true) {
        st.canvasShown = true;
        canvasEl.style.display = 'block';
        imgEl.style.visibility = 'hidden';
      }

      if (activeAnim) {
        window.__atsBounceRaf = requestAnimationFrame(renderFrame);
      } else {
        window.__atsBounceRaf = 0;
      }
    } else {
      if (st.canvasShown !== false) {
        st.canvasShown = false;
        imgEl.style.visibility = 'visible';
        if (canvasEl) canvasEl.style.display = 'none';
      }
      window.__atsBounceRaf = 0;
    }
  }

  function wakeFromAfk() {
    const dyn = window.__atsDyn;
    if (!dyn) return;
    dyn.lastInputAt = performance.now();
    if (!dyn.afkSleepy) return;
    dyn.afkSleepy = false;
    dyn.ahogeVy -= 5.2;
    dyn.earLV += 5.5;
    dyn.earRV += 4.5;
    setTransientExpr('wink', 'shy', 2400, 0.65, 'afk_wake');
    const st = window.__atsBounce;
    if (st?.gl) {
      if (st.impulses.length >= 6) st.impulses.shift();
      st.impulses.push({ ux: 0.45, uy: 0.25, t0: performance.now(), str: 0.28 });
    }
    kickAnimLoop();
  }

  window.__atsOnSignal = (ev) => {
    if (!window.__atsAiCompanion || !window.__atsDyn || !ev) return;
    const dyn = window.__atsDyn;
    const now = performance.now();
    const inManualLock = dyn.manualExprCooldownUntil && now < dyn.manualExprCooldownUntil;
    if (ev.type === 'ai_state') {
      const wasSubagent = !!dyn.subagentMode;
      dyn.aiBusy = !!ev.busy;
      dyn.aiPhase = ev.phase || 'idle';
      dyn.subagentMode = ev.phase === 'subagents';
      if (dyn.aiBusy && dyn.afkSleepy) dyn.afkSleepy = false;
      if (dyn.subagentMode && !wasSubagent && !inManualLock) {
        setTransientExpr('smug', 'smug', 3200, 0, 'subagents');
      }
      window.__atsRefreshExpr?.();
      kickAnimLoop();
    } else if (ev.type === 'user_sent') {
      wakeFromAfk();
      dyn.ahogeVy -= 3.8;
      dyn.earLV += 3.5;
      kickAnimLoop();
    } else if (ev.type === 'waiting_nudge') {
      dyn.ahogeVx += (window.__atsFlipX ? 1 : -1) * 2.5;
      dyn.earRV += 3.8;
      if (!inManualLock) setTransientExpr('wink', 'default', 3500, 0.15, 'waiting_nudge');
      else kickAnimLoop();
    } else if (ev.type === 'compact') {
      dyn.ahogeVy += 2.2;
      setTransientExpr('dizzy', 'dizzy', 3000, 0.1, 'compact');
    } else if (ev.type === 'step_error') {
      const expr = (ev.streak || 1) >= 2 ? 'dizzy' : 'teary';
      setTransientExpr(expr, expr, 2800, 0.05, 'step_error');
    } else if (ev.type === 'error_fixed') {
      dyn.ahogeVy -= 4.8;
      dyn.glintBurst = 1.0;
      setTransientExpr('starry', 'heart', 2800, 0.38, 'error_fixed');
      const st = window.__atsBounce;
      if (st?.gl) {
        if (st.impulses.length >= 6) st.impulses.shift();
        st.impulses.push({ ux: 0.45, uy: 0.34, t0: performance.now(), str: 0.32 });
      }
    } else if (ev.type === 'turn_done') {
      if ((ev.durationMs || 0) >= 8000 || (ev.toolCount || 0) >= 2 || ev.hadErrors) {
        dyn.ahogeVy -= 4.5;
        dyn.glintBurst = 0.9;
        setTransientExpr('starry', 'smug', 3000, 0.32, 'turn_done');
        const st = window.__atsBounce;
        if (st?.gl) {
          if (st.impulses.length >= 6) st.impulses.shift();
          st.impulses.push({ ux: 0.45, uy: 0.36, t0: performance.now(), str: 0.26 });
        }
      } else {
        dyn.ahogeVy -= 2.8;
        kickAnimLoop();
      }
    }
  };

  if (!window.__atsVisHandler) {
    window.__atsVisHandler = () => {
      if (!document.hidden) {
        wakeFromAfk();
        kickAnimLoop();
      }
    };
    document.addEventListener('visibilitychange', window.__atsVisHandler);
  }

  if (!window.__atsFocusHandler) {
    window.__atsFocusHandler = () => {
      wakeFromAfk();
      kickAnimLoop();
    };
    window.addEventListener('focus', window.__atsFocusHandler);
  }

  if (!window.__atsKeyHandler) {
    window.__atsKeyHandler = (e) => {
      wakeFromAfk();
      const dyn = window.__atsDyn;
      if (!dyn || !window.__atsAiCompanion) return;
      const now = performance.now();
      const target = e.target;
      const inEditable = !!(target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable || target.closest?.('[contenteditable="true"]')));
      if (!inEditable) return;

      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        dyn.ahogeVy -= 3.8;
        dyn.earLV += 3.2;
        kickAnimLoop();
        return;
      }
      if (e.key === 'Backspace') {
        dyn.backspaceTimes.push(now);
        while (dyn.backspaceTimes.length && now - dyn.backspaceTimes[0] > 1500) {
          dyn.backspaceTimes.shift();
        }
        if (dyn.backspaceTimes.length >= 6 && dyn.transient?.reason !== 'backspace') {
          dyn.backspaceTimes = [];
          setTransientExpr('pout', 'teary', 2200, 0.25, 'backspace');
        }
        return;
      }
      if (e.key && e.key.length === 1) {
        dyn.lastTypingAt = now;
        dyn.typingBoost = Math.min(1, dyn.typingBoost + 0.18);
        if (dyn.typingBoost > 0.55) {
          dyn.ahogeVx += (Math.random() - 0.5) * 1.4;
          if (Math.random() < 0.14) dyn.earLV += 2.2;
        }
        kickAnimLoop();
      }
    };
    document.addEventListener('keydown', window.__atsKeyHandler, { capture: true, passive: true });
  }

  if (window.__atsSelHandler) {
    document.removeEventListener('selectionchange', window.__atsSelHandler);
    window.__atsSelHandler = null;
  }

  if (window.__atsWheelHandler && window.__atsWheelVer !== 2) {
    document.removeEventListener('wheel', window.__atsWheelHandler, true);
    window.__atsWheelHandler = null;
  }
  if (!window.__atsWheelHandler) {
    window.__atsWheelVer = 2;
    window.__atsWheelHandler = () => {
      const dyn = window.__atsDyn;
      if (!dyn || !window.__atsShowPortrait) return;
      if (dyn.afkSleepy) wakeFromAfk();
      else dyn.lastInputAt = performance.now();
    };
    document.addEventListener('wheel', window.__atsWheelHandler, { capture: true, passive: true });
  }

  if (window.__atsMoveHandler && window.__atsMoveVer !== 2) {
    document.removeEventListener('pointermove', window.__atsMoveHandler, true);
    window.__atsMoveHandler = null;
  }
  if (!window.__atsMoveHandler) {
    let lastMoveCheck = 0;
    window.__atsMoveVer = 2;
    window.__atsMoveHandler = () => {
      const now = performance.now();
      if (now - lastMoveCheck < 150) return;
      lastMoveCheck = now;
      const dyn = window.__atsDyn;
      if (!dyn || !window.__atsShowPortrait) return;
      if (dyn.afkSleepy) wakeFromAfk();
      else dyn.lastInputAt = now;
    };
    document.addEventListener('pointermove', window.__atsMoveHandler, { capture: true, passive: true });
  }

  function isOpaqueAt(ux, uy, radius = 1, threshold = 20) {
    const st = window.__atsBounce;
    if (!st?.hitAlpha) return true;
    const cx = Math.min(st.hitW - 1, Math.max(0, Math.floor(ux * st.hitW)));
    const cy = Math.min(st.hitH - 1, Math.max(0, Math.floor(uy * st.hitH)));
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && nx < st.hitW && ny >= 0 && ny < st.hitH) {
          if (st.hitAlpha[ny * st.hitW + nx] > threshold) return true;
        }
      }
    }
    return false;
  }

  window.__atsRefreshExpr = () => {
    const desired = window.__atsDesiredHash || imgEl?.dataset?.hash || '';
    const cached = desired ? window.__atsPortraitCache?.map?.[desired] : null;
    if (cached?.img?.complete && cached.img.naturalWidth) {
      ensureHitMapAndTexture(cached.img, desired, cached.hitAlpha);
    } else if (imgEl && imgEl.complete && imgEl.naturalWidth) {
      ensureHitMapAndTexture(imgEl);
    }
    kickAnimLoop();
  };

  if (window.__atsPointerHandler && window.__atsPointerVer !== 2) {
    document.removeEventListener('pointerdown', window.__atsPointerHandler, true);
    window.__atsPointerHandler = null;
  }
  if (!window.__atsPointerHandler) {
    window.__atsPointerVer = 2;
    window.__atsPointerHandler = (e) => {
      wakeFromAfk();
      const canBounce = !!window.__atsClickBounce;
      const canPokeExpr = !!(window.__atsAllowExpr && window.__atsClickExpr);
      if ((!canBounce && !canPokeExpr) || !window.__atsShowPortrait) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const target = e.target;
      if (target && target.closest && target.closest('button, a, input, textarea, select, [role="button"], [contenteditable="true"], #hagemi-pet-root')) {
        return;
      }
      const pWrap = document.getElementById('agy-theme-studio-portrait-wrap');
      const pImg = document.getElementById('agy-theme-studio-portrait');
      if (!pWrap || !pImg || pImg.style.display === 'none') return;
      if (parseFloat(getComputedStyle(pWrap).opacity || '1') < 0.04) return;
      const rect = pImg.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 20) return;
      if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) return;
      const rawUx = (e.clientX - rect.left) / rect.width;
      const ux = window.__atsFlipX ? 1.0 - rawUx : rawUx;
      const uy = (e.clientY - rect.top) / rect.height;

      const st = window.__atsBounce;
      const dyn = window.__atsDyn;
      if (!st) return;
      if (!st.hitAlpha) window.__atsRefreshExpr?.();

      const isHeadHit = uy >= 0 && uy <= 0.345 && ux >= 0.18 && ux <= 0.76;
      if (!isOpaqueAt(ux, uy, isHeadHit ? 2 : 1, isHeadHit ? 10 : 20)) return;

      if (dyn) {
        if (uy < 0.09 && ux >= 0.36 && ux <= 0.51) dyn.ahogeVx += (Math.random() > 0.5 ? 1 : -1) * 4.2;
        if (uy < 0.16 && ux < 0.42) dyn.earLV += 5.5;
        if (uy < 0.16 && ux >= 0.48) dyn.earRV += 5.5;
        if (ux >= 0.52 && ux <= 0.64 && uy >= 0.10 && uy <= 0.24) dyn.glintBurst = 1.0;
      }

      if (canPokeExpr && isHeadHit && window.__atsExprPack?.imgs) {
        if (dyn) {
          clearTimeout(dyn.transTimer);
          dyn.transient = null;
          dyn.manualExprCooldownUntil = performance.now() + 8000;
        }
        const curExpr = window.__atsBaseExpr || 'default';
        const pool = ['default', ...Object.keys(window.__atsExprPack.imgs)];
        const candidates = pool.filter((id) => {
          if (id === curExpr) return false;
          if (id === 'default') return true;
          const entry = window.__atsExprPack.imgs[id];
          return !!(entry?.img && (!entry.img.complete || entry.img.naturalWidth > 0));
        });
        if (candidates.length > 0) {
          const picked = candidates[Math.floor(Math.random() * candidates.length)];
          window.__atsBaseExpr = picked;
          window.__atsLocalExprLock = { expr: picked, prevExpr: curExpr, at: performance.now(), retried: false };
          window.__atsRefreshExpr?.();
          if (typeof window.__atsBridge === 'function') {
            window.__atsBridge(JSON.stringify({ portrait: { expression: picked } }));
          }
        }
      }

      if (!canBounce) return;
      const range = Math.min(1.5, Math.max(0.1, Number(window.__atsBounceRange ?? 0.45)));
      if (st.gl) {
        if (st.impulses.length >= 6) st.impulses.shift();
        st.impulses.push({ ux, uy, t0: performance.now(), str: range });
        if (!window.__atsBounceRaf) {
          window.__atsBounceRaf = requestAnimationFrame(renderFrame);
        }
      } else if (pImg.animate) {
        const py = 10 * range;
        const sx = 0.045 * range;
        const sy = 0.04 * range;
        pImg.style.transformOrigin = (ux * 100).toFixed(1) + '% ' + (uy * 100).toFixed(1) + '%';
        pImg.animate(
          [
            { transform: 'translate3d(0, 0, 0) scale(1, 1)' },
            { transform: 'translate3d(0, ' + (-py).toFixed(1) + 'px, 0) scale(' + (1 + sx).toFixed(3) + ', ' + (1 - sy).toFixed(3) + ')' },
            { transform: 'translate3d(0, ' + (py * 0.4).toFixed(1) + 'px, 0) scale(' + (1 - sx * 0.45).toFixed(3) + ', ' + (1 + sy * 0.6).toFixed(3) + ')' },
            { transform: 'translate3d(0, 0, 0) scale(1, 1)' },
          ],
          { duration: 480, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
        );
      }
    };
    document.addEventListener('pointerdown', window.__atsPointerHandler, { capture: true, passive: true });
  }

  function cachePortraitEntry(hash, src, img, hitAlpha) {
    const cache = window.__atsPortraitCache;
    if (!cache || !hash) return null;
    if (!cache.map[hash]) {
      cache.order.push(hash);
      while (cache.order.length > 20) {
        const drop = cache.order.shift();
        if (drop && drop !== hash) delete cache.map[drop];
      }
    }
    const entry = { src, img, hitAlpha };
    cache.map[hash] = entry;
    return entry;
  }

  function applyPortraitEntry(hash, entry) {
    if (!imgEl || !entry?.img) return;
    if (imgEl.dataset.hash !== hash || imgEl.getAttribute('src') !== entry.src) {
      imgEl.dataset.hash = hash;
      imgEl.src = entry.src;
    }
    ensureHitMapAndTexture(entry.img, hash, entry.hitAlpha);
  }

  let needImage = false;
  if (imgEl) {
    if (!payload.showPortrait) {
      window.__atsDesiredHash = '';
      imgEl.style.display = 'none';
      imgEl.style.visibility = 'visible';
      if (canvasEl) canvasEl.style.display = 'none';
      if (shadowEl) shadowEl.style.display = 'none';
      if (window.__atsBounce) {
        window.__atsBounce.canvasShown = false;
        window.__atsBounce.shadowShown = false;
      }
    } else {
      const targetHash = payload.imageHash || '';
      window.__atsDesiredHash = targetHash;
      imgEl.style.display = 'block';
      if (shadowEl && window.__atsBounce?.shadowShown !== true) {
        shadowEl.style.display = 'block';
        if (window.__atsBounce) window.__atsBounce.shadowShown = true;
      }
      const cachedEntry = targetHash ? window.__atsPortraitCache.map[targetHash] : null;
      if (cachedEntry?.img?.complete && cachedEntry.img.naturalWidth) {
        applyPortraitEntry(targetHash, cachedEntry);
      } else if (imgEl.dataset.hash === targetHash && imgEl.getAttribute('src') && imgEl.complete && imgEl.naturalWidth) {
        const hitAlpha = computeHitAlpha(imgEl);
        const entry = cachePortraitEntry(targetHash, imgEl.getAttribute('src'), imgEl, hitAlpha);
        if (entry) applyPortraitEntry(targetHash, entry);
      } else if (payload.imageDataUrl && targetHash) {
        if (!window.__atsPendingLoads) window.__atsPendingLoads = {};
        if (!window.__atsPendingLoads[targetHash]) {
          window.__atsPendingLoads[targetHash] = true;
          const dataUrl = payload.imageDataUrl;
          const loader = new Image();
          const finalize = () => {
            delete window.__atsPendingLoads[targetHash];
            if (!loader.naturalWidth) return;
            const hitAlpha = computeHitAlpha(loader);
            const entry = cachePortraitEntry(targetHash, dataUrl, loader, hitAlpha);
            if (entry && window.__atsDesiredHash === targetHash && window.__atsShowPortrait) {
              applyPortraitEntry(targetHash, entry);
            }
          };
          loader.src = dataUrl;
          if (typeof loader.decode === 'function') {
            loader.decode().then(finalize, () => {
              if (loader.complete && loader.naturalWidth) finalize();
              else delete window.__atsPendingLoads[targetHash];
            });
          } else {
            loader.onload = finalize;
            loader.onerror = () => { delete window.__atsPendingLoads[targetHash]; };
            if (loader.complete && loader.naturalWidth) finalize();
          }
        }
      } else if (targetHash) {
        needImage = true;
      }
      kickAnimLoop();
    }
  }

  // 3. 版本自适应语义探测（类名变动时按结构/几何自动兜底标记与补充 CSS 变量映射）
  function adaptEnvironment() {
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;

    // 3a. 输入栏语义标记（仅在原生 .agy-composer-footer 未命中时启用几何查找）
    let composerMatched = !!document.querySelector('form:has(.agy-composer-footer), div:has(> .agy-composer-footer)');
    if (!composerMatched) {
      const inputs = document.querySelectorAll('textarea, [contenteditable="true"]');
      for (const inp of inputs) {
        const r = inp.getBoundingClientRect();
        if (r.width < 220 || r.height < 16 || r.bottom < vh * 0.45) continue;
        let cur = inp.parentElement;
        for (let d = 0; d < 6 && cur && cur !== document.body; d++, cur = cur.parentElement) {
          const cr = cur.getBoundingClientRect();
          const cs = getComputedStyle(cur);
          if (cr.height >= 48 && cr.height <= 340 && cr.width >= 260 && (parseFloat(cs.borderRadius) >= 6 || parseFloat(cs.borderWidth) > 0)) {
            if (cur.dataset.atsComposer !== '1') cur.dataset.atsComposer = '1';
            composerMatched = true;
            break;
          }
        }
        if (composerMatched) break;
      }
    }

    // 3b. 主画布与左侧栏语义标记（兜底 .agy-* 类名变更）
    let canvasMatched = !!document.querySelector('.agy-inset-shell > div.flex-1, .agy-sheet > div > div:first-child');
    if (!canvasMatched) {
      const candidates = document.querySelectorAll('#root div, main, section');
      let best = null;
      let bestArea = 0;
      for (const el of candidates) {
        if (el.closest('#' + BACKDROP_ID)) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= vw * 0.36 && r.height >= vh * 0.5 && r.left >= 30 && r.width < vw * 0.96) {
          const area = r.width * r.height;
          if (area > bestArea && (el.querySelector('textarea, [contenteditable="true"]') || el.scrollHeight > el.clientHeight)) {
            best = el;
            bestArea = area;
          }
        }
      }
      if (best) {
        if (best.dataset.atsCanvas !== '1') best.dataset.atsCanvas = '1';
        canvasMatched = true;
      }
    }
    if (!document.querySelector('.agy-inset-shell')) {
      const navs = document.querySelectorAll('aside, nav, #root > div > div > div');
      for (const el of navs) {
        const r = el.getBoundingClientRect();
        if (r.left <= 16 && r.width >= 150 && r.width <= 380 && r.height >= vh * 0.7) {
          if (el.dataset.atsShell !== '1') el.dataset.atsShell = '1';
          break;
        }
      }
    }

    // 3b-2. 开启自定义背景图时，自动探测并透底任何遮挡画布的大面积不透明包裹层（覆盖 y:75 起的对话主栏与右侧栏）
    if (payload.showCustomBg) {
      const sheetHost = document.querySelector('.agy-sheet') || document.getElementById('root');
      if (sheetHost) {
        for (const el of sheetHost.querySelectorAll('div')) {
          if (el.closest('#' + BACKDROP_ID) || el.closest('.surface-composer-card') || el.closest('.bg-card') || el.closest('[role="dialog"]') || el.closest('[role="menu"]')) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 280 || r.height < vh * 0.45) continue;
          const cs = getComputedStyle(el);
          const bgC = cs.backgroundColor || '';
          if (bgC && bgC !== 'rgba(0, 0, 0, 0)' && !bgC.startsWith('rgba(') && !/\/\s*0\.[0-7]/.test(bgC)) {
            if (el.dataset.atsTransparent !== '1') el.dataset.atsTransparent = '1';
          }
        }
      }
    } else {
      for (const el of document.querySelectorAll('[data-ats-transparent="1"]')) {
        el.removeAttribute('data-ats-transparent');
      }
    }

    // 3c. 动态嗅探未知新版 CSS 变量并按命名语义补全
    let adaptedTokens = 0;
    const p = payload.palette;
    if (p) {
      const known = new Set([
        '--background', '--color-background', '--content', '--shell', '--sidebar', '--color-sidebar',
        '--sidebar-muted', '--color-sidebar-muted', '--color-sidebar-secondary', '--foreground', '--card',
        '--color-card', '--card-foreground', '--card-border', '--color-card-border', '--onyx-raised',
        '--onyx-frame', '--onyx-key', '--popover', '--popover-foreground', '--primary', '--color-primary',
        '--primary-foreground', '--color-primary-foreground', '--secondary', '--color-secondary',
        '--secondary-foreground', '--color-secondary-foreground', '--muted', '--color-muted',
        '--muted-foreground', '--accent', '--accent-foreground', '--border', '--glass-border',
        '--input', '--ring', '--focus-ring-color', '--nux-focus-ring', '--home-glow',
        '--editor-code-block-background', '--editor-selection-background', '--bg-selection-overlay',
        '--focus-ring-offset-color', '--code-foreground', '--color-code', '--placeholder', '--color-placeholder',
      ]);
      const found = new Set();
      const sheetSig = document.styleSheets.length;
      if (!window.__atsDiscoveredVars || window.__atsDiscoveredSig !== sheetSig) {
        for (const sheet of document.styleSheets) {
          let rules;
          try {
            rules = sheet.cssRules;
          } catch {
            continue;
          }
          if (!rules) continue;
          for (const rule of rules) {
            const st = rule.style;
            if (!st) continue;
            for (let i = 0; i < st.length; i++) {
              const name = st[i];
              if (name && name.startsWith('--') && !name.startsWith('--ats-') && !name.startsWith('--tw-') && !name.startsWith('--syntax-') && !known.has(name)) {
                found.add(name);
              }
            }
          }
        }
        window.__atsDiscoveredVars = Array.from(found);
        window.__atsDiscoveredSig = sheetSig;
      }

      const mapColor = (name) => {
        const n = name.toLowerCase();
        if (n.startsWith('--vscode-') || /(font|size|radius|gap|space|width|height|shadow|z-index|duration|blur|opacity|cursor|match|highlight|scrollbar|thumb)/.test(n)) return '';
        if (!/(color|bg|background|surface|sidebar|card|panel|popover|dialog|fg|foreground|text|border|divider|accent|primary|code|selection)/.test(n)) return '';
        if (/selection/.test(n)) return p.selectionBg;
        if (/(sidebar|rail|nav)/.test(n) && !/(fg|text|border)/.test(n)) return p.bgSidebar;
        if (/(code|pre)/.test(n) && !/(fg|text|border)/.test(n)) return p.bgCode;
        if (/(border|divider|stroke)/.test(n)) return p.border;
        if (/(accent|primary)/.test(n) && !/(fg|foreground|text)/.test(n)) return p.accent;
        if (/(muted.*fg|muted.*text|secondary.*text)/.test(n)) return p.mutedForeground;
        if (/(fg|foreground|text)/.test(n)) return p.foreground;
        if (/(card|popover|panel|dialog|surface|modal|elevated)/.test(n)) return p.bgCard;
        if (/(bg|background|canvas|shell)/.test(n)) return p.bgPage;
        return '';
      };

      const decls = [];
      for (const vName of window.__atsDiscoveredVars || []) {
        const mapped = mapColor(vName);
        if (mapped) {
          decls.push(vName + ': ' + mapped + ' !important;');
          adaptedTokens++;
        }
      }
      const themeSelectors = [':root', 'html', 'body'];
      for (const el of [document.documentElement, document.body]) {
        if (!el) continue;
        for (const cls of el.classList) {
          if (/theme|dark|light|mode/i.test(cls) && /^[a-z0-9_-]+$/i.test(cls)) {
            themeSelectors.push((el === document.documentElement ? 'html.' : 'body.') + cls);
          }
        }
        const dt = el.getAttribute('data-theme');
        if (dt && /^[a-z0-9_-]+$/i.test(dt)) {
          themeSelectors.push((el === document.documentElement ? 'html' : 'body') + '[data-theme="' + dt + '"]');
        }
      }
      const adaptCss = decls.length ? Array.from(new Set(themeSelectors)).join(', ') + ' {\n  ' + decls.join('\n  ') + '\n}' : '';
      let adaptEl = document.getElementById(ADAPT_STYLE_ID);
      if (adaptCss) {
        if (!adaptEl) {
          adaptEl = document.createElement('style');
          adaptEl.id = ADAPT_STYLE_ID;
          (document.head || document.documentElement).appendChild(adaptEl);
        }
        if (adaptEl.textContent !== adaptCss) adaptEl.textContent = adaptCss;
      } else if (adaptEl) {
        adaptEl.textContent = '';
      }
    }

    return { composerMatched, canvasMatched, adaptedTokens };
  }

  // 4. 自动避让检测：支持类名、嵌入标签与纯几何分栏探测（已移除窄窗避让淡出）
  window.__atsAuxShift = payload.auxShift !== false;
  let lastAuxMode = 'none';
  function updateAvoidance() {
    const bd = document.getElementById(BACKDROP_ID);
    if (!bd) return;
    delete bd.dataset.narrow;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;

    let auxWidth = 0;
    lastAuxMode = 'none';
    const sheetRight = document.querySelector('.agy-sheet > div > div:last-child');
    if (sheetRight) {
      const r = sheetRight.getBoundingClientRect();
      const cs = getComputedStyle(sheetRight);
      if (r.width >= 160 && r.height >= 200 && cs.display !== 'none' && cs.visibility !== 'hidden') {
        auxWidth = Math.max(auxWidth, vw - r.left);
        lastAuxMode = 'selector';
      }
    }
    if (auxWidth < 160) {
      const embeds = document.querySelectorAll('agent-embed, iframe, [class*="aux" i], [data-testid*="aux" i], [aria-label*="panel" i]');
      for (const el of embeds) {
        if (el.closest('#' + BACKDROP_ID) || el.closest('#hagemi-pet-root')) continue;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        if (r.width >= 200 && r.height >= 180 && r.left >= vw * 0.42 && r.right >= vw - 90) {
          auxWidth = Math.max(auxWidth, vw - r.left);
          lastAuxMode = 'embed';
        }
      }
    }
    if (auxWidth < 160 && !document.querySelector('.agy-sheet > div')) {
      // 仅当原生 .agy-sheet 不存在时启用浅层几何兜底，避免遍历数千个聊天消息 div
      const containers = document.querySelectorAll('#root > div, #root > div > div, #root > div > div > div, main, main > div');
      for (const box of containers) {
        if (box.closest('#' + BACKDROP_ID)) continue;
        const cs = getComputedStyle(box);
        if (cs.display !== 'flex' && cs.display !== 'inline-flex' && cs.display !== 'grid') continue;
        const br = box.getBoundingClientRect();
        if (br.width < vw * 0.68 || br.height < vh * 0.55 || box.children.length < 2) continue;
        const last = box.lastElementChild;
        const first = box.firstElementChild;
        if (!last || !first || last === first) continue;
        const lr = last.getBoundingClientRect();
        const fr = first.getBoundingClientRect();
        const lcs = getComputedStyle(last);
        if (lcs.display === 'none' || lcs.visibility === 'hidden') continue;
        if (lr.width >= 180 && lr.width <= vw * 0.6 && lr.height >= vh * 0.55 && lr.left >= vw * 0.4 && lr.right >= vw - 36 && fr.right <= lr.left + 16) {
          auxWidth = Math.max(auxWidth, vw - lr.left);
          lastAuxMode = 'geometry';
        }
      }
    }

    const auxOpen = auxWidth >= 160;
    bd.dataset.auxOpen = auxOpen ? 'true' : 'false';
    const shiftPx = auxOpen && window.__atsAuxShift && (vw - auxWidth) >= 680 ? Math.round(auxWidth) : 0;
    const prevShift = window.__atsLastShift ?? 0;
    const delta = Math.abs(shiftPx - prevShift);
    // 拖动分割线/连续渐变帧时关闭过渡动画直接 1:1 跟随，瞬间开关时保留丝滑 GPU 过渡
    if (delta > 0 && delta < 48 && prevShift > 0 && shiftPx > 0) {
      bd.dataset.auxDragging = 'true';
      clearTimeout(window.__atsDragTimer);
      window.__atsDragTimer = setTimeout(() => {
        bd.dataset.auxDragging = 'false';
      }, 140);
    } else if (delta >= 48) {
      bd.dataset.auxDragging = 'false';
    }
    if (shiftPx !== prevShift) {
      window.__atsLastShift = shiftPx;
      bd.style.setProperty('--ats-aux-shift', shiftPx + 'px');
    }

    // 同步对齐顶部对话栏右侧红框区快捷切换开关（优先复用缓存节点，避免流式输出时遍历整页 div）
    const pill = document.getElementById(PILL_ID);
    if (pill) {
      const isValidTopBar = (el) => {
        if (!el || !el.isConnected || el.id === PILL_ID || el.closest('#' + BACKDROP_ID)) return null;
        if (el.children.length < 2) return null;
        const r = el.getBoundingClientRect();
        if (r.top < 20 || r.top > 72 || r.height < 28 || r.height > 54 || r.width < 360) return null;
        const first = el.firstElementChild;
        const last = el.lastElementChild;
        if (first && last && last !== first && last.querySelector('button, svg')) return r;
        return null;
      };
      let bar = window.__atsTopBarEl || null;
      let br = isValidTopBar(bar);
      if (!br) {
        bar = null;
        const bars = document.querySelectorAll('header, #root > div > div, #root > div > div > div, #root div');
        for (const el of bars) {
          const rect = isValidTopBar(el);
          if (rect) {
            bar = el;
            br = rect;
            break;
          }
        }
        window.__atsTopBarEl = bar;
      }
      if (bar && br) {
        const fr = bar.firstElementChild.getBoundingClientRect();
        const lr = bar.lastElementChild.getBoundingClientRect();
        const freeGap = lr.left - fr.right;
        if (freeGap < 120) {
          pill.style.opacity = '0';
          pill.style.pointerEvents = 'none';
        } else {
          pill.style.top = Math.round(br.top + (br.height - 26) / 2) + 'px';
          pill.style.right = Math.max(84, Math.round(vw - lr.left + 12)) + 'px';
          pill.style.opacity = '1';
          pill.style.pointerEvents = 'auto';
        }
      }
    }
  }
  window.__atsUpdateLayout = updateAvoidance;

  if (!window.__atsResizeHandler) {
    window.__atsResizeHandler = () => requestAnimationFrame(() => window.__atsUpdateLayout?.());
    window.addEventListener('resize', window.__atsResizeHandler, { passive: true });
  }
  if (!window.__atsResizeObs && typeof ResizeObserver !== 'undefined') {
    window.__atsResizeObs = new ResizeObserver(() => requestAnimationFrame(() => window.__atsUpdateLayout?.()));
    const sheetInner = document.querySelector('.agy-sheet > div');
    if (sheetInner) {
      window.__atsResizeObs.observe(sheetInner);
      if (sheetInner.lastElementChild) window.__atsResizeObs.observe(sheetInner.lastElementChild);
    }
  }
  if (!window.__atsObserver) {
    let raf = 0;
    let cooldownTimer = 0;
    let lastAvoidRunAt = 0;
    window.__atsObserver = new MutationObserver((records) => {
      let relevant = false;
      for (const rec of records) {
        const tgt = rec.target;
        if (tgt && tgt.nodeType === 1) {
          const el = /** @type {Element} */ (tgt);
          if (el.id === BACKDROP_ID || el.id === PILL_ID || el.closest('#' + BACKDROP_ID) || el.closest('#' + PILL_ID)) continue;
        }
        relevant = true;
        break;
      }
      if (!relevant || raf || cooldownTimer) return;
      const since = performance.now() - lastAvoidRunAt;
      const schedule = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          lastAvoidRunAt = performance.now();
          window.__atsUpdateLayout?.();
        });
      };
      if (since >= 180) {
        schedule();
      } else {
        cooldownTimer = setTimeout(() => {
          cooldownTimer = 0;
          schedule();
        }, 180 - since);
      }
    });
    window.__atsObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'aria-hidden'] });
  }
  const envCompat = adaptEnvironment();
  updateAvoidance();

  return {
    ok: true,
    state: 'applied',
    needImage,
    needExprPack,
    needBgImage,
    systemDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    compat: { ...envCompat, auxMode: lastAuxMode },
  };
}

const PAGE_CONTROLLER_FN = `(${pageController.toString()})`;
export { pageController };

export class ThemeInjector {
  constructor({ assetsDir, getSettings, resolveTheme, onPatch = null, log = () => {}, telemetryMod = null }) {
    this.assetsDir = assetsDir;
    this.getSettings = getSettings;
    this.resolveTheme = resolveTheme;
    this.onPatch = onPatch;
    this.log = log;
    this.profileDir = profileDirectory();
    this.profileDirs = profileDirectories();
    this._procEndpoints = { ports: [], userDataDirs: [] };
    this._lastProcScanAt = 0;
    this.sessions = new Map();
    this.imageCache = new Map();
    this.health = { state: 'waiting', windows: 0, systemDark: false, compat: null };
    this._timer = null;
    this._stopped = false;
    this._syncQueue = Promise.resolve();
    const TelemetryCtor = telemetryMod?.LocalTelemetry || DefaultLocalTelemetry;
    this.telemetry = new TelemetryCtor({
      log: this.log,
      onSignal: (sig) => void this._broadcastSignal(sig),
    });
  }

  start() {
    this._stopped = false;
    this.telemetry?.start();
    void this.tick();
    this._timer = setInterval(() => void this.tick(), 3000);
  }

  async stop() {
    this._stopped = true;
    this.telemetry?.stop();
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    for (const session of [...this.sessions.values()]) {
      try {
        if (session.contextId) {
          await this.evalInSession(session, `${PAGE_CONTROLLER_FN}({ enabled: false })`);
        }
      } catch {
        // ignore
      }
      session.close();
    }
    this.sessions.clear();
    this.health = { state: 'stopped', windows: 0, systemDark: this.health.systemDark };
  }

  async _broadcastSignal(sig) {
    if (this._stopped || !sig || this.sessions.size === 0) return;
    const settings = this.getSettings();
    if (!settings?.enabled || settings.portrait?.enabled === false || settings.portrait?.aiCompanion === false) {
      return;
    }
    const expr = `window.__atsOnSignal && window.__atsOnSignal(${JSON.stringify(sig)})`;
    await Promise.allSettled(
      [...this.sessions.values()]
        .filter((s) => s.contextId)
        .map((s) => this.evalInSession(s, expr).catch(() => {}))
    );
  }

  _readCachedImage(chosen) {
    if (!chosen || !existsSync(chosen)) return null;
    const st = statSync(chosen);
    const cached = this.imageCache.get(chosen);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return { hash: cached.hash, dataUrl: cached.dataUrl };
    }
    const buf = readFileSync(chosen);
    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 16);
    const dataUrl = `data:${mimeForExt(chosen)};base64,${buf.toString('base64')}`;
    this.imageCache.set(chosen, { mtimeMs: st.mtimeMs, size: st.size, hash, dataUrl });
    return { hash, dataUrl };
  }

  _resolveImageAsset(theme, settings) {
    const defaultAnchor = { dx: 0, dy: 0, scale: 1 };
    if (!settings.portrait.enabled) {
      return { showPortrait: false, outfitKey: '', hash: '', dataUrl: null, allowExpression: false, exprAnchor: defaultAnchor };
    }
    const isNight = theme.portraitKey === 'night';
    const customPath = isNight ? settings.portrait.customNightImage : settings.portrait.customDayImage;
    const outfitKey = isNight ? settings.portrait.nightOutfit : settings.portrait.dayOutfit;
    const outfit = BUILTIN_PORTRAITS[outfitKey] || BUILTIN_PORTRAITS[isNight ? 'night' : 'day'];
    const defaultPath = join(this.assetsDir, outfit.file);
    const isCustom = !!(customPath && existsSync(customPath));
    const chosen = isCustom ? customPath : defaultPath;
    const img = this._readCachedImage(chosen);
    const exprAnchor = isCustom ? defaultAnchor : (outfit.exprAnchor || defaultAnchor);
    return img
      ? { showPortrait: true, outfitKey: isCustom ? '' : outfit.id, ...img, allowExpression: !isCustom, exprAnchor }
      : { showPortrait: false, outfitKey: '', hash: '', dataUrl: null, allowExpression: false, exprAnchor: defaultAnchor };
  }

  _resolveExpressionPack() {
    const sigParts = [];
    const patches = {};
    const hashParts = [];
    for (const expr of Object.values(BUILTIN_EXPRESSIONS)) {
      if (!expr.file) continue;
      const fullPath = join(this.assetsDir, expr.file);
      const cached = this._readCachedImage(fullPath);
      if (!cached) continue;
      sigParts.push(`${expr.id}:${cached.hash}`);
      patches[expr.id] = { dataUrl: cached.dataUrl, x: expr.x ?? 265, y: expr.y ?? 195 };
      hashParts.push(`${expr.id}:${cached.hash}`);
    }
    const sig = sigParts.join('|');
    if (this._exprPackCache && this._exprPackCache.sig === sig) {
      return this._exprPackCache.result;
    }
    const hash = hashParts.length ? createHash('sha1').update(sig).digest('hex').slice(0, 16) : '';
    const result = { hash, patches };
    this._exprPackCache = { sig, result };
    return result;
  }

  _resolveCustomBgAsset(settings) {
    const filePath = settings.effects?.customBgImage || '';
    const hasSavedBg = !!(filePath && existsSync(filePath));
    if (!settings.effects?.customBgEnabled || !hasSavedBg) {
      return { showCustomBg: false, hasSavedBg, hash: '', dataUrl: null };
    }
    const img = this._readCachedImage(filePath);
    return img ? { showCustomBg: true, hasSavedBg: true, ...img } : { showCustomBg: false, hasSavedBg: false, hash: '', dataUrl: null };
  }

  async _discoverProcessEndpoints() {
    const now = Date.now();
    if (now - this._lastProcScanAt < 10000) return this._procEndpoints;
    this._lastProcScanAt = now;
    const ports = new Set();
    const userDataDirs = new Set();
    try {
      let lines = [];
      if (process.platform === 'win32') {
        const script =
          "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*Antigravity*' -or $_.CommandLine -like '*Antigravity*' } | Select-Object -ExpandProperty CommandLine";
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          windowsHide: true,
          timeout: 6000,
          maxBuffer: 1 << 20,
        });
        lines = stdout.split(/\r?\n/).filter(Boolean);
      } else {
        const { stdout } = await execFileAsync('ps', ['-ww', '-axo', 'args='], {
          timeout: 6000,
          maxBuffer: 1 << 21,
        });
        lines = stdout.split(/\r?\n/).filter((line) => /antigravity/i.test(line));
      }
      for (const line of lines) {
        const parsed = parseCdpArgs(line);
        for (const p of parsed.ports) ports.add(p);
        for (const d of parsed.userDataDirs) userDataDirs.add(d);
      }
    } catch {
      // 忽略进程枚举失败，保留常规路径探测
    }
    this._procEndpoints = { ports: [...ports], userDataDirs: [...userDataDirs] };
    return this._procEndpoints;
  }

  async _collectPorts(dirs, extraPorts = []) {
    const ports = new Set();
    const envPort = Number(process.env.ANTIGRAVITY_CDP_PORT);
    if (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535) ports.add(envPort);
    for (const p of extraPorts) {
      if (Number.isInteger(p) && p >= 1 && p <= 65535) ports.add(p);
    }
    for (const dir of dirs) {
      try {
        const portText = await readFile(join(dir, 'DevToolsActivePort'), 'utf8');
        const port = Number(portText.split(/\r?\n/)[0]);
        if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
      } catch {
        // 忽略不存在或不可读的目录
      }
    }
    return [...ports];
  }

  async _queryTargetsOnPorts(ports) {
    const seen = new Set();
    const targets = [];
    for (const port of ports) {
      try {
        const list = await httpGetJson(`http://127.0.0.1:${port}/json/list`, 2500);
        if (!Array.isArray(list)) continue;
        for (const t of list) {
          if (!isAppWindow(t, port)) continue;
          const key = t.id || t.webSocketDebuggerUrl;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          targets.push(t);
        }
      } catch {
        // 端口不可达或非当前目标，继续尝试其余候选端口
      }
    }
    return targets;
  }

  async _discoverTargets() {
    const fastDirs = [...new Set([...this.profileDirs, ...(this._procEndpoints.userDataDirs || [])])];
    const fastPorts = await this._collectPorts(fastDirs, this._procEndpoints.ports);
    let targets = await this._queryTargetsOnPorts(fastPorts);
    if (targets.length > 0) return targets;

    const proc = await this._discoverProcessEndpoints();
    const allDirs = [...new Set([...this.profileDirs, ...proc.userDataDirs])];
    const allPorts = await this._collectPorts(allDirs, proc.ports);
    if (allPorts.length === 0) {
      const err = new Error('DevToolsActivePort not found');
      err.code = 'ENOENT';
      throw err;
    }
    targets = await this._queryTargetsOnPorts(allPorts);
    return targets;
  }

  _handleSessionEvent(session, { method, params }) {
    if (method === 'Runtime.executionContextDestroyed' && params?.executionContextId === session.contextId) {
      session.contextId = null;
      session.controllerReady = false;
      session.knownImageHashes?.clear();
      session.sentExprHash = null;
    } else if (method === 'Runtime.executionContextsCleared' || (method === 'Page.frameNavigated' && !params?.frame?.parentId)) {
      session.contextId = null;
      session.controllerReady = false;
      session.knownImageHashes?.clear();
      session.sentExprHash = null;
      session.sentBgHash = null;
    } else if (method === 'Runtime.bindingCalled' && params?.name === '__atsBridge') {
      try {
        const msg = JSON.parse(params.payload || '{}');
        if (msg?.action === 'pickCustomBg') {
          void this.onPatch?.({ action: 'pickCustomBg' });
        } else if (msg?.action === 'randomLook') {
          const current = this.getSettings();
          const theme = this.resolveTheme(current, { systemDark: this.health.systemDark });
          const isNight = theme.portraitKey === 'night';
          const curOutfit = isNight ? current.portrait.nightOutfit : current.portrait.dayOutfit;
          const nextOutfit = pickDifferent(Object.keys(BUILTIN_PORTRAITS), curOutfit);
          const nextExpr = pickDifferent(Object.keys(BUILTIN_EXPRESSIONS), current.portrait.expression);
          const portraitPatch = isNight
            ? { enabled: true, nightOutfit: nextOutfit, customNightImage: '', expression: nextExpr }
            : { enabled: true, dayOutfit: nextOutfit, customDayImage: '', expression: nextExpr };
          void this.onPatch?.({ portrait: portraitPatch });
        } else if (msg?.portrait && typeof msg.portrait === 'object') {
          if (typeof msg.portrait.expression === 'string' && BUILTIN_EXPRESSIONS[msg.portrait.expression]) {
            void this.onPatch?.({ portrait: { expression: msg.portrait.expression } });
          }
        } else if (msg?.effects && typeof msg.effects === 'object') {
          const patchEffects = {};
          if (typeof msg.effects.customBgEnabled === 'boolean') patchEffects.customBgEnabled = msg.effects.customBgEnabled;
          if (msg.effects.customBgImage === '') patchEffects.customBgImage = '';
          if (Object.keys(patchEffects).length > 0) {
            void this.onPatch?.({ effects: patchEffects });
          }
        }
      } catch {
        // ignore invalid payload
      }
    }
  }

  async _createWorld(session) {
    const tree = await session.command('Page.getFrameTree');
    const frameId = tree.frameTree?.frame?.id;
    if (!frameId) throw new Error('no root frame');
    try {
      await session.command('Runtime.addBinding', { name: '__atsBridge', executionContextName: WORLD_NAME });
    } catch {
      try {
        await session.command('Runtime.addBinding', { name: '__atsBridge' });
      } catch {
        // 忽略重复绑定错误
      }
    }
    const world = await session.command('Page.createIsolatedWorld', {
      frameId,
      worldName: WORLD_NAME,
      grantUniveralAccess: false,
    });
    session.contextId = world.executionContextId;
    session.controllerReady = false;
    session.knownImageHashes?.clear();
    session.sentExprHash = null;
    session.sentBgHash = null;
  }

  async _ensureSession(target) {
    const existing = this.sessions.get(target.id);
    if (existing) {
      if (!existing.contextId) {
        await this._createWorld(existing);
      }
      return existing;
    }
    const session = new CdpSession(
      target.webSocketDebuggerUrl,
      (s, msg) => this._handleSessionEvent(s, msg),
      () => {
        this.sessions.delete(target.id);
        this.health.windows = this.sessions.size;
      }
    );
    await session.open();
    try {
      // 主世界检测 __APP_CONFIG__（孤立世界读不到主世界的 window 属性）
      const check = await session.command('Runtime.evaluate', { expression: APP_CHECK, returnByValue: true });
      if (check?.result?.value !== true) {
        session.close();
        return null;
      }
      await session.command('Page.enable');
      await session.command('Runtime.enable');
      try {
        await session.command('Runtime.addBinding', { name: '__atsBridge', executionContextName: WORLD_NAME });
      } catch {
        // 兼容早期 CDP 版本回退全上下文绑定
        await session.command('Runtime.addBinding', { name: '__atsBridge' });
      }
      await this._createWorld(session);
      this.sessions.set(target.id, session);
      this.log(`attached to window ${target.id}`);
      return session;
    } catch (err) {
      session.close();
      throw err;
    }
  }

  evalInSession(session, expression) {
    return session.command('Runtime.evaluate', {
      expression,
      contextId: session.contextId,
      returnByValue: true,
    });
  }

  syncAll() {
    const run = async () => {
      const settings = this.getSettings();
      const theme = this.resolveTheme(settings, { systemDark: this.health.systemDark });
      const image = settings.enabled ? this._resolveImageAsset(theme, settings) : { showPortrait: false, outfitKey: '', hash: '', dataUrl: null, allowExpression: false, exprAnchor: { dx: 0, dy: 0, scale: 1 } };
      const exprPack = settings.enabled && image.showPortrait && image.allowExpression ? this._resolveExpressionPack() : { hash: '', patches: null };
      const bgImg = settings.enabled ? this._resolveCustomBgAsset(settings) : { showCustomBg: false, hasSavedBg: false, hash: '', dataUrl: null };
      const css = settings.enabled ? buildThemeCss(theme, settings, bgImg.showCustomBg) : '';

      for (const session of [...this.sessions.values()]) {
        if (!session.contextId) continue;
        try {
          if (!session.knownImageHashes) session.knownImageHashes = new Set();
          if (!settings.enabled || !bgImg.showCustomBg) {
            session.sentBgHash = null;
          }
          const rememberImg = (h) => {
            if (!h) return;
            session.knownImageHashes.delete(h);
            session.knownImageHashes.add(h);
            while (session.knownImageHashes.size > 20) {
              const oldest = session.knownImageHashes.values().next().value;
              session.knownImageHashes.delete(oldest);
            }
          };
          const sendImg = image.showPortrait && !!image.hash && !session.knownImageHashes.has(image.hash);
          const sendExpr = image.showPortrait && image.allowExpression && !!exprPack.hash && session.sentExprHash !== exprPack.hash;
          const sendBg = bgImg.showCustomBg && session.sentBgHash !== bgImg.hash;
          const makePayload = (withPortrait, withExpr, withBg) => ({
            enabled: settings.enabled,
            phase: theme.phase,
            mode: settings.mode || 'auto',
            palette: theme.palette,
            accentColor: theme.palette?.accent || '#7C5CE6',
            css,
            showPortrait: image.showPortrait,
            outfitKey: image.outfitKey || '',
            featherLeft: settings.portrait.featherLeft ?? 14,
            featherBottom: settings.portrait.featherBottom ?? 12,
            auxShift: settings.portrait.auxShift !== false,
            idleMotion: settings.portrait.idleMotion !== false,
            idleMotionAmp: settings.portrait.idleMotionAmp ?? 0.75,
            clickBounce: settings.portrait.clickBounce !== false,
            clickBounceRange: settings.portrait.clickBounceRange ?? 0.45,
            clickExpression: settings.portrait.clickExpression !== false,
            microMotion: settings.portrait.microMotion !== false,
            ambientLight: settings.portrait.ambientLight !== false,
            aiCompanion: settings.portrait.aiCompanion !== false,
            portraitScale: settings.portrait.scale ?? 1.0,
            expression: settings.portrait.expression || 'default',
            allowExpression: !!image.allowExpression,
            exprAnchor: image.exprAnchor || { dx: 0, dy: 0, scale: 1 },
            exprPackHash: exprPack.hash,
            exprPack: withExpr ? exprPack.patches : null,
            flipX: settings.portrait.flipX === true,
            imageHash: image.hash,
            imageDataUrl: withPortrait ? image.dataUrl : null,
            hasSavedBg: bgImg.hasSavedBg,
            customBgEnabled: !!settings.effects?.customBgEnabled,
            showCustomBg: bgImg.showCustomBg,
            bgHash: bgImg.hash,
            bgDataUrl: withBg ? bgImg.dataUrl : null,
          });
          const runController = (withPortrait, withExpr, withBg) => {
            const payloadJson = JSON.stringify(makePayload(withPortrait, withExpr, withBg));
            const expr = session.controllerReady
              ? `(typeof window.__atsPageController==='function'?window.__atsPageController(${payloadJson}):{needController:true})`
              : `(window.__atsPageController=${PAGE_CONTROLLER_FN})(${payloadJson})`;
            return this.evalInSession(session, expr);
          };
          let res = await runController(sendImg, sendExpr, sendBg);
          if (res?.exceptionDetails) {
            this.log(`page eval error: ${res.exceptionDetails.text || res.exceptionDetails.exception?.description || 'unknown'}`);
          }
          let val = res?.result?.value;
          if (val?.needController) {
            session.controllerReady = false;
            res = await runController(sendImg, sendExpr, sendBg);
            val = res?.result?.value;
          }
          if (val?.ok) {
            session.controllerReady = true;
          }
          const retryPortrait = !!(val?.needImage && image.showPortrait && image.dataUrl);
          const retryExpr = !!(val?.needExprPack && image.showPortrait && image.allowExpression && exprPack.hash && exprPack.patches);
          const retryBg = !!(val?.needBgImage && bgImg.showCustomBg && bgImg.dataUrl);
          if (retryPortrait || retryExpr || retryBg) {
            if (retryPortrait) session.knownImageHashes.delete(image.hash);
            if (retryExpr) session.sentExprHash = null;
            if (retryBg) session.sentBgHash = null;
            res = await runController(retryPortrait, retryExpr, retryBg);
            val = res?.result?.value;
            if (val?.ok) {
              session.controllerReady = true;
              if (retryPortrait) rememberImg(image.hash);
              if (retryExpr) session.sentExprHash = exprPack.hash;
              if (retryBg) session.sentBgHash = bgImg.hash;
            }
          } else if (val?.ok) {
            if (sendImg) rememberImg(image.hash);
            if (sendExpr) session.sentExprHash = exprPack.hash;
            if (sendBg) session.sentBgHash = bgImg.hash;
          }
          if (typeof val?.systemDark === 'boolean') {
            this.health.systemDark = val.systemDark;
          }
          if (val?.compat) {
            this.health.compat = val.compat;
          }
        } catch (err) {
          this.log(`sync error: ${err.message}`);
          session.close();
        }
      }
      this.health.windows = this.sessions.size;
      this.health.state = this.sessions.size > 0 ? 'connected' : 'waiting';
    };
    this._syncQueue = this._syncQueue.then(run, run);
    return this._syncQueue;
  }

  async tick() {
    if (this._stopped) return;
    try {
      const targets = await this._discoverTargets();
      const activeIds = new Set(targets.map((t) => t.id));
      for (const [id, session] of [...this.sessions.entries()]) {
        if (!activeIds.has(id)) {
          session.close();
          this.sessions.delete(id);
        }
      }
      for (const target of targets) {
        try {
          await this._ensureSession(target);
        } catch (err) {
          this.log(`attach retry (${target.id}): ${err.message}`);
        }
      }
      await this.syncAll();
    } catch (err) {
      if (err?.code !== 'ENOENT') this.log(`tick waiting: ${err.message}`);
      this.health = { state: 'waiting', windows: this.sessions.size, systemDark: this.health.systemDark };
    }
  }
}
