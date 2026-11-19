import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as initialSettingsMod from './settings.mjs';
import * as initialPresetsMod from './presets.mjs';
import * as initialInjectorMod from './cdp-injector.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = resolve(HERE, '..', '..', 'assets');
const UI_PATH = join(HERE, 'ui.html');

let settingsMod = initialSettingsMod;
let presetsMod = initialPresetsMod;
let injectorMod = initialInjectorMod;

const dataDir = settingsMod.resolveDataDir();
try {
  mkdirSync(dataDir, { recursive: true });
  process.chdir(dataDir);
} catch {
  // Windows 下尽量释放插件目录占用
}

let store = new settingsMod.SettingsStore(join(dataDir, 'settings.json'));
function createInjector() {
  return new injectorMod.ThemeInjector({
    assetsDir: ASSETS_DIR,
    getSettings: () => store.read(),
    resolveTheme: (settings, opts) => settingsMod.resolveEffectiveTheme(settings, opts),
    onPatch: async (msg) => {
      if (msg?.action === 'pickCustomBg') {
        try {
          const picked = await pickImageWindows();
          if (picked) {
            store.update({ effects: { customBgImage: picked, customBgEnabled: true } });
            await injector.syncAll();
          }
        } catch (err) {
          console.error('[agy-theme-studio] pickCustomBg failed:', err.message);
        }
        return;
      }
      store.update(msg);
      void injector.syncAll();
    },
    log: (msg) => console.log(`[agy-theme-studio] ${msg}`),
  });
}
let injector = createInjector();

function pickSavePathWindows(defaultName) {
  return new Promise((resolvePath, reject) => {
    if (process.platform !== 'win32') {
      resolvePath(null);
      return;
    }
    const safeName = String(defaultName || 'preset.json').replace(/[^a-zA-Z0-9._-]/g, '_');
    const desktopDir = join(homedir(), 'Desktop').replace(/'/g, "''");
    const ps = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$form = New-Object System.Windows.Forms.Form',
      '$form.TopMost = $true',
      '$dlg = New-Object System.Windows.Forms.SaveFileDialog',
      "$dlg.Filter = 'JSON 主题预设 (*.json)|*.json|所有文件 (*.*)|*.*'",
      `$dlg.FileName = '${safeName}'`,
      `$dlg.InitialDirectory = '${desktopDir}'`,
      "$dlg.Title = '选择导出主题预设的位置'",
      'if ($dlg.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.FileName }',
      '$form.Dispose()',
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolvePath(stdout.trim() || null);
    });
  });
}

let imageDialogOpen = false;
function pickImageWindows() {
  if (imageDialogOpen) return Promise.resolve(null);
  imageDialogOpen = true;
  return new Promise((resolvePath, reject) => {
    if (process.platform !== 'win32') {
      imageDialogOpen = false;
      resolvePath(null);
      return;
    }
    const picDir = join(homedir(), 'Pictures').replace(/'/g, "''");
    const ps = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$form = New-Object System.Windows.Forms.Form',
      '$form.TopMost = $true',
      '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
      "$dlg.Filter = '图片文件 (*.png;*.jpg;*.jpeg;*.webp;*.bmp)|*.png;*.jpg;*.jpeg;*.webp;*.bmp|所有文件 (*.*)|*.*'",
      `$dlg.InitialDirectory = '${picDir}'`,
      "$dlg.Title = '选择自定义全局背景图片'",
      'if ($dlg.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.FileName }',
      '$form.Dispose()',
    ].join('; ');
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      imageDialogOpen = false;
      if (err) reject(err);
      else resolvePath(stdout.trim() || null);
    });
  });
}

function buildStatePayload() {
  const settings = store.read();
  return {
    settings,
    effective: settingsMod.resolveEffectiveTheme(settings, { systemDark: injector.health.systemDark }),
    presets: store.allPresets(settings),
    portraits: presetsMod.BUILTIN_PORTRAITS,
    expressions: presetsMod.BUILTIN_EXPRESSIONS,
    health: injector.health,
  };
}

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const { SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();
  app.page('/', () => readFileSync(UI_PATH, 'utf8'));
  app.api('/api/state', () => buildStatePayload(), 'GET');
  app.api(
    '/api/settings',
    async (data) => {
      store.update(data || {});
      await injector.syncAll();
      return buildStatePayload();
    },
    'POST'
  );
  app.api(
    '/api/reset',
    async () => {
      store.reset();
      await injector.syncAll();
      return buildStatePayload();
    },
    'POST'
  );
  app.api(
    '/api/export-preset',
    async (data) => {
      const preset = data?.preset;
      if (!preset?.id || !preset?.palette) return { ok: false, error: '无效预设数据' };
      const targetPath = data?.filePath ? String(data.filePath) : await pickSavePathWindows(`${preset.id}.json`);
      if (!targetPath) return { ok: true, canceled: true };
      writeFileSync(targetPath, JSON.stringify(preset, null, 2), 'utf8');
      return { ok: true, path: targetPath };
    },
    'POST'
  );
  app.api(
    '/api/pick-bg',
    async () => {
      const picked = await pickImageWindows();
      if (!picked) return { ...buildStatePayload(), canceled: true };
      store.update({ effects: { customBgImage: picked, customBgEnabled: true } });
      await injector.syncAll();
      return buildStatePayload();
    },
    'POST'
  );
  app.run();
}

injector.start();

// 监听 .mjs 源码变更，进程内热重载模块（不退出进程，避免触发宿主重启保护）
let modReloadTimer = null;
let modReloading = false;
async function hotReloadModules() {
  if (modReloading || stopping) return;
  modReloading = true;
  try {
    const ver = Date.now();
    const [nextPresets, nextSettings, nextInjector] = await Promise.all([
      import(`./presets.mjs?v=${ver}`),
      import(`./settings.mjs?v=${ver}`),
      import(`./cdp-injector.mjs?v=${ver}`),
    ]);
    await injector.stop();
    presetsMod = nextPresets;
    settingsMod = nextSettings;
    injectorMod = nextInjector;
    store = new settingsMod.SettingsStore(join(dataDir, 'settings.json'));
    injector = createInjector();
    injector.start();
    console.log('[agy-theme-studio] hot-reloaded modules in-process');
  } catch (err) {
    console.error('[agy-theme-studio] hot-reload failed:', err.message);
  } finally {
    modReloading = false;
  }
}

// 监听 settings.json 变更（支持 Skill CLI 直接修改后秒级热生效）
let watchTimer = null;
try {
  watch(dirname(store.filePath), (_eventType, filename) => {
    if (filename && filename !== 'settings.json') return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      void injector.syncAll();
    }, 120);
  });
} catch {
  // 已有 3s 定时轮询兜底
}

// 监听立绘资源与脚本变更，均在进程内零重启热同步
const modMtimes = new Map();
try {
  watch(HERE, (_ev, fn) => {
    if (!fn || !/^(presets|settings|cdp-injector)\.mjs$/.test(fn)) return;
    try {
      const mt = statSync(join(HERE, fn)).mtimeMs;
      if (modMtimes.get(fn) === mt) return;
      modMtimes.set(fn, mt);
    } catch {
      return;
    }
    clearTimeout(modReloadTimer);
    modReloadTimer = setTimeout(() => void hotReloadModules(), 350);
  });
  watch(ASSETS_DIR, () => {
    injector.imageCache.clear();
    void injector.syncAll();
  });
} catch {
  // ignore
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(watchTimer);
  clearTimeout(modReloadTimer);
  const timer = setTimeout(() => process.exit(0), 2000);
  timer.unref();
  try {
    await injector.stop();
  } finally {
    process.exit(0);
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => void shutdown());
}
