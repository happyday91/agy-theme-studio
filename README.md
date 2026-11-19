<div align="center">
  <img src="assets/logo.svg" alt="Antigravity Theme Studio" width="72" />
  <h1>Antigravity Theme Studio</h1>
  <p>专为 <strong>Antigravity Desktop</strong> 打造的二次元紫韵主题美化与动态立绘插件</p>
</div>

## 效果展示

> 目前仓库先展示内置的 3 套立绘效果，桌面端实机全屏截图可后续补充到 `assets/`。

### 核心视觉体验

- **昼 / 夜双形态紫韵主题**：默认 `07:00–19:00` 为柔雾浅紫昼版，`19:00–07:00` 自动切换柔和暮紫夜版；内置 4 套主题预设，支持跟随系统、手动锁定或一键还原原版界面。
- **全窗自定义背景**：一键选取本地壁纸作为整窗画布背景，支持 `10%–100%` 透显度调节，搭配毛玻璃底部输入栏与圆角卡片，文字清晰且不喧宾夺主。
- **动态交互立绘**：右侧立绘支持待机微呼吸、发梢柔风微摆、点击部位局部弹跳与水平镜像翻转（完全不遮挡界面操作）；展开右侧面板时会自动平滑左移避让。

### 内置 3 套立绘穿搭（昼 / 夜可自由混搭）

| 昼版 · 清新日常 | 夜版 · 暮紫慵懒 | 昼夜通用 · 白色花边兔女郎 |
| :---: | :---: | :---: |
| <img src="assets/hagemi_day.png" alt="哈基米昼版立绘" width="220" /> | <img src="assets/hagemi_night.png" alt="哈基米夜版立绘" width="220" /> | <img src="assets/hagemi_bunny.png" alt="白色花边兔女郎立绘" width="220" /> |

---

## 安装方式

1. 下载或克隆本仓库到 Antigravity 插件目录：
   - **Windows**：`%USERPROFILE%\.gemini\config\plugins\agy-theme-studio\`
   - **macOS / Linux**：`~/.gemini/config/plugins/agy-theme-studio/`
   ```bash
   git clone https://github.com/happyday91/agy-theme-studio.git
   ```
2. 在 Antigravity Desktop 的 **Plugins / Customizations** 管理页启用 **Antigravity Theme Studio**（或重启客户端即可生效）。

---

## 使用方式

### 1. 可视化控制面板
在对话中打开 `[Theme Studio](sidecar://agy-theme-studio/theme_studio/)`（或在插件管理中打开面板），即可实时调节：
- 昼夜切换模式（定时 / 跟随系统 / 锁定昼夜 / 暂停还原）
- 4 套预设切换与色板自定义、圆角大小与字体
- 左右立绘穿搭选择、透明度、水平镜像、呼吸/弹跳幅度与自动避让

### 2. 顶部快捷自定义背景
- 点击对话窗口顶部右侧的 **「🖼 自定义背景」** 即可快速开启/更换本地背景图（推荐 `16:9` 或 `16:10` 横屏图），并在面板或快捷入口调节背景透显度。

### 3. 对话指令控制
也可以直接用自然语言让 Antigravity 帮你调整主题，例如：
- “切换为夜形态主题”
- “把昼版立绘换成兔女郎，透明度调到 0.7”
- “开启自定义背景并把圆角调大一点”
- “暂时还原成原版界面”
