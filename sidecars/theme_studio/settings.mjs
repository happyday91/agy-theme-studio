import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { BUILTIN_EXPRESSIONS, BUILTIN_PORTRAITS, BUILTIN_PRESETS, DEFAULT_SETTINGS } from './presets.mjs';

export function resolveDataDir() {
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
  const appDataDir = resolve(geminiDir, process.env.ANTIGRAVITY_APP_DATA_DIR || 'antigravity');
  return join(appDataDir, 'sidecar_data', 'agy-theme-studio', 'theme_studio', 'data');
}

function clampNum(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function mergeDeep(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = mergeDeep(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function normalizeSettings(raw) {
  const merged = mergeDeep(structuredClone(DEFAULT_SETTINGS), raw || {});
  merged.enabled = merged.enabled !== false;
  if (!['auto-schedule', 'system', 'manual-day', 'manual-night', 'manual-preset'].includes(merged.mode)) {
    merged.mode = 'auto-schedule';
  }
  merged.dayStartHour = clampNum(merged.dayStartHour, 0, 23, 7);
  merged.nightStartHour = clampNum(merged.nightStartHour, 0, 23, 19);

  merged.portrait.enabled = merged.portrait.enabled !== false;
  merged.portrait.opacity = clampNum(merged.portrait.opacity, 0, 1, 0.78);
  merged.portrait.auxAvoidOpacity = clampNum(merged.portrait.auxAvoidOpacity, 0, 1, 0.25);
  merged.portrait.auxShift = merged.portrait.auxShift !== false;
  merged.portrait.idleMotion = merged.portrait.idleMotion !== false;
  merged.portrait.idleMotionAmp = clampNum(merged.portrait.idleMotionAmp, 0.5, 2.0, 0.75);
  merged.portrait.clickBounce = merged.portrait.clickBounce !== false;
  merged.portrait.clickBounceRange = clampNum(merged.portrait.clickBounceRange, 0.1, 1.5, 0.45);
  merged.portrait.clickExpression = merged.portrait.clickExpression !== false;
  merged.portrait.flipX = merged.portrait.flipX === true;
  merged.portrait.scale = clampNum(merged.portrait.scale, 0.5, 1.6, 1.0);
  merged.portrait.offsetRight = clampNum(merged.portrait.offsetRight, -240, 480, 28);
  merged.portrait.offsetBottom = clampNum(merged.portrait.offsetBottom, -220, 360, 92);
  merged.portrait.featherLeft = clampNum(merged.portrait.featherLeft, 0, 45, 14);
  merged.portrait.featherBottom = clampNum(merged.portrait.featherBottom, 0, 45, 12);
  if (!BUILTIN_PORTRAITS[merged.portrait.dayOutfit]) merged.portrait.dayOutfit = 'day';
  if (!BUILTIN_PORTRAITS[merged.portrait.nightOutfit]) merged.portrait.nightOutfit = 'night';
  if (!BUILTIN_EXPRESSIONS[merged.portrait.expression]) merged.portrait.expression = 'default';

  merged.effects.glassBlur = 13;
  merged.effects.glassOpacity = clampNum(merged.effects.glassOpacity, 0.25, 1, 0.78);
  merged.effects.borderRadius = clampNum(merged.effects.borderRadius, 4, 36, 14);
  merged.effects.customBgEnabled = merged.effects.customBgEnabled === true;
  merged.effects.customBgImage = typeof merged.effects.customBgImage === 'string' ? merged.effects.customBgImage.trim().slice(0, 500) : '';
  merged.effects.customBgOpacity = clampNum(merged.effects.customBgOpacity, 0.1, 1, 0.48);
  merged.effects.fontFamily = typeof merged.effects.fontFamily === 'string' ? merged.effects.fontFamily.trim().slice(0, 180) : '';

  return merged;
}

export class SettingsStore {
  constructor(filePath = join(resolveDataDir(), 'settings.json')) {
    this.filePath = filePath;
    mkdirSync(dirname(this.filePath), { recursive: true });
    this._cache = this._load();
  }

  _load() {
    try {
      if (existsSync(this.filePath)) {
        const text = readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '');
        return normalizeSettings(JSON.parse(text));
      }
    } catch {
      // 损坏时回退默认配置
    }
    const initial = normalizeSettings({});
    this._write(initial);
    return initial;
  }

  _write(data) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const text = JSON.stringify(data, null, 2);
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, text, 'utf8');
    try {
      renameSync(tmp, this.filePath);
    } catch {
      writeFileSync(this.filePath, text, 'utf8');
      try { unlinkSync(tmp); } catch {}
    }
  }

  read() {
    // 热读取以支持外部 Skill 脚本直接更新 settings.json
    return this._load();
  }

  update(patch) {
    const current = this._load();
    const next = normalizeSettings(mergeDeep(current, patch));
    this._cache = next;
    this._write(next);
    return next;
  }

  reset() {
    const next = normalizeSettings({});
    this._cache = next;
    this._write(next);
    return next;
  }

  allPresets(settings = this.read()) {
    return { ...BUILTIN_PRESETS, ...(settings.customPresets || {}) };
  }
}

export function resolveEffectiveTheme(settings, { now = new Date(), systemDark = false } = {}) {
  const presets = { ...BUILTIN_PRESETS, ...(settings.customPresets || {}) };
  let phase = 'day';

  if (settings.mode === 'manual-night') {
    phase = 'night';
  } else if (settings.mode === 'manual-day') {
    phase = 'day';
  } else if (settings.mode === 'system') {
    phase = systemDark ? 'night' : 'day';
  } else if (settings.mode === 'manual-preset') {
    const picked = presets[settings.manualPresetId] || presets['hagemi-day'];
    phase = picked.scheme === 'dark' ? 'night' : 'day';
  } else {
    // auto-schedule
    const h = now.getHours();
    const dayStart = settings.dayStartHour;
    const nightStart = settings.nightStartHour;
    if (dayStart < nightStart) {
      phase = h >= dayStart && h < nightStart ? 'day' : 'night';
    } else {
      phase = h >= nightStart && h < dayStart ? 'night' : 'day';
    }
  }

  const presetId =
    settings.mode === 'manual-preset'
      ? settings.manualPresetId
      : phase === 'night'
        ? settings.nightPresetId
        : settings.dayPresetId;

  const basePreset = presets[presetId] || (phase === 'night' ? BUILTIN_PRESETS['hagemi-night'] : BUILTIN_PRESETS['hagemi-day']);
  const overrides = settings.paletteOverrides?.[basePreset.id] || {};
  const palette = { ...basePreset.palette, ...overrides };

  return {
    phase,
    presetId: basePreset.id,
    presetName: basePreset.name,
    scheme: basePreset.scheme,
    portraitKey: basePreset.portraitKey || phase,
    palette,
  };
}
