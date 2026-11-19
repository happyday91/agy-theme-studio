# Antigravity Theme Studio (`agy-theme-studio`)

专为 **Antigravity Desktop（Antigravity 2.0）** 打造的二次元紫韵桌面端主题美化与交互立绘插件。采用**非破坏性 CDP 孤立世界 DOM/CSS 注入 + Sidecar 可视化控制面板 + Agent Skill** 架构，不修改 Antigravity 安装目录文件，支持自适应昼夜双形态切换、WebGL 软体动态立绘、全局自定义画布背景图及多预设独立微调。

## 核心特性

- **昼 / 夜双形态与多预设系统**
  - 默认 `07:00–19:00` 使用 **哈基米 · 昼（`#C7BFE8` 明朗紫韵）**，`19:00–07:00` 使用 **哈基米 · 夜（`#3E3158` 柔和暮紫）**，内置 4 套主题预设，支持按每套预设独立保存色板微调互不串色。
  - 支持 **定时自动**、**跟随系统明暗**、**锁定昼版**、**锁定夜版** 与 **一键暂停还原原版**。
- **WebGL 动态交互立绘（3 套内置穿搭）**
  - 内置昼版（纯白吊带 + 浅蓝牛仔热裤 + 白丝）、夜版（暮紫丝质吊带裙 + 针织开衫）与 **白色花边兔女郎（昼夜通用）** 三套透明抠图立绘，昼夜形态可各自自由搭配。
  - **待机微呼吸 + 柔风发梢/猫尾微摆**：GPU 顶点网格驱动（锁定面部不形变），支持 `50%–200%` 幅度调节，后台标签页自动休眠零耗能。
  - **点击部位局部弹跳 + 水平镜像翻转**：基于透明通道命中图精确过滤背景，点击立绘任意部位触发局部果冻弹跳，完全不阻挡界面点击与文字选中；展开右侧面板或窗口变窄时自动 GPU 平滑左移并淡出避让。
- **全画布自定义背景图 & 界面质感**
  - 顶部对话栏右侧内嵌 **「🖼 自定义背景」** 快捷开关，一键选取本地图片直接替代整窗画布背景并支持透明度调节（`10%–100%`）。
  - 覆盖画布渐变、侧边栏、消息气泡、毛玻璃底部输入栏、代码块配色与高亮、圆角（`4–36px`）、字体与紫韵细滚动条，支持 JSON 预设导入与自定义保存路径导出。
- **版本更新自适应**
  - 多特征启发式主窗口探测、几何/语义容器自动打标与未知 CSS 变量嗅探，降低 Antigravity 版本升级带来的适配失效风险。

## 安装方式

1. 将本仓库整个 `agy-theme-studio` 文件夹放到 Antigravity 插件目录：
   - Windows: `%USERPROFILE%\.gemini\config\plugins\agy-theme-studio\`
   - macOS / Linux: `~/.gemini/config/plugins/agy-theme-studio/`
2. 在 Antigravity 的 Plugins / Customizations 管理页启用 **Antigravity Theme Studio**（或重启 Antigravity Desktop）。

## 使用方式

- **可视化控制面板**：在对话中打开 `[Theme Studio](sidecar://agy-theme-studio/theme_studio/)`，可在整页铺满的单页仪表盘中实时调节昼夜模式、立绘动作与穿搭、边距、色板与自定义背景。
- **对话指令（Skill）**：支持直接用自然语言让 Agent 调用 `skills/theme-studio/scripts/theme_ctl.mjs` 调整配置，例如：
  - “切换为夜形态（柔和暮紫慵懒主题）”
  - “把昼版立绘切换成兔女郎，呼吸微摆幅度调到 120%”
  - “把右侧立绘透明度调到 0.65”

## 目录结构

```text
agy-theme-studio/
├── plugin.json
├── README.md
├── assets/
│   ├── logo.svg
│   ├── hagemi_day.png
│   ├── hagemi_night.png
│   └── hagemi_bunny.png
├── sidecars/theme_studio/
│   ├── sidecar.json
│   ├── main.mjs             # Sidecar HTTP 服务、文件选图/导出对话框与进程内热重载
│   ├── cdp-injector.mjs     # CDP 孤立世界注入、WebGL 软体物理、自定义背景与版本自适应
│   ├── presets.mjs          # 内置 4 套主题预设、3 套立绘定义与默认配置
│   ├── settings.mjs         # 配置归一化、按 presetId 独立覆盖与定时解析
│   ├── ui.html              # 100vh 自适应单页控制面板
│   └── self-check.mjs       # 序列化、预设与资源完整性自检脚本
└── skills/theme-studio/
    ├── SKILL.md
    └── scripts/theme_ctl.mjs
```

## 本地自检

```bash
node sidecars/theme_studio/self-check.mjs
```
