<#
.SYNOPSIS
  Antigravity Theme Studio 一键安装 / 更新脚本 (Windows PowerShell)
  支持远程一行命令执行，也支持下载仓库压缩包后在本地直接运行。
#>
$ErrorActionPreference = 'Stop'

$PluginName = 'agy-theme-studio'
$RepoUrl    = 'https://github.com/happyday91/agy-theme-studio.git'
$ZipUrl     = 'https://github.com/happyday91/agy-theme-studio/archive/refs/heads/main.zip'
$PluginsDir = Join-Path $env:USERPROFILE '.gemini\config\plugins'
$TargetDir  = Join-Path $PluginsDir $PluginName

function Copy-PluginFiles([string]$SourceRoot, [string]$DestRoot) {
  New-Item -ItemType Directory -Force -Path $DestRoot | Out-Null
  foreach ($item in @('plugin.json', 'README.md', 'install.ps1', 'install.sh')) {
    $src = Join-Path $SourceRoot $item
    if (Test-Path $src) {
      Copy-Item -Force $src (Join-Path $DestRoot $item)
    }
  }
  foreach ($dir in @('assets', 'sidecars', 'skills')) {
    $srcDir = Join-Path $SourceRoot $dir
    if (Test-Path $srcDir) {
      $dstDir = Join-Path $DestRoot $dir
      New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
      Copy-Item -Recurse -Force (Join-Path $srcDir '*') $dstDir
    }
  }
}

New-Item -ItemType Directory -Force -Path $PluginsDir | Out-Null

$LocalMode = $PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'plugin.json'))
if ($LocalMode) {
  $resolvedSrc = (Resolve-Path $PSScriptRoot).Path
  $resolvedDst = if (Test-Path $TargetDir) { (Resolve-Path $TargetDir).Path } else { $TargetDir }
  if ($resolvedSrc -eq $resolvedDst) {
    Write-Host "[agy-theme-studio] 当前已在插件目录中，无需重复复制。" -ForegroundColor Green
  } else {
    Write-Host "[agy-theme-studio] 正在从本地目录安装到: $TargetDir" -ForegroundColor Cyan
    Copy-PluginFiles $resolvedSrc $TargetDir
  }
} elseif (Get-Command git -ErrorAction SilentlyContinue) {
  if (Test-Path (Join-Path $TargetDir '.git')) {
    Write-Host "[agy-theme-studio] 检测到已安装 Git 仓库，正在拉取最新更新..." -ForegroundColor Cyan
    git -C $TargetDir pull --ff-only
  } else {
    if (Test-Path $TargetDir) {
      $BackupDir = "$TargetDir.bak.$(Get-Date -Format 'yyyyMMddHHmmss')"
      Write-Host "[agy-theme-studio] 备份原有非 Git 插件目录至: $BackupDir" -ForegroundColor Yellow
      Move-Item -Force $TargetDir $BackupDir
    }
    Write-Host "[agy-theme-studio] 正在克隆仓库到: $TargetDir" -ForegroundColor Cyan
    git clone --depth 1 $RepoUrl $TargetDir
  }
} else {
  Write-Host "[agy-theme-studio] 未检测到 git，正在通过压缩包方式下载安装..." -ForegroundColor Cyan
  $TmpDir  = Join-Path ([System.IO.Path]::GetTempPath()) ("ats_install_" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $ZipFile = Join-Path $TmpDir 'repo.zip'
  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
  try {
    Invoke-WebRequest -Uri $ZipUrl -OutFile $ZipFile -UseBasicParsing
    Expand-Archive -Path $ZipFile -DestinationPath $TmpDir -Force
    $Extracted = Join-Path $TmpDir 'agy-theme-studio-main'
    if (-not (Test-Path (Join-Path $Extracted 'plugin.json'))) {
      throw '解压后未找到 plugin.json，请检查网络连接或仓库地址。'
    }
    Copy-PluginFiles $Extracted $TargetDir
  } finally {
    if (Test-Path $TmpDir) { Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue }
  }
}

Write-Host ""
Write-Host "[agy-theme-studio] 安装/更新完成！" -ForegroundColor Green
Write-Host "  插件路径: $TargetDir"
Write-Host "  下一步  : 请在 Antigravity 的 Plugins 管理页启用「Antigravity Theme Studio」，或重启客户端即可生效。"
Write-Host "  说明    : 个人设置与色板数据保存在 sidecar_data 目录，更新插件不会丢失配置。"
