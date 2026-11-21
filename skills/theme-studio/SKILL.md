---
name: theme-studio
description: Control Antigravity Desktop theme customization (day/night auto-schedule, light/dark purple Hagemi themes, right-side portrait opacity/scale/offset, frosted glass effects, custom presets, and opening the Theme Studio control panel). Use when the user asks to switch desktop themes, adjust Hagemi portrait placement or opacity, customize colors/blur/fonts, or open Theme Studio.
---

# Theme Studio 控制技能

通过本技能可以在对话中直接调整 `agy-theme-studio` 的桌面端美化配置（修改后 Sidecar 会在 0.2 秒内热更新桌面端外观）。

## 快捷打开控制面板

当用户希望可视化调色、滑动调节立绘位置或导入/导出主题时，在回复中提供以下 `sidecar://` 链接：

```markdown
[Theme Studio](sidecar://agy-theme-studio/theme_studio/)
```

## 控制脚本

脚本路径：`~/.gemini/config/plugins/agy-theme-studio/skills/theme-studio/scripts/theme_ctl.mjs`（Windows PowerShell 下可用 `$env:USERPROFILE\.gemini\config\plugins\agy-theme-studio\skills\theme-studio\scripts\theme_ctl.mjs`）。

常用命令：

- **查看当前状态与可用预设**：
  `node "$env:USERPROFILE\.gemini\config\plugins\agy-theme-studio\skills\theme-studio\scripts\theme_ctl.mjs" status`
- **切换昼夜模式**：
  - 定时自动：`set-mode auto-schedule --dayStartHour 7 --nightStartHour 19`
  - 跟随系统：`set-mode system`
  - 锁定昼（浅紫）：`set-mode manual-day`
  - 锁定夜（深紫）：`set-mode manual-night`
  - 启用/暂停美化：`enable` / `disable`
- **微调右侧哈基米立绘与表情**：
  `set-portrait --opacity 0.72 --auxAvoidOpacity 0.12 --idleMotion true --idleMotionAmp 0.75 --clickBounce true --clickBounceRange 0.45 --clickExpression true --microMotion true --ambientLight true --aiCompanion true --expression wink --flipX false --scale 1.0 --right 28 --bottom 92 --dayOutfit bunny --nightOutfit bunny`
  （可选穿搭 `day` / `night` / `bunny` / `sailor` 深紫JK水手服 / `office` 淡紫雪纺黑丝御姐 / `street` 暗黑辣妹露脐装 / `sweater` 暖冬修身毛衣裙 / `coat` 冬日炭黑羊绒大衣 / `hoodie` 极客猫耳耳机卫衣 / `cheongsam` 紫蝶新中式改良旗袍 / `maid` 紫黑蕾丝猫娘女仆 / `witch` 星穹占星小魔女 / `jk_mint` 青空薄荷格裙 JK / `violet_halter` 紫韵挂脖包臀裙 / `maid_shorts` 辣妹热裤猫娘女仆 / `jk_crimson` 红领结黑格 JK；可选表情 `default` 元气招牌 / `wink` 俏皮眨眼 / `smug` 得意猫嘴 / `shy` 害羞脸红 / `sleepy` 困倦打盹 / `starry` 星星眼 / `heart` 爱心眼 / `teary` 委屈泪眼 / `pout` 鼓腮傲娇 / `dizzy` 晕乎蚊香眼；`microMotion` 灵动微动态 / `ambientLight` 光影氛围 / `aiCompanion` 对话默契联动；如需关闭立绘：`set-portrait --enabled false`）
- **调整毛玻璃与自定义底层背景**：
  `set-effects --glassOpacity 0.78 --radius 14 --customBgEnabled true --customBgImage "C:\\path\\to\\bg.jpg" --customBgOpacity 0.48 --font "..."`
- **微调指定预设色板（每套预设独立互不影响）**：
  `set-palette hagemi-day --bgPage "#C7BFE8" --accent "#664CE0"`
- **导入自定义预设 JSON / 恢复默认**：
  `import-preset "<path-to-preset.json>"` / `reset`
