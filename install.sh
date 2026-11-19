#!/usr/bin/env bash
# Antigravity Theme Studio 一键安装 / 更新脚本 (macOS / Linux)
set -euo pipefail

PLUGIN_NAME="agy-theme-studio"
REPO_URL="https://github.com/happyday91/agy-theme-studio.git"
TAR_URL="https://github.com/happyday91/agy-theme-studio/archive/refs/heads/main.tar.gz"
PLUGINS_DIR="$HOME/.gemini/config/plugins"
TARGET_DIR="$PLUGINS_DIR/$PLUGIN_NAME"

copy_plugin_files() {
  local src_root="$1"
  local dst_root="$2"
  mkdir -p "$dst_root"
  for item in plugin.json README.md install.ps1 install.sh assets sidecars skills; do
    if [ -e "$src_root/$item" ]; then
      rm -rf "$dst_root/$item"
      cp -R "$src_root/$item" "$dst_root/$item"
    fi
  done
}

mkdir -p "$PLUGINS_DIR"

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/plugin.json" ]; then
  if [ "$SCRIPT_DIR" = "$TARGET_DIR" ]; then
    echo "[agy-theme-studio] 当前已在插件目录中，无需重复复制。"
  else
    echo "[agy-theme-studio] 正在从本地目录安装到: $TARGET_DIR"
    copy_plugin_files "$SCRIPT_DIR" "$TARGET_DIR"
  fi
elif command -v git >/dev/null 2>&1; then
  if [ -d "$TARGET_DIR/.git" ]; then
    echo "[agy-theme-studio] 检测到已安装 Git 仓库，正在拉取最新更新..."
    git -C "$TARGET_DIR" pull --ff-only
  else
    if [ -e "$TARGET_DIR" ]; then
      BACKUP_DIR="${TARGET_DIR}.bak.$(date +%Y%m%d%H%M%S)"
      echo "[agy-theme-studio] 备份原有非 Git 插件目录至: $BACKUP_DIR"
      mv "$TARGET_DIR" "$BACKUP_DIR"
    fi
    echo "[agy-theme-studio] 正在克隆仓库到: $TARGET_DIR"
    git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
  fi
else
  echo "[agy-theme-studio] 未检测到 git，正在通过压缩包方式下载安装..."
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  curl -fsSL "$TAR_URL" -o "$TMP_DIR/repo.tar.gz"
  tar -xzf "$TMP_DIR/repo.tar.gz" -C "$TMP_DIR"
  EXTRACTED="$TMP_DIR/agy-theme-studio-main"
  if [ ! -f "$EXTRACTED/plugin.json" ]; then
    echo "解压后未找到 plugin.json，安装失败。" >&2
    exit 1
  fi
  copy_plugin_files "$EXTRACTED" "$TARGET_DIR"
fi

echo ""
echo "[agy-theme-studio] 安装/更新完成！"
echo "  插件路径: $TARGET_DIR"
echo "  下一步  : 请在 Antigravity 的 Plugins 管理页启用「Antigravity Theme Studio」，或重启客户端即可生效。"
echo "  说明    : 个人设置与色板数据保存在 sidecar_data 目录，更新插件不会丢失配置。"
