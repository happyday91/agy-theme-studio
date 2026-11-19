// 通过本地 DevToolsActivePort 孤立世界向 Antigravity 桌面端注入主题 CSS 与右侧自适应立绘
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { BUILTIN_EXPRESSIONS, BUILTIN_PORTRAITS } from './presets.mjs';

const WORLD_NAME = 'agy-theme-studio';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
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
  }

  open(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
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
  transition: opacity 0.22s ease, transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
  pointer-events: none !important;
  -webkit-mask-image:
    linear-gradient(to top, transparent 0%, #000 ${pr.featherBottom}%, #000 100%),
    linear-gradient(to right, transparent 0%, #000 ${pr.featherLeft}%, #000 100%);
  -webkit-mask-composite: source-in;
  mask-image:
    linear-gradient(to top, transparent 0%, #000 ${pr.featherBottom}%, #000 100%),
    linear-gradient(to right, transparent 0%, #000 ${pr.featherLeft}%, #000 100%);
  mask-composite: intersect;
}

#agy-theme-studio-backdrop[data-aux-dragging="true"] #agy-theme-studio-portrait-wrap {
  transition: opacity 0.18s ease;
}

#agy-theme-studio-backdrop[data-aux-open="true"] #agy-theme-studio-portrait-wrap {
  opacity: ${pr.enabled ? pr.auxAvoidOpacity : 0};
}

#agy-theme-studio-backdrop[data-narrow="true"] #agy-theme-studio-portrait-wrap {
  opacity: ${pr.enabled ? Math.min(pr.auxAvoidOpacity, 0.1) : 0};
}

#agy-theme-studio-portrait,
#agy-theme-studio-canvas {
  display: block;
  height: 100%;
  width: auto;
  max-width: 34vw;
  object-fit: contain;
  transform: translateZ(0)${pr.flipX ? ' scaleX(-1)' : ''};
  backface-visibility: hidden;
  pointer-events: none !important;
  filter: drop-shadow(0 12px 24px ${isDark ? 'rgba(18, 10, 36, 0.38)' : 'rgba(104, 78, 176, 0.18)'});
}

#agy-theme-studio-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
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
    window.__atsLastShift = 0;
    window.__atsDiscoveredVars = null;
    window.__atsDiscoveredSig = null;
    window.__atsBounce = null;
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

  let backdrop = document.getElementById(BACKDROP_ID);
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = BACKDROP_ID;

    const wrap = document.createElement('div');
    wrap.id = 'agy-theme-studio-portrait-wrap';
    const img = document.createElement('img');
    img.id = 'agy-theme-studio-portrait';
    img.alt = '';
    img.draggable = false;
    const canvas = document.createElement('canvas');
    canvas.id = 'agy-theme-studio-canvas';
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
  if (!topPill || !topPill.querySelector('#ats-bg-toggle')) {
    topPill?.remove();
    topPill = document.createElement('div');
    topPill.id = PILL_ID;

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
  let canvasEl = document.getElementById('agy-theme-studio-canvas');
  if (!canvasEl && imgEl?.parentElement) {
    canvasEl = document.createElement('canvas');
    canvasEl.id = 'agy-theme-studio-canvas';
    imgEl.parentElement.appendChild(canvasEl);
  }
  window.__atsClickBounce = payload.clickBounce !== false;
  window.__atsBounceRange = Number.isFinite(Number(payload.clickBounceRange)) ? Number(payload.clickBounceRange) : 0.45;
  window.__atsIdleAmp = payload.idleMotion !== false ? Math.min(2.0, Math.max(0.5, Number(payload.idleMotionAmp ?? 0.75))) : 0;
  window.__atsFlipX = payload.flipX === true;
  window.__atsShowPortrait = !!payload.showPortrait;
  window.__atsAllowExpr = !!payload.allowExpression;
  window.__atsClickExpr = payload.clickExpression !== false;
  const rawAnchor = payload.exprAnchor && typeof payload.exprAnchor === 'object' ? payload.exprAnchor : null;
  window.__atsExprAnchor = {
    dx: Number.isFinite(Number(rawAnchor?.dx)) ? Number(rawAnchor.dx) : Number(payload.exprOffsetX || 0),
    dy: Number.isFinite(Number(rawAnchor?.dy)) ? Number(rawAnchor.dy) : 0,
    scale: Number.isFinite(Number(rawAnchor?.scale)) && Number(rawAnchor.scale) > 0 ? Number(rawAnchor.scale) : 1,
  };
  const nextBaseExpr = typeof payload.expression === 'string' && payload.expression ? payload.expression : 'default';
  window.__atsBaseExpr = nextBaseExpr;

  if (!window.__atsExprPack) {
    window.__atsExprPack = { hash: '', imgs: {} };
  }
  if (!window.__atsPortraitCache) {
    window.__atsPortraitCache = { order: [], map: {} };
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

  function getEffectiveExpr() {
    if (!window.__atsAllowExpr) return 'default';
    return window.__atsBaseExpr || 'default';
  }

  if (!window.__atsBounce) {
    window.__atsBounce = {
      hitW: 96,
      hitH: 144,
      hitAlpha: null,
      hitHash: '',
      gl: null,
      shaderVer: 0,
      prog: null,
      tex: null,
      texPrev: null,
      texReady: false,
      texHash: '',
      texKey: '',
      fadeStartMs: 0,
      fadeMode: 'expr',
      compCanvas: null,
      indexCount: 0,
      uAspect: null,
      uTime: null,
      uIdle: null,
      uCount: null,
      uImpulses: null,
      uTex: null,
      uTexPrev: null,
      uFade: null,
      uExprPulse: null,
      impulses: [],
      aspect: 0.67,
      lastRenderMs: 0,
    };
  }

  function kickAnimLoop() {
    const st = window.__atsBounce;
    if (!st || !imgEl || document.hidden || !window.__atsShowPortrait) return;
    const isFading = st.fadeStartMs > 0 && performance.now() - st.fadeStartMs < 350;
    const needStaticExpr = st.gl && getEffectiveExpr() !== 'default';
    const needAnim = st.gl && (window.__atsIdleAmp > 0 || st.impulses.length > 0 || isFading);
    if ((needAnim || needStaticExpr) && !window.__atsBounceRaf) {
      window.__atsBounceRaf = requestAnimationFrame(renderFrame);
    } else if (!needAnim && !needStaticExpr && canvasEl) {
      imgEl.style.visibility = 'visible';
      canvasEl.style.display = 'none';
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

  function ensureHitMapAndTexture(img, hashOverride = '', hitAlphaOverride = null) {
    const st = window.__atsBounce;
    const hash = hashOverride || img?.dataset?.hash || '';
    if (!img || !img.complete || !img.naturalWidth || !hash) return;
    const newAspect = img.naturalWidth / img.naturalHeight;
    const prevAspect = st.aspect;
    st.aspect = newAspect;

    if (st.hitHash !== hash) {
      st.hitAlpha = hitAlphaOverride || computeHitAlpha(img);
      st.hitHash = hash;
    }

    if (canvasEl) {
      if (!st.gl || st.shaderVer !== 2) {
        const gl = st.gl || canvasEl.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
        if (gl) {
          const vsSrc = [
            'attribute vec2 a_uv;',
            'uniform float u_aspect;',
            'uniform float u_time;',
            'uniform float u_idle;',
            'uniform float u_expr_pulse;',
            'uniform int u_count;',
            'uniform vec4 u_impulses[6];',
            'varying vec2 v_uv;',
            'void main() {',
            '  v_uv = a_uv;',
            '  float u = a_uv.x;',
            '  float v = a_uv.y;',
            '  float bottomAnchor = smoothstep(0.99, 0.82, v);',
            '  float sideAnchor = smoothstep(0.0, 0.04, u) * smoothstep(1.0, 0.96, u);',
            '  float anchors = bottomAnchor * sideAnchor;',
            '  vec2 disp = vec2(0.0);',
            '  float headMask = smoothstep(0.36, 0.22, v) * smoothstep(0.02, 0.10, v);',
            '  if (abs(u_expr_pulse) > 0.0005) {',
            '    disp.y += 0.0085 * u_expr_pulse * headMask;',
            '    disp.x += (u - 0.5) * -0.006 * u_expr_pulse * headMask;',
            '  }',
            '  if (u_idle > 0.001) {',
            '    float breath = sin(u_time * 1.75);',
            '    vec2 cRel = vec2((u - 0.45) / 0.19, (v - 0.43) / 0.11);',
            '    float chestMask = exp(-0.5 * dot(cRel, cRel)) * smoothstep(0.28, 0.38, v) * bottomAnchor;',
            '    disp.y += -0.0055 * u_idle * breath * chestMask;',
            '    disp += vec2((u - 0.45) * 0.8, (v - 0.43)) * (0.014 * u_idle * breath * chestMask);',
            '    disp.y += -0.0022 * u_idle * sin(u_time * 1.75 - 0.45) * headMask;',
            '    float outerSide = smoothstep(0.25, 0.08, u) + smoothstep(0.68, 0.88, u);',
            '    float outerMask = clamp(outerSide, 0.0, 1.0) * smoothstep(0.22, 0.42, v) * smoothstep(0.94, 0.78, v) * sideAnchor;',
            '    float sway = sin(u_time * 1.35 + v * 4.2 + u * 2.1);',
            '    disp.x += 0.0068 * u_idle * sway * outerMask;',
            '    disp.y += 0.0025 * u_idle * cos(u_time * 1.35 + v * 3.8) * outerMask;',
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
            '    float dy = -0.046 * oscY * falloff * anchors;',
            '    if (dy < 0.0) dy *= smoothstep(0.0, 0.10, v);',
            '    vec2 radial = vec2(rel.x / max(u_aspect, 0.2), rel.y) * (0.24 * oscR * falloff * anchors);',
            '    float bias = clamp((imp.x - 0.5) * 2.0, -1.0, 1.0);',
            '    float dx = 0.013 * sin(age * 20.0 + 0.4) * env * falloff * anchors * (abs(bias) < 0.1 ? 1.0 : -sign(bias));',
            '    disp.x += dx + radial.x;',
            '    disp.y += dy + radial.y;',
            '  }',
            '  vec2 p = vec2((u + disp.x) * 2.0 - 1.0, 1.0 - (v + disp.y) * 2.0);',
            '  gl_Position = vec4(p, 0.0, 1.0);',
            '}',
          ].join('\n');
          const fsSrc = [
            'precision mediump float;',
            'uniform sampler2D u_tex;',
            'uniform sampler2D u_tex_prev;',
            'uniform float u_fade;',
            'varying vec2 v_uv;',
            'void main() {',
            '  vec4 cur = texture2D(u_tex, v_uv);',
            '  if (u_fade >= 0.999) {',
            '    gl_FragColor = cur;',
            '  } else {',
            '    vec4 prev = texture2D(u_tex_prev, v_uv);',
            '    gl_FragColor = mix(prev, cur, u_fade);',
            '  }',
            '}',
          ].join('\n');
          const compile = (type, src) => {
            const sh = gl.createShader(type);
            gl.shaderSource(sh, src);
            gl.compileShader(sh);
            return sh;
          };
          const prog = gl.createProgram();
          gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
          gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
          gl.linkProgram(prog);
          gl.useProgram(prog);

          const cols = 20;
          const rows = 28;
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
          const vb = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, vb);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
          const loc = gl.getAttribLocation(prog, 'a_uv');
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

          const ib = gl.createBuffer();
          gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
          gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);

          st.gl = gl;
          st.shaderVer = 2;
          st.prog = prog;
          st.indexCount = idx.length;
          st.uAspect = gl.getUniformLocation(prog, 'u_aspect');
          st.uTime = gl.getUniformLocation(prog, 'u_time');
          st.uIdle = gl.getUniformLocation(prog, 'u_idle');
          st.uExprPulse = gl.getUniformLocation(prog, 'u_expr_pulse');
          st.uCount = gl.getUniformLocation(prog, 'u_count');
          st.uImpulses = gl.getUniformLocation(prog, 'u_impulses');
          st.uTex = gl.getUniformLocation(prog, 'u_tex');
          st.uTexPrev = gl.getUniformLocation(prog, 'u_tex_prev');
          st.uFade = gl.getUniformLocation(prog, 'u_fade');
          if (!st.tex) st.tex = gl.createTexture();
          if (!st.texPrev) st.texPrev = gl.createTexture();
          // 用 1x1 透明像素占位初始化 texPrev，避免切穿搭时同步上传两遍大图
          gl.bindTexture(gl.TEXTURE_2D, st.texPrev);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
          st.texReady = false;
          st.texKey = '';
          st.texHash = '';
        }
      }
      const targetExpr = getEffectiveExpr();
      const exprEntry = targetExpr !== 'default' ? window.__atsExprPack?.imgs?.[targetExpr] : null;
      const canUseExpr = !!(exprEntry?.img && exprEntry.img.complete && exprEntry.img.naturalWidth > 0);
      const actualExpr = canUseExpr ? targetExpr : 'default';
      const anchor = window.__atsExprAnchor || { dx: 0, dy: 0, scale: 1 };
      const aDx = Number(anchor.dx) || 0;
      const aDy = Number(anchor.dy) || 0;
      const aScale = Number(anchor.scale) > 0 ? Number(anchor.scale) : 1;
      const nextTexKey = `${hash}|${actualExpr}|${aDx}:${aDy}:${aScale}`;
      if (st.gl && st.texKey !== nextTexKey) {
        const gl = st.gl;
        if (canvasEl.width !== img.naturalWidth || canvasEl.height !== img.naturalHeight || st.texHash !== hash) {
          canvasEl.width = img.naturalWidth;
          canvasEl.height = img.naturalHeight;
          gl.viewport(0, 0, canvasEl.width, canvasEl.height);
        }
        let texSource = img;
        if (canUseExpr) {
          if (!st.compCanvas) st.compCanvas = document.createElement('canvas');
          if (st.compCanvas.width !== img.naturalWidth || st.compCanvas.height !== img.naturalHeight) {
            st.compCanvas.width = img.naturalWidth;
            st.compCanvas.height = img.naturalHeight;
          }
          const cctx = st.compCanvas.getContext('2d');
          cctx.clearRect(0, 0, st.compCanvas.width, st.compCanvas.height);
          cctx.drawImage(img, 0, 0);
          cctx.drawImage(
            exprEntry.img,
            exprEntry.x + aDx,
            exprEntry.y + aDy,
            exprEntry.img.naturalWidth * aScale,
            exprEntry.img.naturalHeight * aScale
          );
          texSource = st.compCanvas;
        }
        const uploadTex = (texObj) => {
          gl.bindTexture(gl.TEXTURE_2D, texObj);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texSource);
        };
        const isSameBase = st.texHash === hash && st.texReady;
        const canOutfitFade = !isSameBase && st.texReady && prevAspect > 0 && Math.abs(prevAspect - newAspect) < 0.03;
        if (isSameBase || canOutfitFade) {
          const oldTex = st.tex;
          st.tex = st.texPrev;
          st.texPrev = oldTex;
          uploadTex(st.tex);
          st.fadeMode = isSameBase ? 'expr' : 'outfit';
          st.fadeStartMs = performance.now();
        } else {
          uploadTex(st.tex);
          st.fadeStartMs = 0;
          st.texReady = true;
        }
        st.texHash = hash;
        st.texKey = nextTexKey;
      }
    }
    kickAnimLoop();
  }

  function renderFrame() {
    const st = window.__atsBounce;
    if (!st || !imgEl) {
      window.__atsBounceRaf = 0;
      return;
    }
    const now = performance.now();
    st.impulses = st.impulses.filter((item) => now - item.t0 < 950);
    const hasImpulses = st.impulses.length > 0;
    const idleAmp = window.__atsIdleAmp || 0;
    const activeExpr = getEffectiveExpr();
    const fadeAgeMs = st.fadeStartMs > 0 ? Math.max(0, now - st.fadeStartMs) : 9999;
    const isFading = st.fadeStartMs > 0 && fadeAgeMs < (st.fadeMode === 'expr' ? 350 : 250);
    if (!isFading) st.fadeStartMs = 0;
    const fadeRaw = isFading ? Math.min(1, fadeAgeMs / (st.fadeMode === 'expr' ? 260 : 220)) : 1;
    const fadeT = 1 - Math.pow(1 - fadeRaw, 3);
    const exprPulse = isFading && st.fadeMode === 'expr'
      ? Math.sin((fadeAgeMs / 1000) * 18.0) * Math.exp(-(fadeAgeMs / 1000) * 9.5)
      : 0;

    if (document.hidden || !window.__atsShowPortrait) {
      imgEl.style.visibility = 'visible';
      if (canvasEl) canvasEl.style.display = 'none';
      window.__atsBounceRaf = 0;
      return;
    }

    if (!hasImpulses && !isFading && idleAmp <= 0) {
      if (activeExpr !== 'default' && st.gl && canvasEl && st.texHash === (imgEl.dataset.hash || '')) {
        const gl = st.gl;
        gl.useProgram(st.prog);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, st.tex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, st.texPrev || st.tex);
        gl.uniform1i(st.uTex, 0);
        gl.uniform1i(st.uTexPrev, 1);
        gl.uniform1f(st.uFade, 1.0);
        gl.uniform1f(st.uExprPulse, 0);
        gl.uniform1f(st.uAspect, st.aspect);
        gl.uniform1f(st.uTime, now / 1000);
        gl.uniform1f(st.uIdle, 0);
        gl.uniform1i(st.uCount, 0);
        gl.drawElements(gl.TRIANGLES, st.indexCount, gl.UNSIGNED_SHORT, 0);
        canvasEl.style.display = 'block';
        imgEl.style.visibility = 'hidden';
      } else {
        imgEl.style.visibility = 'visible';
        if (canvasEl) canvasEl.style.display = 'none';
      }
      window.__atsBounceRaf = 0;
      return;
    }

    // 待机呼吸模式节流到 ~30fps 省电；点击弹跳与表情/穿搭过渡保持 60fps 丝滑
    if (!hasImpulses && !isFading && now - st.lastRenderMs < 32) {
      window.__atsBounceRaf = requestAnimationFrame(renderFrame);
      return;
    }
    st.lastRenderMs = now;

    if (st.gl && canvasEl && st.texHash === (imgEl.dataset.hash || '')) {
      const gl = st.gl;
      const flat = new Float32Array(24);
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
      gl.uniform1i(st.uTex, 0);
      gl.uniform1i(st.uTexPrev, 1);
      gl.uniform1f(st.uFade, fadeT);
      gl.uniform1f(st.uExprPulse, exprPulse);
      gl.uniform1f(st.uAspect, st.aspect);
      gl.uniform1f(st.uTime, now / 1000);
      gl.uniform1f(st.uIdle, idleAmp);
      gl.uniform1i(st.uCount, count);
      gl.uniform4fv(st.uImpulses, flat);
      gl.drawElements(gl.TRIANGLES, st.indexCount, gl.UNSIGNED_SHORT, 0);
      canvasEl.style.display = 'block';
      imgEl.style.visibility = 'hidden';
      window.__atsBounceRaf = requestAnimationFrame(renderFrame);
    } else {
      // 纹理未就绪（例如昼夜换装解码中）时确保原生 img 保持可见，避免偶发消失
      imgEl.style.visibility = 'visible';
      if (canvasEl) canvasEl.style.display = 'none';
      window.__atsBounceRaf = 0;
    }
  }

  if (!window.__atsVisHandler) {
    window.__atsVisHandler = () => {
      if (!document.hidden) kickAnimLoop();
    };
    document.addEventListener('visibilitychange', window.__atsVisHandler);
  }

  function isOpaqueAt(ux, uy) {
    const st = window.__atsBounce;
    if (!st?.hitAlpha) return true;
    const cx = Math.min(st.hitW - 1, Math.max(0, Math.floor(ux * st.hitW)));
    const cy = Math.min(st.hitH - 1, Math.max(0, Math.floor(uy * st.hitH)));
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx >= 0 && nx < st.hitW && ny >= 0 && ny < st.hitH) {
          if (st.hitAlpha[ny * st.hitW + nx] > 20) return true;
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
  };

  if (!window.__atsPointerHandler) {
    window.__atsPointerHandler = (e) => {
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
      window.__atsRefreshExpr?.();
      if (!isOpaqueAt(ux, uy)) return;

      const st = window.__atsBounce;
      if (!st) return;

      const isHeadHit = uy >= 0 && uy <= 0.295 && ux >= 0.20 && ux <= 0.72;
      if (canPokeExpr && isHeadHit && window.__atsExprPack?.imgs) {
        const curExpr = window.__atsBaseExpr || 'default';
        const pool = ['default', 'wink', 'smug', 'shy', 'sleepy', 'starry'];
        const candidates = pool.filter((id) => id !== curExpr && (id === 'default' || window.__atsExprPack.imgs[id]));
        if (candidates.length > 0) {
          const picked = candidates[Math.floor(Math.random() * candidates.length)];
          window.__atsBaseExpr = picked;
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
      while (cache.order.length > 6) {
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
    } else {
      const targetHash = payload.imageHash || '';
      window.__atsDesiredHash = targetHash;
      imgEl.style.display = 'block';
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

  // 4. 自动避让检测：支持类名、嵌入标签与纯几何分栏探测
  window.__atsAuxShift = payload.auxShift !== false;
  let lastAuxMode = 'none';
  function updateAvoidance() {
    const bd = document.getElementById(BACKDROP_ID);
    if (!bd) return;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    bd.dataset.narrow = vw < 1040 ? 'true' : 'false';

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

    // 同步对齐顶部对话栏右侧红框区快捷切换开关
    const pill = document.getElementById(PILL_ID);
    if (pill) {
      let bar = null;
      const bars = document.querySelectorAll('#root div, header');
      for (const el of bars) {
        if (el.id === PILL_ID || el.closest('#' + BACKDROP_ID)) continue;
        const r = el.getBoundingClientRect();
        if (r.top >= 20 && r.top <= 72 && r.height >= 28 && r.height <= 54 && r.width >= 360 && el.children.length >= 2) {
          const first = el.firstElementChild;
          const last = el.lastElementChild;
          if (first && last && last !== first && last.querySelector('button, svg')) {
            bar = el;
            break;
          }
        }
      }
      if (bar) {
        const br = bar.getBoundingClientRect();
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

  if (!window.__atsResizeHandler) {
    window.__atsResizeHandler = () => requestAnimationFrame(updateAvoidance);
    window.addEventListener('resize', window.__atsResizeHandler, { passive: true });
  }
  if (!window.__atsResizeObs && typeof ResizeObserver !== 'undefined') {
    window.__atsResizeObs = new ResizeObserver(() => requestAnimationFrame(updateAvoidance));
    const sheetInner = document.querySelector('.agy-sheet > div');
    if (sheetInner) {
      window.__atsResizeObs.observe(sheetInner);
      if (sheetInner.lastElementChild) window.__atsResizeObs.observe(sheetInner.lastElementChild);
    }
  }
  if (!window.__atsObserver) {
    let raf = 0;
    window.__atsObserver = new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        updateAvoidance();
      });
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
  constructor({ assetsDir, getSettings, resolveTheme, onPatch = null, log = () => {} }) {
    this.assetsDir = assetsDir;
    this.getSettings = getSettings;
    this.resolveTheme = resolveTheme;
    this.onPatch = onPatch;
    this.log = log;
    this.profileDir = profileDirectory();
    this.sessions = new Map();
    this.imageCache = new Map();
    this.health = { state: 'waiting', windows: 0, systemDark: false, compat: null };
    this._timer = null;
    this._stopped = false;
    this._syncQueue = Promise.resolve();
  }

  start() {
    this._stopped = false;
    void this.tick();
    this._timer = setInterval(() => void this.tick(), 3000);
  }

  async stop() {
    this._stopped = true;
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
      return { showPortrait: false, hash: '', dataUrl: null, allowExpression: false, exprAnchor: defaultAnchor };
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
      ? { showPortrait: true, ...img, allowExpression: !isCustom, exprAnchor }
      : { showPortrait: false, hash: '', dataUrl: null, allowExpression: false, exprAnchor: defaultAnchor };
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

  async _discoverTargets() {
    const portText = await readFile(join(this.profileDir, 'DevToolsActivePort'), 'utf8');
    const port = Number(portText.split(/\r?\n/)[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid DevToolsActivePort');
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2500) });
    const list = await res.json();
    return list.filter((t) => isAppWindow(t, port));
  }

  _handleSessionEvent(session, { method, params }) {
    if (method === 'Runtime.executionContextDestroyed' && params?.executionContextId === session.contextId) {
      session.contextId = null;
      session.knownImageHashes?.clear();
      session.sentExprHash = null;
    } else if (method === 'Runtime.executionContextsCleared' || (method === 'Page.frameNavigated' && !params?.frame?.parentId)) {
      session.contextId = null;
      session.knownImageHashes?.clear();
      session.sentExprHash = null;
      session.sentBgHash = null;
    } else if (method === 'Runtime.bindingCalled' && params?.name === '__atsBridge') {
      try {
        const msg = JSON.parse(params.payload || '{}');
        if (msg?.action === 'pickCustomBg') {
          void this.onPatch?.({ action: 'pickCustomBg' });
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
    const world = await session.command('Page.createIsolatedWorld', {
      frameId,
      worldName: WORLD_NAME,
      grantUniveralAccess: false,
    });
    session.contextId = world.executionContextId;
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
      const image = settings.enabled ? this._resolveImageAsset(theme, settings) : { showPortrait: false, hash: '', dataUrl: null, allowExpression: false, exprAnchor: { dx: 0, dy: 0, scale: 1 } };
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
            while (session.knownImageHashes.size > 6) {
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
            palette: theme.palette,
            css,
            showPortrait: image.showPortrait,
            auxShift: settings.portrait.auxShift !== false,
            idleMotion: settings.portrait.idleMotion !== false,
            idleMotionAmp: settings.portrait.idleMotionAmp ?? 0.75,
            clickBounce: settings.portrait.clickBounce !== false,
            clickBounceRange: settings.portrait.clickBounceRange ?? 0.45,
            clickExpression: settings.portrait.clickExpression !== false,
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
          let res = await this.evalInSession(session, `${PAGE_CONTROLLER_FN}(${JSON.stringify(makePayload(sendImg, sendExpr, sendBg))})`);
          if (res?.exceptionDetails) {
            this.log(`page eval error: ${res.exceptionDetails.text || res.exceptionDetails.exception?.description || 'unknown'}`);
          }
          let val = res?.result?.value;
          const retryPortrait = !!(val?.needImage && image.showPortrait && image.dataUrl);
          const retryExpr = !!(val?.needExprPack && image.showPortrait && image.allowExpression && exprPack.hash && exprPack.patches);
          const retryBg = !!(val?.needBgImage && bgImg.showCustomBg && bgImg.dataUrl);
          if (retryPortrait || retryExpr || retryBg) {
            if (retryPortrait) session.knownImageHashes.delete(image.hash);
            if (retryExpr) session.sentExprHash = null;
            if (retryBg) session.sentBgHash = null;
            res = await this.evalInSession(session, `${PAGE_CONTROLLER_FN}(${JSON.stringify(makePayload(retryPortrait, retryExpr, retryBg))})`);
            val = res?.result?.value;
            if (val?.ok) {
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
