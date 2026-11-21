---
trigger: always_on
---

# 本项目更改同步本地插件规范

在本工作区（`agy-theme-studio`）修改源码、资源或技能文件后，在验证通过后直接同步部署到本地 Antigravity 插件目录：

- **Windows**：在仓库根目录运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1`
- **macOS / Linux**：在仓库根目录运行 `bash ./install.sh`

同步目标为本地插件目录（如 `~/.gemini/config/plugins/agy-theme-studio`），不会覆盖 `sidecar_data` 中的用户个人配置。
