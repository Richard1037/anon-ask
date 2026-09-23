# 部署工具 · 使用前必须替换的占位符

仓库里所有脚本都用**占位符**代替了真实的服务器 IP、域名、订阅 ID 等个人信息
（因为仓库是公开的）。**直接跑会失败**，先按下面替换。

用编辑器全局搜索替换一遍即可。

---

## 替换清单

| 占位符 | 替换成 | 出现在 |
|---|---|---|
| `203.0.113.10` | 你的服务器公网 IP | `one-click.ps1`（示例注释）、`fix-ip-redirect.sh`、`enable-nginx-proxy.sh` |
| `your-name.duckdns.org` | 你的域名 | `nginx-anon-ask.conf`、`fix-ip-redirect.sh`、`enable-https.sh`（示例注释） |
| `00000000-0000-0000-0000-000000000000` | 你的 Azure 订阅 ID | `self-deallocate.sh`、`azure-deallocate-role.json` |
| `anon-ask-rg` / `anon-ask-vm` | 你的资源组名 / 虚拟机名 | `self-deallocate.sh` |
| `you@example.com` | 你的邮箱（Let's Encrypt 到期提醒用） | `enable-https.sh` |
| `C:\Users\youruser\` | 你的 Windows 用户目录 | `upload.ps1`、`one-click.ps1`（示例注释） |

> 💡 `203.0.113.0/24` 是 RFC 5737 保留给文档用的测试网段，不会和真实地址冲突。

---

## 快速替换（PowerShell）

在项目根目录执行，把 `<...>` 换成你的真实值：

```powershell
$map = @{
  '203.0.113.10'                        = '<你的服务器IP>'
  'your-name.duckdns.org'               = '<你的域名>'
  '00000000-0000-0000-0000-000000000000' = '<你的订阅ID>'
  'anon-ask-rg'                         = '<你的资源组名>'
  'anon-ask-vm'                         = '<你的虚拟机名>'
  'you@example.com'                     = '<你的邮箱>'
  'C:\Users\youruser\'                  = "$env:USERPROFILE\"
}

Get-ChildItem -Recurse -File |
  Where-Object { $_.Extension -in '.sh','.ps1','.conf','.json','.md' -and $_.FullName -notmatch '\\\.git\\' } |
  ForEach-Object {
    $c = [System.IO.File]::ReadAllText($_.FullName, [System.Text.UTF8Encoding]::new($false))
    $o = $c
    foreach ($k in $map.Keys) { $c = $c.Replace($k, $map[$k]) }
    if ($c -ne $o) {
      [System.IO.File]::WriteAllText($_.FullName, $c, [System.Text.UTF8Encoding]::new($false))
      Write-Host "已更新 $($_.Name)"
    }
  }
```

---

## 不需要替换的

`.bat` / `.vbs` 里的路径全部用 `%~dp0` / `$PSScriptRoot` / `BASH_SOURCE` 推导，
**和项目放在哪个目录无关**，跟着走就行。

`deploy/README-DEPLOY.md` 里的 IP、邮箱、域名也都换成了占位符，读的时候心里有数即可。

---

## 关于 `.gitignore`

以下内容**不会**进仓库，克隆后需要自己创建：

| 文件 | 说明 |
|---|---|
| `config.json` | 应用配置。首次启动会自动生成（含随机管理口令，见 `data/admin-password.txt`）。参考 `config.example.json` |
| `ngrok.json` | 只有用 ngrok 隧道时才需要。参考 `ngrok.example.json` |
| `data/` | 数据库。首次启动自动创建 |
| `docs/` | 个人材料 |

**为什么 `config.json` 不入库**：它包含 `sessionSecret`（会话签名密钥，泄露=别人能伪造管理员登录）
和 `ipSalt`，属于必须保密的配置。
