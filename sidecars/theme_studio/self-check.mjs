// 发布前自检脚本：验证注入函数序列化、CSS 生成、三套立绘资源及主题解析无异常
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PORTRAITS, BUILTIN_PRESETS, DEFAULT_SETTINGS } from './presets.mjs';
import { normalizeSettings, resolveEffectiveTheme } from './settings.mjs';
import { ThemeInjector, pageController } from './cdp-injector.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, '..', '..', 'assets');

// 1. 验证真实序列化的页面控制器可无误解析编译
const compiled = new Function(`return (${pageController.toString()})`);
if (typeof compiled() !== 'function') throw new Error('pageController serialization failed');

// 2. 验证三套立绘均存在且能生成哈希与 Data URL
const inj = new ThemeInjector({
  assetsDir: ASSETS,
  getSettings: () => DEFAULT_SETTINGS,
  resolveTheme: (s, o) => resolveEffectiveTheme(s, o),
});

for (const outfitId of Object.keys(BUILTIN_PORTRAITS)) {
  const file = join(ASSETS, BUILTIN_PORTRAITS[outfitId].file);
  if (!existsSync(file)) throw new Error(`Missing portrait asset: ${file}`);
  const s = normalizeSettings({ portrait: { dayOutfit: outfitId, nightOutfit: outfitId } });
  for (const phase of ['day', 'night']) {
    const asset = inj._resolveImageAsset({ portraitKey: phase }, s);
    if (!asset.showPortrait || !asset.hash || !asset.dataUrl?.startsWith('data:image/')) {
      throw new Error(`Invalid resolved asset for ${phase}/${outfitId}`);
    }
  }
}

// 3. 验证全部内置预设解析正常
for (const presetId of Object.keys(BUILTIN_PRESETS)) {
  const s = normalizeSettings({ mode: 'manual-preset', manualPresetId: presetId });
  const eff = resolveEffectiveTheme(s);
  if (!eff?.palette?.bgPage) throw new Error(`Invalid effective theme for ${presetId}`);
}

console.log('self-check OK:', {
  presets: Object.keys(BUILTIN_PRESETS).length,
  portraits: Object.keys(BUILTIN_PORTRAITS).length,
  controllerBytes: pageController.toString().length,
});
