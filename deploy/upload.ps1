<#
.SYNOPSIS
  把匿名提问箱打包并上传到服务器。

.EXAMPLE
  .\upload.ps1 -Server azureuser@20.1.2.3
  .\upload.ps1 -Server root@1.2.3.4 -Key C:\Users\youruser\.ssh\id_rsa
  .\upload.ps1 -Server x@y -DryRun     # 只打包，不上传（用来验证打包内容）

.NOTES
  上传完成后，SSH 登录服务器执行：
      cd ~/anon-ask && sudo bash deploy/deploy.sh
#>

param(
  [Parameter(Mandatory = $true, HelpMessage = '格式 user@host，例如 azureuser@20.1.2.3')]
  [string]$Server,

  [string]$Key = '',

  [string]$RemoteDir = 'anon-ask',

  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
$stageDir = Join-Path $env:TEMP ("anonask-upload-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$archive = Join-Path $env:TEMP ("anon-ask-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".tar.gz")

Write-Host ''
Write-Host '  匿名提问箱 · 上传到服务器' -ForegroundColor Cyan
Write-Host '  ------------------------------------------------------'
Write-Host "  项目目录 : $projectDir"
Write-Host "  目标     : ${Server}:~/$RemoteDir"
Write-Host ''

# ---- 检查依赖 ----
foreach ($cmd in 'tar', 'scp') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "  [错误] 找不到 $cmd 命令。" -ForegroundColor Red
    if ($cmd -eq 'scp') {
      Write-Host '  Windows 10/11 自带 OpenSSH 客户端，可在「设置 → 应用 → 可选功能」里安装。'
    }
    exit 1
  }
}

# ---- 暂存一份干净副本（排除数据库和运行时产物）----
Write-Host '  正在打包…' -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $stageDir | Out-Null

$exclude = @('data', 'logs', 'backup', 'bin', '.git', '_tmp', 'docs', '.askpass.cmd', '.tmp-askpass.cmd')
Get-ChildItem -Path $projectDir -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
  Copy-Item $_.FullName -Destination $stageDir -Recurse -Force
}

# 清掉测试产生的临时目录
foreach ($p in 'test\.tmp', 'test\.shots') {
  $full = Join-Path $stageDir $p
  if (Test-Path $full) { Remove-Item $full -Recurse -Force }
}

Push-Location $stageDir
try {
  & tar -czf $archive .
  if ($LASTEXITCODE -ne 0) { throw "tar 打包失败（退出码 $LASTEXITCODE）" }
} finally {
  Pop-Location
}

$sizeMB = [math]::Round((Get-Item $archive).Length / 1MB, 2)
Write-Host "  打包完成：$sizeMB MB" -ForegroundColor Green

# ---- 列出打包内容，便于核对 ----
Write-Host ''
Write-Host '  包内文件（前 20 项）：' -ForegroundColor Cyan
& tar -tzf $archive | Select-Object -First 20 | ForEach-Object { Write-Host "    $_" }
$totalItems = (& tar -tzf $archive | Measure-Object).Count
Write-Host "    … 共 $totalItems 项"
Write-Host ''

if ($DryRun) {
  Write-Host '  [DryRun] 已跳过上传。' -ForegroundColor Yellow
  Write-Host "  压缩包保留在：$archive"
  Write-Host ''
  exit 0
}

# ---- 上传 ----
Write-Host '  正在上传（可能需要输入服务器密码；输密码时屏幕不显示字符是正常的）…' -ForegroundColor Yellow
$scpArgs = @()
if ($Key) { $scpArgs += @('-i', $Key) }
# accept-new：首次连接自动接受主机密钥，不再弹 yes/no 确认（否则脚本会卡住）
$scpArgs += @('-o', 'StrictHostKeyChecking=accept-new')
$scpArgs += @($archive, "${Server}:/tmp/anon-ask.tar.gz")

& scp @scpArgs
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '  [错误] 上传失败。常见原因：' -ForegroundColor Red
  Write-Host '    · 服务器 IP 写错，或安全组没放行 22 端口'
  Write-Host '    · 用户名不对（Azure 默认是创建时填的用户名，AWS 是 ubuntu，腾讯云/阿里云常是 root 或 ubuntu）'
  Write-Host '    · 密钥文件路径不对，或权限过宽（Windows 上一般没问题）'
  Write-Host ''
  Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $archive -Force -ErrorAction SilentlyContinue
  exit 1
}

Remove-Item $stageDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '  ✓ 上传完成' -ForegroundColor Green
Write-Host ''
Write-Host '  接下来 SSH 登录服务器执行这两条命令：' -ForegroundColor Cyan
Write-Host ''
Write-Host "      ssh $Server"
Write-Host "      mkdir -p ~/$RemoteDir && tar -xzf /tmp/anon-ask.tar.gz -C ~/$RemoteDir && cd ~/$RemoteDir && sudo bash deploy/deploy.sh"
Write-Host ''
Write-Host "  （打包文件留在本机：$archive）"
Write-Host ''
