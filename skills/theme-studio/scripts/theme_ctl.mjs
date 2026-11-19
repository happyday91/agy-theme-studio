#!/usr/bin/env node
// Theme Studio CLI 控制脚本：供 Skill 在对话中读写 sidecar_data/agy-theme-studio/theme_studio/data/settings.json
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore, resolveEffectiveTheme } from '../../../sidecars/theme_studio/settings.mjs';

const store = new SettingsStore();
const args = process.argv.slice(2);
const cmd = args[0] || 'status';

function parseFlags(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = list[i + 1] && !list[i + 1].startsWith('--') ? list[++i] : 'true';
    out[key] = val;
  }
  return out;
}

if (cmd === 'status') {
  const settings = store.read();
  const effective = resolveEffectiveTheme(settings);
  console.log(JSON.stringify({ settings, effective, presets: Object.keys(store.allPresets(settings)) }, null, 2));
} else if (cmd === 'enable') {
  console.log(JSON.stringify(store.update({ enabled: true }), null, 2));
} else if (cmd === 'disable') {
  console.log(JSON.stringify(store.update({ enabled: false }), null, 2));
} else if (cmd === 'set-mode') {
  const mode = args[1];
  const flags = parseFlags(args.slice(2));
  const patch = { mode };
  if (flags.dayStartHour !== undefined) patch.dayStartHour = Number(flags.dayStartHour);
  if (flags.nightStartHour !== undefined) patch.nightStartHour = Number(flags.nightStartHour);
  if (flags.dayPresetId) patch.dayPresetId = flags.dayPresetId;
  if (flags.nightPresetId) patch.nightPresetId = flags.nightPresetId;
  if (flags.manualPresetId) patch.manualPresetId = flags.manualPresetId;
  console.log(JSON.stringify(store.update(patch), null, 2));
} else if (cmd === 'set-portrait') {
  const f = parseFlags(args.slice(1));
  const portrait = {};
  if (f.enabled !== undefined) portrait.enabled = f.enabled === 'true';
  if (f.opacity !== undefined) portrait.opacity = Number(f.opacity);
  if (f.auxAvoidOpacity !== undefined) portrait.auxAvoidOpacity = Number(f.auxAvoidOpacity);
  if (f.auxShift !== undefined) portrait.auxShift = f.auxShift === 'true';
  if (f.idleMotion !== undefined) portrait.idleMotion = f.idleMotion === 'true';
  if (f.idleMotionAmp !== undefined) portrait.idleMotionAmp = Number(f.idleMotionAmp);
  if (f.clickBounce !== undefined) portrait.clickBounce = f.clickBounce === 'true';
  if (f.clickBounceRange !== undefined) portrait.clickBounceRange = Number(f.clickBounceRange);
  if (f.clickExpression !== undefined) portrait.clickExpression = f.clickExpression === 'true';
  if (f.flipX !== undefined) portrait.flipX = f.flipX === 'true';
  if (f.scale !== undefined) portrait.scale = Number(f.scale);
  if (f.right !== undefined) portrait.offsetRight = Number(f.right);
  if (f.bottom !== undefined) portrait.offsetBottom = Number(f.bottom);
  if (f.dayOutfit !== undefined) portrait.dayOutfit = f.dayOutfit;
  if (f.nightOutfit !== undefined) portrait.nightOutfit = f.nightOutfit;
  if (f.expression !== undefined) portrait.expression = f.expression;
  if (f.dayImage !== undefined) portrait.customDayImage = f.dayImage;
  if (f.nightImage !== undefined) portrait.customNightImage = f.nightImage;
  console.log(JSON.stringify(store.update({ portrait }), null, 2));
} else if (cmd === 'set-effects') {
  const f = parseFlags(args.slice(1));
  const effects = {};
  if (f.blur !== undefined) effects.glassBlur = Number(f.blur);
  if (f.glassOpacity !== undefined) effects.glassOpacity = Number(f.glassOpacity);
  if (f.radius !== undefined) effects.borderRadius = Number(f.radius);
  if (f.customBgEnabled !== undefined) effects.customBgEnabled = f.customBgEnabled === 'true';
  if (f.customBgImage !== undefined) effects.customBgImage = f.customBgImage;
  if (f.customBgOpacity !== undefined) effects.customBgOpacity = Number(f.customBgOpacity);
  if (f.font !== undefined) effects.fontFamily = f.font;
  console.log(JSON.stringify(store.update({ effects }), null, 2));
} else if (cmd === 'set-palette') {
  const cur = store.read();
  const targetId = args[1] === 'night' ? cur.nightPresetId : args[1] === 'day' ? cur.dayPresetId : (args[1] || cur.dayPresetId);
  const f = parseFlags(args.slice(2));
  console.log(JSON.stringify(store.update({ paletteOverrides: { [targetId]: f } }), null, 2));
} else if (cmd === 'import-preset') {
  const filePath = resolve(args[1]);
  const preset = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!preset?.id || !preset?.palette) throw new Error('Invalid preset JSON');
  console.log(JSON.stringify(store.update({ customPresets: { [preset.id]: preset } }), null, 2));
} else if (cmd === 'reset') {
  console.log(JSON.stringify(store.reset(), null, 2));
} else {
  console.error('Unknown command:', cmd);
  process.exit(1);
}
