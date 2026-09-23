<#
.SYNOPSIS
  一键部署到云服务器：打包 → 上传 → 远程执行部署脚本。

.EXAMPLE
  cd D:\\AI\ Project\\anon-ask
  .\deploy\one-click.ps1 -Server azureuser@203.0.113.10

.NOTES
  执行过程中会提示输入服务器密码（可能要输两次：一次给 scp，一次给 ssh）。
  如果 sudo 要求密码，也在同一个提示里输入。
#>

param(
  [Parameter(Mandatory = $true, HelpMessage = '格式 user@host，例如 azureuser@203.0.113.10')]
  [string]$Server,

  [string]$Key = ''
)

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '  ╔════════════════════════════════════════════════════════╗'
Write-Host '  ║  匿名提问箱 · 一键部署到云服务器                        ║'
Write-Host '  ╚════════════════════════════════════════════════════════╝'
Write-Host ''
Write-Host "  目标服务器：$Server"
Write-Host ''

# ---- 前置检查 ----
foreach ($cmd in 'tar', 'scp', 'ssh') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "  [错误] 找不到 $cmd 命令。" -ForegroundColor Red
    if ($cmd -ne 'tar') {
      Write-Host '  Windows 10/11 自带 OpenSSH 客户端，可在「设置 → 应用 → 可选功能」里添加。'
    }
    exit 1
  }
}

# ---- 第 1 步：上传 ----
Write-Host '  ── 第 1 步 / 共 2 步：打包并上传 ──────────────────────────' -ForegroundColor Cyan
Write-Host ''

$uploadArgs = @{ Server = $Server }
if ($Key) { $uploadArgs.Key = $Key }
& "$PSScriptRoot\upload.ps1" @uploadArgs

if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '  上传失败，已中止。常见原因：' -ForegroundColor Red
  Write-Host '    · 服务器 IP 写错，或 NSG 没放行 22 端口'
  Write-Host '    · 用户名不对（Azure 默认是你创建时填的用户名）'
  Write-Host '    · 密码输错'
  Write-Host ''
  exit 1
}

# ---- 第 2 步：远程部署 ----
Write-Host ''
Write-Host '  ── 第 2 步 / 共 2 步：在服务器上部署 ──────────────────────' -ForegroundColor Cyan
Write-Host ''
Write-Host '  提示：接下来可能还要输一次服务器密码（sudo 也可能要）。' -ForegroundColor Yellow
Write-Host ''

$remoteCmd = 'mkdir -p ~/anon-ask && ' +
             'tar -xzf /tmp/anon-ask.tar.gz -C ~/anon-ask && ' +
             'cd ~/anon-ask && ' +
             'sudo bash deploy/deploy.sh'

$sshArgs = @()
if ($Key) { $sshArgs += @('-i', $Key) }
# accept-new：首次连接自动接受主机密钥，避免弹 yes/no 卡住脚本
$sshArgs += @('-o', 'StrictHostKeyChecking=accept-new')
$sshArgs += @('-t', $Server, $remoteCmd)   # -t 分配终端，sudo 才能提示输密码

& ssh @sshArgs
$rc = $LASTEXITCODE

Write-Host ''
if ($rc -ne 0) {
  Write-Host "  [失败] 远程部署退出码 $rc" -ForegroundColor Red
  Write-Host ''
  Write-Host '  排查办法：SSH 登录服务器后手动执行，能看到完整报错：' -ForegroundColor Yellow
  Write-Host "      ssh $Server"
  Write-Host '      cd ~/anon-ask && sudo bash deploy/deploy.sh'
  Write-Host ''
  exit $rc
}

Write-Host '  ╔════════════════════════════════════════════════════════╗'
Write-Host '  ║  部署完成！                                            ║'
Write-Host '  ╚════════════════════════════════════════════════════════╝'
Write-Host ''
Write-Host "  浏览器打开：http://$($Server.Split('@')[-1]):8080"
Write-Host "  管理后台  ：http://$($Server.Split('@')[-1]):8080/admin"
Write-Host ''
