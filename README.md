# 匿名提问箱

一个可以分享给别人填写的匿名提问网站。别人不需要注册、不需要登录，打开就能提问；
提问默认**只有你能看到**，你回答时再逐条决定是**公开到提问墙**还是**只回答提问者一个人**。

- **零依赖**：只用 Node.js 内置模块，不需要 `npm install`
- **零构建**：原生 HTML / CSS / JS，改完刷新即生效
- **单文件数据库**：`data/app.db`，备份就是复制一个文件

---

## 🚀 参考部署：Azure + nginx + Let's Encrypt

> 📌 这是本项目实际跑通的一套部署方案。**IP / 域名 / 订阅 ID / 邮箱等已全部替换为占位符**
> （`203.0.113.10` 是 RFC 5737 保留的文档用网段）。
> 照着做之前先看 [`deploy/PLACEHOLDERS.md`](deploy/PLACEHOLDERS.md)，里面有需要替换的完整清单。

**目标：让网站完全不依赖本地电脑** —— 笔记本关机、合盖、进包都不影响访问。

| | 示例地址 |
|---|---|
| **普通用户** | `https://your-name.duckdns.org` |
| **管理后台** | `https://your-name.duckdns.org/admin` |
| 备用（裸 IP，无域名时） | `http://203.0.113.10:8080` |

> 🔒 HTTPS 用 Let's Encrypt 免费证书，自动续期。`http://` 会 301 跳转到 `https://`。

### 这套配置的构成

| 项 | 值 |
|---|---|
| 平台 | Azure for Students（$100 额度） |
| 规格 | `Standard_B2ats_v2`（2 vCPU / 1 GiB）—— 本项目运行时内存占用不到 100 MB |
| 区域 | Japan East（**境外服务器不需要 ICP 备案**） |
| 系统 | Ubuntu 24.04 LTS |
| 代码位置 | `/opt/anon-ask` |
| 域名 | DuckDNS 免费子域名，一条 A 记录指向服务器 IP |
| 入口 | **nginx**：80 → 301 → 443；443 → 反向代理到 `127.0.0.1:8080` |
| 证书 | Let's Encrypt ECDSA，`/etc/letsencrypt/live/<你的域名>/` |
| 应用 | **systemd 服务** `anon-ask`（开机自启、崩溃自动重启） |
| 配置 | `/opt/anon-ask/config.json`（**不入库**，见下方说明） |

### 开放的端口（NSG 入站规则）

| 优先级 | 名称 | 端口 | 用途 |
|---|---|---|---|
| 300 | SSH | 22 | 运维 |
| 310 | allow-8080 | 8080 | 直连应用（备用） |
| 320 | allow-80 | 80 | HTTP（跳转到 HTTPS） |
| 330 | allow-443 | 443 | HTTPS |

### ⚠️ 安全要点：nginx 必须清掉伪造的转发头

`deploy/nginx-anon-ask.conf` 里有几行**不能删**：

```nginx
proxy_set_header X-Forwarded-For   $remote_addr;   # 覆盖，不是追加
proxy_set_header CF-Connecting-IP  "";
```

原因：服务端取客户端 IP 时优先信任 `CF-Connecting-IP`。nginx 默认会原样转发客户端
发来的自定义头 —— 不管的话，访问者自己塞一个假 IP 就能**每个请求换一个身份，
限流彻底失效**。用 `$remote_addr` 覆盖（而不是 `$proxy_add_x_forwarded_for` 追加）
才能杜绝伪造。

### ⏰ 到期自动停机（2026-10-23 11:00 北京时间）

**到点虚拟机会把自己停机，计算费用自动停止** —— 不需要你的电脑参与，也不需要额外交钱。

| 项 | 值 |
|---|---|
| 停机时间 | **2026-10-23 03:00 UTC = 北京时间 11:00** |
| 实现方式 | 虚拟机上的 systemd 定时器 + **托管标识**调用 Azure API |
| 权限 | 自定义角色 `VM Self Deallocate`，**只能读信息 + 停机**，范围仅限本机 |
| 补跑 | `Persistent=true` —— 到点时若正好重启，开机后会补跑 |

> ✅ **权限已在配置时就地验证过**（查询范围内的有效权限列表，
> 确认含 `virtualmachines/deallocate/action`），不是"配了就不管"。

**管理命令**（在服务器上执行）：

```bash
sudo bash ~/anon-ask/deploy/setup-auto-stop.sh --status   # 查看
sudo bash ~/anon-ask/deploy/setup-auto-stop.sh 2026-12-01 # 改时间
sudo bash ~/anon-ask/deploy/setup-auto-stop.sh --cancel   # 取消
sudo bash ~/anon-ask/deploy/setup-auto-stop.sh --check    # 重新验证权限
tail -20 /var/log/anon-ask-selfstop.log                   # 停机日志
```

**到期后想重新开机**：

```powershell
az vm start -g anon-ask-rg -n anon-ask-vm
```

**停机后仍计费的部分**：磁盘约 $2-3/月 + 公共 IP 约 $3.6/月 ≈ **$6/月**。
计算部分（约 $9/月）停掉。数据、代码、证书、网址全部保留。

> ⚠️ Azure for Students 有**消费上限**：$100 用完订阅会自动停用，不会扣你的钱。
> 计算下来约 **$15/月**（计算 $9 + 磁盘 $2.5 + 静态 IP $3.6），额度约够 6-7 个月。

### 常用运维命令

```bash
# 用 Azure CLI（本机，不用 SSH）
az vm get-instance-view -g anon-ask-rg -n anon-ask-vm \
  --query "instanceView.statuses[?starts_with(code,'PowerState')].displayStatus" -o tsv

az vm stop  -g anon-ask-rg -n anon-ask-vm    # 停止（省钱）
az vm start -g anon-ask-rg -n anon-ask-vm    # 启动
```

```bash
# 服务器内部
ssh -i C:\Users\youruser\.ssh\anonask_azure azureuser@203.0.113.10

sudo systemctl status  anon-ask     # 应用状态
sudo systemctl restart anon-ask     # 重启应用
sudo systemctl reload  nginx        # 重载 nginx
journalctl -u anon-ask -f           # 实时日志
```

### 改代码后重新部署

```powershell
cd D:\\AI\ Project\\anon-ask
.\deploy\one-click.ps1 -Server azureuser@203.0.113.10 -Key "$env:USERPROFILE\.ssh\anonask_azure"
```

> ⚠️ 本地 `data/` 默认**不会**被上传覆盖，线上下数据是安全的。
> 要同步本地数据库到线上，见 `deploy/README-DEPLOY.md`。

### 本地目录现在的作用

**本地 `D:\\AI\ Project\\anon-ask` 变成了开发/备份环境** —— 可以照常 `start.bat` 起本地站点调试，
但它不再是对外服务的那一份。ngrok、防待机守护、开机自启都已停用移除。

---

## 一、本地启动（开发用）

需要 **Node.js 22 或更高版本**（用到了内置的 `node:sqlite`；开发环境是 v24）。

```bat
:: 双击 start.bat，或者：
node server.js
```

启动后控制台会打印访问地址：

```
  本机访问   http://localhost:8080
  局域网访问 http://192.168.1.23:8080      ← 同一 WiFi 下的人用这个
  管理后台   http://localhost:8080/admin
```

**停止服务**（三选一，推荐第一个）：

- 双击 **`stop.bat`** —— 它按 `data\server.pid` 精确定位进程，即使启动窗口已经关掉也能停
- 在跑着服务的窗口按 `Ctrl+C`
- 用 `start.bat` 启动的，直接关掉那个窗口

重复启动是安全的：端口被占用时会打印一句友好提示然后退出，**不会**影响已经在跑的那个实例。

想让服务在后台跑、不占窗口：

```bat
start /b node server.js > logs\server.out.log 2>&1
```

这样启动同样可以用 `stop.bat` 停止。`logs\` 里会有 `server.out.log` 和 `server.err.log`。

### 管理口令

口令存在 `config.json` 里（**该文件不入库**，见 `.gitignore`），启动时会转成 scrypt 哈希写回，磁盘上不留明文。

**首次启动**：如果 `config.json` 里没有口令，服务会自动生成一个，打印在启动日志里，
同时写入 `data/admin-password.txt`。

**想改口令**：在 `config.json` 里加一行明文口令，重启服务即可 ——
服务会自动把它转成哈希回写，然后把明文那一行删掉。

```jsonc
{
  "adminPassword": "你的新口令",     // 加这一行，启动后会被自动删除并替换为 adminPasswordHash
  "adminPasswordHash": "scrypt$..."  // 服务自动生成，不用管
}
```

启动日志里如果出现 `adminPassword 已转换为 scrypt 哈希并回写`，就说明改成功了。

> ⚠️ **`config.json` 永远不要提交到公开仓库** —— 它包含 `sessionSecret`（会话签名密钥，
> 泄露后别人可以伪造管理员登录）和 `ipSalt`（IP 哈希盐）。仓库里只放
> `config.example.json` 作为字段说明。

> ⚠️ 网站现在通过公网隧道对全世界开放，`/admin` 也是。口令强度直接决定后台安不安全，
> 登录限流是 5 次 / 10 分钟，能挡住暴力破解，但挡不住太简单的口令被猜中。

---

## 二、使用流程

### 提问者

1. 打开首页，写下问题（可选填昵称、话题）
2. 提交后会拿到一条**私密回执链接**，形如 `http://你的地址/my/xxxxxxxx`
3. 凭这条链接可以查看你的回答，也可以**追加补充**

> 回执链接是查看「单独回答」的唯一凭据，站点不做找回。提交成功后浏览器也会在本机
> 留一份记录，访问 `/my` 可以看到自己在这台设备上提过的所有问题。

### 站长（你）

打开 `/admin`，输入口令：

| 操作 | 说明 |
|---|---|
| **待回答** | 默认筛选，所有只有你能看到的新提问 |
| **写回答 + 保存** | 回答内容存下来 |
| **仅提问者可见 / 公开到提问墙** | 回答前先选好，再点保存 |
| **清空回答后保存** | 撤销回答，提问回到「待回答」并且不再公开 |
| **置顶** | 让公开的问答固定在最前面 |
| **隐藏** | 从提问墙撤下，但数据保留、提问者仍能看到回答 |
| **删除** | 彻底删除，不可恢复 |

---

## 三、让别人从公网打开

### 方式 A：同一个局域网（已可用，零成本）

把控制台打印的 `http://10.x.x.x:8080` 发给他们就行。前提是大家在同一个 WiFi / 局域网，
并且 Windows 防火墙允许 Node.js 入站（第一次启动时弹窗选「允许」）。

### 方式 B：Cloudflare Tunnel（已废弃，仅作备选参考）

> ⚠️ **2026-09 已移除**：`bin\cloudflared.exe`（52 MB）和 `tunnel.bat` / `tunnel.mjs` 已删除，
> 因为 ngrok（方式 C）已经能满足需求，而且 Cloudflare 临时隧道在本机所在网络里
> 反复被服务端注销，地址老是变。
>
> **想恢复这条路**：重新下载 cloudflared 放进 `bin\`，再参考下面原来的说明。
> 下载地址：<https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe>
>
> 下文保留作为技术参考（协议选择、Error 1016 的成因等仍然有效）。

cloudflared 已经下载到 `bin\cloudflared.exe`，直接双击 **`tunnel.bat`** 即可。

它会打印一个地址，**发给任何人他们就能打开你的提问箱** —— 不需要和你在同一个 WiFi，
不需要装任何东西。

| 脚本 | 作用 |
|---|---|
| `tunnel.bat` | 开启公网隧道（带守护进程，掉线自动重连） |
| `url.bat` | 打印当前公网地址 |
| `stop.bat` | 停止网站 + 隧道 |

打开后窗口里会显示：

```
  普通用户  https://xxxx-xxxx.trycloudflare.com
  管理后台  https://xxxx-xxxx.trycloudflare.com/admin
```

当前地址同时会写到 `data\public-url.txt`，随时可以用 `url.bat` 查看。

#### 为什么隧道会掉线、以及怎么修的

cloudflared 默认用 **QUIC（UDP）** 连 Cloudflare 边缘。在双栈网络 + 代理软件
（Clash 等）的环境里，UDP/IPv6 这条路经常突然不通，日志里会看到：

```
Failed to dial a quic connection: wsasendto: A socket operation
was attempted to an unreachable network.
Register tunnel error from server side: "Unauthorized: Tunnel not found"
```

隧道一旦被服务端注销，那个域名就**永久失效**了，浏览器上表现为
**Cloudflare Error 1016 / Origin DNS error**，只能重开。

`tunnel.mjs` 针对这点做了三件事：

1. 改用 `--protocol http2`（走 TCP 443）+ `--edge-ip-version 4`，绕开易断的 UDP/IPv6 路径
2. **两种掉线都能恢复**：进程退出会自动重连；而进程活着、隧道却被服务端注销的情况
   （日志里反复出现 `Unauthorized: Tunnel not found`）会被识别出来并强制重开 ——
   光等进程退出是等不到的，这是个很容易漏掉的坑
3. **每 30 秒主动探一次公网地址**，连续 3 次不通就重开，并把新地址写进 `data\public-url.txt`

健康检查会区分两种情况，这点很重要：

| 现象 | 含义 | 处理 |
|---|---|---|
| HTTP 502 / 503 | 隧道是好的，只是本地网站没起来 | **只提示，不重开**（重开只会白白换掉一个还能用的地址） |
| 连接失败 / 530 | 隧道真的断了 | 重开，换新地址 |

脚本启动时会跳过日志里已有的内容，只认本次运行产生的新地址 —— 否则会把上一轮遗留的
旧地址当成当前地址，健康检查必然失败，直接变成无限重启风暴。

> ⚠️ **注意**：trycloudflare 的免费临时地址**每次重连都会变**，这是 Cloudflare 的限制，
> 脚本解决不了。要一个永远不变的地址，见下面的「方式 B+」。

#### 方式 C：ngrok 固定域名（当前使用中）

ngrok 免费版会给账号**自动分配一个永久静态域名**，断线重连、重启多少次都不变 ——
发给别人的链接不会失效。不需要自己去后台领取。

**当前地址：** `https://your-static-domain.ngrok-free.dev`（用 `url.bat` 随时查看）

配置只需在 `ngrok.json` 里填 authtoken（<https://dashboard.ngrok.com/get-started/your-authtoken>），
然后双击 `ngrok.bat`。`domain` 留空即可，ngrok 会用账号的静态域名。

##### 两个必须知道的限制（都实测过）

**① 免费版不允许 agent 走 HTTP 代理** — 报 `ERR_NGROK_9009`：

```
authentication failed: Running the agent with an http/s proxy
is a Pay-as-you-go feature.   ERR_NGROK_9009
```

所以 `ngrok.json` 里的 `proxy` **必须留空**。（隧道健康检查用的代理是另一回事，
由 `config.json` 的 `tunnelProxy` 控制，那个照常可用。）

**② 访客会看到一个 ngrok 提示页** — `ERR_NGROK_6024`：

```
You are about to visit: xxxx.ngrok-free.dev
· This website is served for free through ngrok.com.
· You should only visit this website if you trust whoever sent the link to you.
                        [ Visit Site ]
```

实测这个提示页会拦截**所有浏览器请求**（HTML、`/app.js`、`/style.css`、`/api/*` 全部），
访客必须点一次 "Visit Site" 才能进入。ngrok 官方说明是**每位访客只出现一次**
（点过之后种 cookie，之后正常）。脚本/命令行不受影响。

> 自己测试或做自动化时可带上 `ngrok-skip-browser-warning: 1` 请求头跳过。
> `test/browser-check.mjs` 已经内置了这个头。

##### 想要没有提示页？

那就需要 **自有域名 + Cloudflare 命名隧道**（见方式 D）：没有提示页、没有带宽限制，
而且命名隧道是持久的，不会被服务端注销 —— 连 Error 1016 那个问题也一并根治。
代价是域名约 ¥30–70/年。

#### 方式 D：自有域名 + 命名隧道（最稳，需买域名）

买一个便宜域名（`.top` / `.xyz` 之类约 ¥30–70/年），托管到 Cloudflare（免费），
建一个命名隧道就能得到 `ask.你的域名.com`，没有 ngrok 的提示页和带宽限制。
缺点是要花钱、要配 DNS。

### 让网站尽量不掉线（这台笔记本的限制与对策）

网站跑在这台笔记本上，所以「电脑停了网站就停」。当前已经做了这些：

| 措施 | 状态 | 说明 |
|---|---|---|
| 插电时永不睡眠 | ✅ 已设 | `powercfg /change standby-timeout-ac 0` |
| 防待机守护 | ✅ 已运行 | `keepawake.ps1`，**只在插电时生效**，详见下方安全说明 |
| 开机/登录自启 | ✅ 已配 | 启动文件夹里的 `AnonAsk.vbs` |
| 隧道自愈 | ✅ 已配 | 守护进程含心跳检测与自动重连 |

**这些不需要管理员权限。** 本机的账户是标准用户，所以下面这些做不到：
装成 Windows 服务、建登录计划任务、改被隐藏的电源项。

#### ⚠️ 防待机守护为什么必须「只在插电时生效」

**合盖 + 放进电脑包 = 一台全速运行的电脑塞在保温袋里。**

Modern Standby（S0 低功耗待机）这个机制存在的意义，本来就是让你能安全合盖放进包里：
系统进入低功耗状态，几乎不发热。如果无条件阻止待机，电脑会在密闭无风道的包里
持续工作，热量散不出去 —— 会降频、最终强制关机，**更现实的是热坏电池**
（锂电池高温会加速老化甚至鼓包，而且是静默累积的）。

所以 `keepawake.ps1` 每 15 秒检查一次电源状态：

| 电源状态 | 行为 |
|---|---|
| **插电** | 持有「保持运行」请求 → 网站不会因闲置而断 |
| **拔电** | 立即释放请求 → 系统可正常休眠 → **合盖进包是安全的** |
| 读不到状态 | 保守起见释放请求（宁可网站断，也不要过热） |

**所以进包前只要拔掉电源，合盖就是安全的。** 不放心的话可以双击 `stop.bat`
把网站和隧道也一起停掉。

#### 关于「注销」——用锁屏代替，不要注销

这是最容易踩的坑：

| 操作 | 快捷键 | 结果 |
|---|---|---|
| **锁屏** | `Win + L` | 进程继续运行，**网站不断** ✅ |
| **注销** | 开始菜单 → 注销 | Windows 会终止该用户的所有进程，**网站断** ❌ |

标准账户无法绕过这条规则（要绕过只能装成 Windows 服务，需要管理员）。

**所以：要离开电脑就按 `Win + L` 锁屏，别点注销。**

#### 关于「合盖」——本机的硬限制

这台是 **Modern Standby（S0 低功耗待机）** 机型，合盖会强制进入待机；
而且联想把 `powercfg` 里的「合盖动作」设置项**隐藏了**（`SUB_BUTTONS` 组里只剩
一个「开始菜单电源按钮」），标准账户也没有权限解锁。

可以试的方向，按成本排序：

1. **不合盖就行** —— 屏幕可以设成自动关闭，机器照样跑，这是最省事的办法
2. **Windows 设置 → 系统 → 电源和电池 → 盖子和电源按钮**（Win11 有这个入口，可能能改）
3. **联想电脑管家 / Lenovo Vantage** 里通常有合盖行为设置
4. `keepawake.ps1` 也许能挡住合盖待机（不确定，值得实测一下）

> **建议实测一次**：合上盖子等 1 分钟，然后用手机打开网址看看能不能访问。
> 能访问就说明防待机守护挡住了；不能访问就只能靠上面 1–3。

#### 还是会断的情况

| 情况 | 能否免费解决 |
|---|---|
| 拔掉电源后电池耗尽 | ❌ 换 VPS 才能解决 |
| 关机 | ❌ 换 VPS |
| 合盖待机 | ⚠️ 见上，本机改不了 |
| 注销 | ✅ 改用 `Win + L` 锁屏 |
| Windows 更新自动重启 | ⚠️ 会停在登录界面，**登录后**自启才会跑 |
| 闲置睡眠 | ✅ 防待机守护

**关于 `trustProxy`**：`config.json` 里已设为 `true`，这样限流才按访客的真实 IP 计数。
但要注意它的安全前提 —— 服务端只在**直连方是本机**（也就是隧道）时才采信
`CF-Connecting-IP` / `X-Forwarded-For`。否则局域网里的人只要自己伪造一个
`X-Forwarded-For` 就能每个请求换一个假 IP，把限流完全绕过。这条防护已实测验证。

### 方式 C：长期部署

把整个目录扔到任何支持 Node.js 的机器上（VPS / Railway / Fly.io），
让 `data/` 目录挂持久化卷，然后 `node server.js`。注意平台若提供 `PORT` 环境变量，
需要同步改 `config.json` 的 `port`。

---

## 四、目录结构

```
anon-ask/
├─ server.js              # HTTP 服务 + 路由（唯一的入口）
├─ config.json            # 站点名、端口、口令、限流阈值
├─ start.bat              # Windows 双击启动
├─ stop.bat               # 停止网站 + 所有隧道
├─ tunnel.bat / tunnel.mjs   # Cloudflare 临时隧道（守护进程，地址会变）
├─ ngrok.bat  / ngrok.mjs    # ngrok 固定域名隧道（推荐长期用）
├─ ngrok.json             # ngrok 的 authtoken / 域名 / 代理设置
├─ url.bat                # 打印当前公网地址
├─ backup.mjs             # 在线一致性备份
├─ deploy/
│  ├─ README-DEPLOY.md    # 搬到云服务器的完整指南（含免费学生方案）
│  ├─ upload.ps1          # Windows 上一键打包上传到服务器
│  └─ deploy.sh           # 服务器上一键部署（装 Node + systemd 服务）
├─ bin/
│  ├─ cloudflared.exe     # Cloudflare 隧道客户端（约 52 MB）
│  └─ ngrok.exe           # ngrok 客户端
├─ lib/
│  ├─ config.js           # 配置加载 + 密钥自动生成
│  ├─ db.js               # SQLite 建表与全部查询
│  ├─ auth.js             # scrypt 口令 / HMAC 会话 / IP 哈希
│  ├─ clientip.js         # 客户端 IP 提取与归一化（可单独测试）
│  ├─ tunnel-health.js    # 隧道健康检查（直连 + 走代理双路判定）
│  └─ ratelimit.js        # 进程内滑动窗口限流
├─ public/
│  ├─ index.html          # 提问墙 + 提交表单
│  ├─ admin.html          # 管理后台
│  ├─ mine.html           # 提问者回执页
│  ├─ app.js  admin.js  mine.js
│  ├─ style.css           # 唯一样式表（含深色模式）
│  └─ favicon.svg
├─ data/
│  ├─ app.db              # 数据库（自动生成）
│  ├─ server.pid          # 运行中的进程号，stop.bat 靠它精确停止
│  └─ admin-password.txt  # 仅在自动生成口令时出现
├─ logs/                  # 后台方式启动时的输出日志
└─ test/
   ├─ smoke.mjs           # 接口端到端测试（139 项断言）
   ├─ browser-check.mjs   # 真实浏览器验证（44 项断言）
   └─ demo.mjs            # 演示数据：seed / clear
```

---

## 五、配置项

`config.json`（改完要重启服务）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `siteName` | 匿名提问箱 | 首页大标题 |
| `siteDesc` | — | 首页副标题 |
| `port` | 8080 | 监听端口 |
| `host` | 0.0.0.0 | `0.0.0.0` = 局域网可访问；`127.0.0.1` = 只有本机 |
| `trustProxy` | false | 走隧道 / 反向代理时改 `true`，否则限流失效 |
| `sessionDays` | 7 | 后台登录保持天数 |
| `maxQuestionLength` | 800 | 提问字数上限 |
| `maxAnswerLength` | 4000 | 回答字数上限 |
| `maxFollowupLength` | 500 | 提问者补充字数上限 |
| `rateLimit.submitPerMinute` | 3 | 同一 IP 每分钟最多提交几条 |
| `rateLimit.submitPerDay` | 50 | 同一 IP 每天最多提交几条 |
| `rateLimit.loginPerTenMinutes` | 5 | 后台口令尝试次数 |

`sessionSecret` / `ipSalt` 首次启动自动生成，**不要手动改**（改了所有人会话失效）。

---

## 六、安全设计

| 风险 | 处理方式 |
|---|---|
| XSS | 前端一律用 `textContent` 渲染，不用 `innerHTML`；配严格 CSP（禁 inline script） |
| SQL 注入 | 全部走预处理语句；后台 `filter` 参数走白名单 |
| 越权 | 管理接口逐条校验签名 Cookie；`/api/questions` 的 SQL 只返回已公开且已回答的行 |
| 口令泄露 | scrypt 派生 + 恒定时间比较；登录限流 5 次 / 10 分钟 |
| 会话伪造 | HMAC-SHA256 签名，密钥随机生成；Cookie 带 `HttpOnly` + `SameSite=Strict` |
| CSRF | `SameSite=Strict` + 写操作校验 `Origin` |
| 刷屏 | 滑动窗口限流（分钟 + 天双阈值）+ 隐藏蜜罐字段 |
| 伪造 IP 绕过限流 | 只有直连方是本机（隧道）时才采信 `CF-Connecting-IP` / `X-Forwarded-For`；局域网客户端伪造无效 |
| IPv6 换地址绕过限流 | IPv6 按 `/64` 前缀归一分桶，一个用户就是一个配额（否则等于白送 2^64 份） |
| 请求体攻击 | 请求体硬上限 16 KB，超限返回 413 |
| 路径穿越 | 静态文件路径 `resolve` 后校验必须落在 `public/` 内 |
| 隐私 | **不存明文 IP**，只存加盐 HMAC 前 32 位，仅用于限流 |
| 匿名性 | 不记录提问者身份；提问与账号体系完全无关 |

已知取舍：

- 限流器在内存里，重启会清空；单实例部署够用，多实例需要换成共享存储
- 回执链接一旦泄露，拿到的人就能看到「单独回答」—— 这是匿名提问箱的固有取舍
- 数据库未加密，能读到 `data/app.db` 的人就能看到全部提问

---

## 七、备份与迁移

数据库开了 WAL 模式，所以要**复制整个 `data/` 目录**，不能只拷 `app.db` —— 否则会丢掉
还躺在 `app.db-wal` 里没落盘的最近改动。

想拿一份干净的单文件快照，用自带的备份工具（**服务开着也能跑**）：

```bat
node backup.mjs                  :: 生成 backup\app-<时间戳>.db
node backup.mjs D:\我的备份.db    :: 指定输出位置
```

它走 SQLite 的 `VACUUM INTO`，在同一个读事务里导出，并自动核对条数是否一致。

恢复：

```bat
:: 先停掉服务
copy backup\app-20260922-160432.db data\app.db
:: 顺手删掉可能残留的 WAL 文件，避免和新库对不上
del data\app.db-wal data\app.db-shm
```

迁移到新机器：拷贝整个目录（`config.json` + `data/`），装好 Node 就能跑。
**`config.json` 里的 `sessionSecret` 决定后台登录态，一起拷过去才不会掉登录。**

---

## 八、测试

```bat
:: 接口端到端（会在 test/.tmp 下起一个独立的临时实例，端口 8791，不碰你的数据）
node test\smoke.mjs

:: 真实浏览器验证（需要本机装了 Chrome；会真实登录后台并检查排版）
node test\browser-check.mjs http://127.0.0.1:8080 你的口令

:: 加 SHOTS=目录 可以顺便存截图
set SHOTS=test\.shots
node test\browser-check.mjs
```

`smoke.mjs` 覆盖：静态资源与 CSP、路径穿越、提交校验、XSS 载荷、限流、蜜罐、CSRF、
鉴权与篡改 Cookie、SQL 注入、公开/私密可见性、置顶隐藏删除、越权写入，
以及 IP 解析与 `/64` 归一化的纯单元测试。

`browser-check.mjs` 覆盖：页面无 JS 报错、无横向溢出（430 / 360 / 1180 三种宽度）、
后台真实登录与列表渲染、状态徽章与分段控件同接口数据是否吻合、回执页渲染。
它**不写死任何条数**，可以对着任意一份真实数据跑；等待用的是页面自己打出的
`documentElement.dataset.ready` 标记，因此对高延迟目标（例如公网隧道）同样可靠：

```bat
:: 直接对着公网地址验证
set /p PUB=<data\public-url.txt
node test\browser-check.mjs %PUB% 你的口令
```

### 演示数据

```bat
node test\demo.mjs seed     :: 写入 5 条示例提问（含 3 条公开、1 条单独回答、1 条待回答）
node test\demo.mjs clear    :: 清空所有提问
```

---

## 九、常见问题

**别人打不开局域网地址？**
Windows 防火墙拦了。控制面板 → Windows Defender 防火墙 → 允许应用通过防火墙 → 勾选 Node.js。
另外确认 `config.json` 里 `host` 是 `0.0.0.0` 而不是 `127.0.0.1`。

**想换个端口？**
改 `config.json` 的 `port`，重启。

**提问墙是空的？**
只有「已回答 + 选择了公开」的提问才会出现在墙上。默认全是待回答状态。

**提示「提交太频繁了」？**
同一 IP 每分钟 3 条。改 `rateLimit.submitPerMinute` 调整。

**忘了管理口令？**
删掉 `config.json` 里的 `adminPasswordHash` 那一行，重启，服务会重新生成一个并写入
`data/admin-password.txt`。

**公网地址打不开了 / 变了？**
先双击 `url.bat` 看当前地址（临时地址每次重连都会变）。
如果显示 **Cloudflare Error 1016**，说明隧道被服务端注销了 —— 双击 `tunnel.bat` 重开一个。
如果地址能打开但显示 502，说明隧道活着但网站没跑 —— 先执行 `start.bat`。
想要一个永远不变的地址，见第三节的「方式 C：ngrok 固定域名」。

**⚠️ 本机 DNS 解析不了隧道域名（本机的特殊坑）**

本机的 DNS 是内网地址 `10.0.0.53` / `10.0.0.54`，**解析不了
`*.trycloudflare.com` 和 `*.ngrok-free.app`**（用公共 DNS `1.1.1.1` 却能正常解析，
`ipconfig /flushdns` 也无效）。表现是：

```bat
curl https://xxx.trycloudflare.com/          :: 返回 000，报 No such host is known
curl --proxy http://127.0.0.1:7890 https://xxx.trycloudflare.com/   :: 200，正常
```

**这不影响别人访问**（他们用自己的 DNS），也**不影响你的浏览器**（浏览器走 Clash
代理，DNS 在代理那端解析）。只影响命令行直连测试。

所以 `lib/tunnel-health.js` 的健康检查会**直连和走代理各测一次，任一通即算健康** ——
否则守护进程会把「本地解析失败」误判成「隧道挂了」，不停重开、不停换地址。
`config.json` 里的 `tunnelProxy` 就是给它用的代理地址。

**只想关掉公网、保留局域网访问？**
双击 `stop.bat` 会两个都停。只关隧道的话，在任务管理器里结束 `cloudflared.exe`，
或者把 `tunnel.bat` 那个窗口关掉。

**公网开放后安全吗？**
后台仍然需要口令（scrypt + 登录限流 5 次/10 分钟），提问者依然匿名。
但请注意：`/admin` 现在对全世界可见，口令强度就变得重要了 —— 建议改掉初始口令。
另外临时隧道是 Cloudflare 的免费实验性服务，官方不保证可用性。

**如何彻底重来？**
删掉 `data/` 整个目录，重启。
