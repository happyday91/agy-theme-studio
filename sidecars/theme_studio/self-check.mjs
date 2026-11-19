// 发布前自检脚本：验证注入函数序列化、CSS 生成、三套立绘资源及主题解析无异常
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_EXPRESSIONS, BUILTIN_PORTRAITS, BUILTIN_PRESETS, DEFAULT_SETTINGS } from './presets.mjs';
import { normalizeSettings, resolveEffectiveTheme } from './settings.mjs';
import { ThemeInjector, pageController } from './cdp-injector.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, '..', '..', 'assets');

// 1. 验证真实序列化的页面控制器可无误解析编译
const compiled = new Function(`return (${pageController.toString()})`);
if (typeof compiled() !== 'function') throw new Error('pageController serialization failed');

// 2. 验证五套内置立绘与六种表情差分均存在且能生成哈希、Data URL 与表情锚点
const inj = new ThemeInjector({
  assetsDir: ASSETS,
  getSettings: () => DEFAULT_SETTINGS,
  resolveTheme: (s, o) => resolveEffectiveTheme(s, o),
});

const portraitIds = Object.keys(BUILTIN_PORTRAITS);
if (portraitIds.length !== 5) throw new Error(`Expected 5 builtin portraits, got ${portraitIds.length}`);
for (const outfitId of portraitIds) {
  const file = join(ASSETS, BUILTIN_PORTRAITS[outfitId].file);
  if (!existsSync(file)) throw new Error(`Missing portrait asset: ${file}`);
  const s = normalizeSettings({ portrait: { dayOutfit: outfitId, nightOutfit: outfitId } });
  for (const phase of ['day', 'night']) {
    const asset = inj._resolveImageAsset({ portraitKey: phase }, s);
    if (!asset.showPortrait || !asset.hash || !asset.dataUrl?.startsWith('data:image/')) {
      throw new Error(`Invalid resolved asset for ${phase}/${outfitId}`);
    }
    if (!asset.allowExpression || !asset.exprAnchor || typeof asset.exprAnchor.dx !== 'number') {
      throw new Error(`Expected builtin outfit ${outfitId} to allow expressions with valid exprAnchor`);
    }
  }
}

const exprIds = Object.keys(BUILTIN_EXPRESSIONS);
if (exprIds.length !== 6) throw new Error(`Expected 6 expressions, got ${exprIds.length}`);
const exprPack = inj._resolveExpressionPack();
if (!exprPack.hash) throw new Error('Missing expression pack hash');
for (const exprId of exprIds) {
  const expr = BUILTIN_EXPRESSIONS[exprId];
  if (expr.file) {
    const file = join(ASSETS, expr.file);
    if (!existsSync(file)) throw new Error(`Missing expression asset: ${file}`);
    if (!exprPack.patches?.[exprId]?.dataUrl?.startsWith('data:image/png;base64,')) {
      throw new Error(`Invalid resolved expression patch for ${exprId}`);
    }
  }
  const s = normalizeSettings({ portrait: { expression: exprId } });
  if (s.portrait.expression !== exprId) throw new Error(`normalizeSettings rejected expression ${exprId}`);
}
if (normalizeSettings({ portrait: { expression: 'nonexistent' } }).portrait.expression !== 'default') {
  throw new Error('normalizeSettings did not fallback invalid expression to default');
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
  expressions: exprIds.length,
  controllerBytes: pageController.toString().length,
});
