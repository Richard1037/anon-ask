# 搬到免费云服务器 · 操作指南

目标：把提问箱搬到一台 **7×24 开着**的服务器上，**你的笔记本从此可以随便关机**。

全程约 40 分钟，其中大部分是等注册审核。**不需要信用卡。**

---

## 一、选哪个方案（含国内学生的坑）

> 学生优惠条款每年都变，**以注册时官网显示的为准**。下面是调研到的实际情况。

### ⚠️ 先说两个最关键的坑

**坑 1：Azure 要求学校邮箱域名在微软白名单里**

微软官方支持人员的原话：

> Microsoft's academic verification system **does not currently recognize your institution's
> email domain**... If your school doesn't have a contract with Microsoft for Azure for Students,
> to have your college's email domain recognized, **the college administration or IT department
> will need to take action.**

也就是说 —— **光有学校邮箱不够**，还要看学校有没有和微软签约。
不在名单里的话，个人无法解决，得学校 IT 部门出面。

**好消息**：国内不少高校学生实测能通过。你们学校在不在名单里，**注册时试一下就知道，5 分钟的事**，
不用提前纠结。

**坑 2：很多免费云要信用卡做身份验证**

| 服务 | 要不要信用卡 |
|---|---|
| **Azure for Students** | **不要** ✅（官方明确写着） |
| Oracle Cloud 永久免费 | 要 ❌ |
| DigitalOcean（GitHub 学生包 $200） | 实测仍要求绑定支付方式 ❌ |
| 腾讯云 / 阿里云 学生机 | 要支付宝/微信，约 ¥99/年（不是免费但很便宜） |

**所以如果你没有信用卡，真正的候选只有两个：Azure 学生版，或者腾讯云/阿里云学生机。**

### 推荐顺序

| 优先级 | 方案 | 成本 | 说明 |
|---|---|---|---|
| 1️⃣ 先试 | **Azure for Students** | 免费 | 不要信用卡，$100/年可续。域名不认就换下一个 |
| 2️⃣ 兜底 | **腾讯云/阿里云 学生机** | 约 ¥99/年 | 学信网认证，支付宝付款。最稳，几乎不会失败 |
| 3️⃣ 顺手 | **GitHub 学生包** | 免费 | 和上面并行做。能拿 **免费 `.me` 域名** + 一堆开发工具 |
| 4️⃣ 备选 | Oracle Cloud 永久免费 | 免费 | 4核24G 永久，但要信用卡验证，国内成功率一般 |

**建议：1 和 3 同时开始**（都是免费且要等审核）。1 失败了就走 2 —— **¥99 换一年省心，
比继续折腾划算得多**。

> 💡 无论最后用哪家，**我准备的 `deploy.sh` 是通用的**：只要是 Ubuntu/Debian、
> 能 SSH 登录、有 root 权限，就能一键部署。腾讯云、阿里云、DigitalOcean、Oracle 全都一样用。

---

## 二、先做这一步：5 分钟验证 Azure 有没有戏

不用先读完所有步骤，先花 5 分钟试探：

1. 打开 <https://azure.microsoft.com/en-us/free/students>，点 **Start free**
2. 用学校邮箱（`your-id@your-school.edu`）注册
3. 走到「学生身份验证」那一步，看它认不认这个域名

**三种结果：**

| 结果 | 说明 | 下一步 |
|---|---|---|
| 直接通过 | 学校在微软的名单里，运气好 | 继续第三节建虚拟机 |
| 要你上传学生证/在读证明 | 也正常，按提示上传（学生证照片或学信网截图） | 等审核，通常 1–3 天 |
| 提示域名不被认可 | 就是上面那个坑 | 直接跳到 **§ 十 腾讯云/阿里云学生机** |

同时可以并行去申请 [GitHub 学生包](https://education.github.com/pack) ——
它不影响 Azure，而且免费域名挺香。

---

## 三、创建服务器（Azure）

在 Azure 门户里：**创建资源 → 虚拟机**

| 项目 | 选什么 | 说明 |
|---|---|---|
| **映像** | Ubuntu Server 24.04 LTS | 别选 Windows，贵且没必要 |
| **大小** | `Standard_B1s`（1核1G） | 这个项目零依赖，1G 内存绰绰有余 |
| **区域** | Japan East 或 East Asia（香港） | 国内访问较快 |
| **身份验证** | SSH 公钥（推荐）或密码 | 密码简单些，公钥更安全 |
| **入站端口** | 放行 **22** 和 **8080** | 22 是 SSH，8080 是网站 |
| **公共 IP** | 新建，标准 SKU | 记下这个 IP |

创建完成后，在「概述」页能看到**公共 IP 地址**。

### ⚠️ 最容易踩的坑：安全组

Azure 默认只放行 22。你要在 **网络 → 网络安全组 → 入站安全规则** 里
**新增一条放行 8080 端口**的规则。

这个必须在控制台网页里改，部署脚本改不了。**80% 的「部署成功但打不开」都是这个原因。**

---

## 四、上传并部署

### 在 Windows 上（你的电脑）

打开 PowerShell，进入项目目录：

```powershell
cd D:\\AI\ Project\\anon-ask
.\deploy\upload.ps1 -Server azureuser@20.1.2.3
```

> 用户名是你在创建虚拟机时填的，IP 换成你自己的。

### 在服务器上

按脚本提示 SSH 登录后执行：

```bash
ssh azureuser@20.1.2.3

mkdir -p ~/anon-ask
tar -xzf /tmp/anon-ask.tar.gz -C ~/anon-ask
cd ~/anon-ask
sudo bash deploy/deploy.sh
```

脚本会自己搞定：装 Node.js → 复制到 `/opt/anon-ask` → 装 systemd 服务（开机自启、
崩溃自动重启）→ 放行防火墙 → 启动 → 打印访问地址。

**看到 `部署完成` 就成了。**

---

## 五、验证

浏览器打开：

```
http://你的服务器IP:8080
```

能打开就成功了。管理后台在后面加 `/admin`，口令还是原来那个。

> 如果本机 `curl http://127.0.0.1:8080/api/meta` 通、但外网打不开 →
> **一定是安全组没放行 8080**，回第三节去加规则。

---

## 六、可选：配个好看的域名

GitHub 学生包里有 **Namecheap 免费 `.me` 域名 1 年**：

1. 在 <https://education.github.com/pack> 里找到 Namecheap 优惠，领兑换码
2. 去 Namecheap 注册域名
3. 加一条 A 记录指向你的服务器 IP
4. 访问 `http://你的域名.me:8080`

> 用**自己的域名**在国内理论上需要备案，但很多同学实测不备案用 IP + 端口也没问题。
> 想彻底规避就选香港/海外节点。

---

## 七、搬完之后

| 事情 | 怎么做 |
|---|---|
| **本地那套** | 双击 `stop.bat` 停掉。**别删** —— 它是备份，也是本地开发环境 |
| **ngrok** | 不需要了。服务器有公网 IP，直连 |
| **防待机 / 自启** | 不需要了，可以把启动文件夹里的 `AnonAsk.vbs` 删掉 |
| **迁移数据** | 先把本地 `data\app.db` 传上去覆盖 `/opt/anon-ask/data/app.db`，再 `sudo systemctl restart anon-ask` |
| **改管理口令** | 编辑 `/opt/anon-ask/config.json`，加一行 `"adminPassword": "新口令"`，然后 `sudo systemctl restart anon-ask` |

### 常用运维命令

```bash
sudo systemctl status  anon-ask     # 看状态
sudo systemctl restart anon-ask     # 重启（改配置后）
sudo systemctl stop    anon-ask     # 停止
journalctl -u anon-ask -f           # 实时日志
```

### 备份数据库

```bash
sudo -u anon-ask node /opt/anon-ask/backup.mjs /root/anonask-$(date +%F).db
```

建议加个定时任务每天自动备份：

```bash
sudo crontab -e
# 加一行：每天凌晨 3 点备份
0 3 * * * cd /opt/anon-ask && sudo -u anon-ask node backup.mjs /root/backups/anonask-$(date +\%F).db
```

---

## 八、费用会不会超

`Standard_B1s` 大约 **$8/月**，Azure for Students 的 $100 额度够用 **12 个月左右**，
而且 Azure 学生版对 B 系列还有额外的免费小时数。

**建议**：在 Azure 里设一个**预算警报**（成本管理 → 预算），比如 $5，
超过就发邮件提醒你，避免意外扣费。

---

## 九、如果搞不定

把报错信息发给我，我帮你看。最常见的三类问题：

| 现象 | 原因 |
|---|---|
| `部署完成` 但外网打不开 | 安全组没放行 8080 |
| `scp` 报 Permission denied | 用户名不对，或安全组没放行 22 |
| 服务起不来 | `journalctl -u anon-ask -n 50` 看日志，多半是端口被占或 Node 版本问题 |

---

## 十、兜底方案：腾讯云 / 阿里云学生机（约 ¥99/年）

如果 Azure 的域名验证过不了，**这是最稳的路**，而且几乎不会失败。

**优点**：学信网认证即可，**支付宝/微信付款，不需要信用卡**，国内节点访问飞快。

### 步骤

1. 完成**学信网**学籍在线验证（<https://www.chsi.com.cn>，几分钟出报告）
2. 打开学生优惠页：
   - 腾讯云：<https://cloud.tencent.com/act/campus>
   - 阿里云：<https://www.aliyun.com/activity/student>
3. 选**轻量应用服务器**，配置 2核2G 就够（本项目极度轻量）
4. **镜像选「Ubuntu 22.04 / 24.04」**，别选「宝塔面板」之类的预装镜像
5. 购买后在控制台：
   - 记下**公网 IP**
   - 设置 **root 密码**（或绑定 SSH 密钥）
   - **在「防火墙 / 安全组」里放行 8080 端口** ← 最容易忘

### 然后就是一样的流程

```powershell
# 你的电脑上
.\deploy\upload.ps1 -Server root@你的公网IP
```
```bash
# 登录服务器后
mkdir -p ~/anon-ask && tar -xzf /tmp/anon-ask.tar.gz -C ~/anon-ask && cd ~/anon-ask && sudo bash deploy/deploy.sh
```

**部署脚本完全通用**，腾讯云/阿里云/DigitalOcean/Oracle 都是同一套流程。

### 成本对比

| 方案 | 一年成本 | 折腾程度 |
|---|---|---|
| Azure 学生版 | ¥0 | 中（可能卡在域名验证） |
| **腾讯云/阿里云学生机** | **约 ¥99** | 低（基本一次成功） |
| 继续用现在的笔记本 + ngrok | ¥0 | 低，但**依赖你电脑开着** |

¥99 换一年不用管电脑状态，我觉得值。如果 Azure 折腾两天还不行，就直接走这条。
