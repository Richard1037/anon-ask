/**
 * ngrok 固定域名隧道守护进程。
 *
 *   node ngrok.mjs        （或双击 ngrok.bat）
 *
 * 相比 Cloudflare 免费临时隧道的两个关键优势：
 *
 *   1. **地址固定**。在 ngrok 后台领取一个免费静态域名后，无论断线多少次、
 *      重启多少次，地址永远不变 —— 发给别人的链接不会失效。
 *   2. **可以走代理**。cloudflared 完全无视 HTTP_PROXY/HTTPS_PROXY 环境变量
 *      （实测：代理指向死端口它照样直连成功），只能直连 Cloudflare 边缘，
 *      在国内长连接很容易被掐断。ngrok 尊重这两个变量，因此可以走 Clash 的
 *      IEPL 专线，稳定性完全不同。
 *
 * 另外还做了：进程退出自动重连、每 30 秒主动健康检查、启动时跳过旧日志。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import healthModule from './lib/tunnel-health.js';

const { checkTunnel } = healthModule;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(ROOT, 'bin', 'ngrok.exe');
const CONF = path.join(ROOT, 'ngrok.json');
const LOG = path.join(ROOT, 'logs', 'ngrok.log');
const URL_FILE = path.join(ROOT, 'data', 'public-url.txt');
const PID_FILE = path.join(ROOT, 'data', 'server.pid');
const LOCK_FILE = path.join(ROOT, 'data', 'ngrok.pid');
const CF_LOCK = path.join(ROOT, 'data', 'tunnel.pid');   // Cloudflare 守护进程的锁

fs.mkdirSync(path.dirname(LOG), { recursive: true });
fs.mkdirSync(path.dirname(URL_FILE), { recursive: true });

const HEALTH_INTERVAL = Number(process.env.ANON_ASK_HEALTH_INTERVAL_MS || 30000);
const HEALTH_TOLERANCE = Number(process.env.ANON_ASK_HEALTH_TOLERANCE || 3);

function fail(msg) {
  console.error(`\n  [错误] ${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(BIN)) {
  fail(`找不到 ${BIN}\n  请到 https://ngrok.com/download 下载 Windows 版，解压出 ngrok.exe 放进 bin 文件夹。`);
}
if (!fs.existsSync(CONF)) fail(`找不到配置文件 ${CONF}`);

let conf;
try {
  conf = JSON.parse(fs.readFileSync(CONF, 'utf8'));
} catch (err) {
  fail(`ngrok.json 解析失败：${err.message}`);
}

const TOKEN = String(conf.authtoken || '').trim();
const DOMAIN = String(conf.domain || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
const PROXY = String(conf.proxy || '').trim();
const PORT = Number(conf.port) || 8080;

if (!TOKEN) {
  console.log(`
  ┌──────────────────────────────────────────────────────────────┐
  │  还差一步：需要 ngrok 的 authtoken（免费）                    │
  └──────────────────────────────────────────────────────────────┘

  1. 打开 https://dashboard.ngrok.com/signup 注册（可用 Google/GitHub 登录）
  2. 注册后打开 https://dashboard.ngrok.com/get-started/your-authtoken
     复制那串 authtoken
  3. 打开本目录的 ngrok.json，把 authtoken 填进去：

         "authtoken": "2abc...你复制的那串...",

  4. 再去 https://dashboard.ngrok.com/domains 点 "Create Domain" 领一个
     免费静态域名（形如 xxxx-yyyy.ngrok-free.app），填到 ngrok.json 的 domain：

         "domain": "xxxx-yyyy.ngrok-free.app",

  5. 重新双击 ngrok.bat 即可。

  在这之前，Cloudflare 隧道仍然可用（双击 url.bat 看当前地址）。
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function alreadyRunning() {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (isAlive(pid)) return pid;
  } catch { /* 无锁 */ }
  return null;
}

const runningPid = alreadyRunning();
if (runningPid) {
  console.log(`\n  隧道守护进程已经在运行了（pid ${runningPid}）。`);
  console.log(`  当前公网地址：${fs.existsSync(URL_FILE) ? fs.readFileSync(URL_FILE, 'utf8').trim() : '（还没拿到）'}\n`);
  process.exit(0);
}

// 同一时间只保留一条隧道：把 Cloudflare 那条停掉，避免两个地址互相打架
if (fs.existsSync(CF_LOCK)) {
  try {
    const cfPid = Number(fs.readFileSync(CF_LOCK, 'utf8').trim());
    if (isAlive(cfPid)) {
      console.log(`  检测到 Cloudflare 隧道守护（pid ${cfPid}），先把它停掉…`);
      spawnSync('taskkill', ['/pid', String(cfPid), '/t', '/f'], { stdio: 'ignore' });
    }
  } catch { /* 忽略 */ }
  try { fs.rmSync(CF_LOCK, { force: true }); } catch { /* 忽略 */ }
}
spawnSync('taskkill', ['/im', 'cloudflared.exe', '/f'], { stdio: 'ignore' });

try { fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8'); } catch { /* 忽略 */ }

/* ------------------------------------------------------------------ */

const ARGS = [
  'http', String(PORT),
  '--authtoken', TOKEN,
  '--log', 'stdout',
  '--log-format', 'logfmt',
];
if (DOMAIN) ARGS.push('--domain', DOMAIN);

const CHILD_ENV = { ...process.env };
if (PROXY) {
  // ngrok 尊重这两个变量（cloudflared 不尊重，实测过）
  CHILD_ENV.HTTPS_PROXY = PROXY;
  CHILD_ENV.HTTP_PROXY = PROXY;
  CHILD_ENV.https_proxy = PROXY;
  CHILD_ENV.http_proxy = PROXY;
}

let child = null;
let stopping = false;
let attempt = 0;
let currentUrl = null;
let readOffset = 0;
let watchTimer = null;
let healthTimer = null;
let healthFailures = 0;
let fatal = false;

/** 这些错误重试多少次都没用，必须停下来告诉用户原因。 */
const FATAL_PATTERNS = [
  {
    re: /ERR_NGROK_9009|http\/s proxy is a Pay-as-you-go/i,
    msg: 'ngrok 免费版不允许走 HTTP 代理。请把 ngrok.json 里的 "proxy" 改成空字符串 "" 后重试。\n'
      + '  （隧道健康检查仍然可以用代理，那个由 config.json 的 tunnelProxy 控制，两回事。）',
  },
  {
    re: /ERR_NGROK_105|authentication failed: Your account is limited|invalid authtoken/i,
    msg: 'ngrok.json 里的 authtoken 无效。请到 https://dashboard.ngrok.com/get-started/your-authtoken 重新复制。',
  },
  {
    re: /ERR_NGROK_8012|ERR_NGROK_8013|is not authorized|reserved domain/i,
    msg: '这个域名不属于你的账号，或者还没在后台领取。\n'
      + '  请到 https://dashboard.ngrok.com/domains 点 Create Domain 领一个免费静态域名。',
  },
];

function banner(url) {
  const line = '─'.repeat(64);
  return [
    '',
    line,
    '  公网地址已就绪 —— 把它发给任何人，他们就能打开你的提问箱',
    line,
    '',
    `  普通用户  ${url}`,
    `  管理后台  ${url}/admin`,
    '',
    '  管理口令写在 config.json 里',
    '',
    line,
    DOMAIN
      ? '  ✅ 这是固定域名，断线重连后地址不会变，可以放心分享。'
      : '  ⚠ 当前是随机域名（ngrok.json 里的 domain 为空），重启后会变。',
    `  地址已存到 ${path.relative(ROOT, URL_FILE)}`,
    line,
    '',
  ].join('\n');
}

function onUrl(url) {
  if (url === currentUrl) return;
  currentUrl = url;
  healthFailures = 0;
  try { fs.writeFileSync(URL_FILE, `${url}\n`, 'utf8'); } catch { /* 忽略 */ }
  console.log(banner(url));
}

function restart(reason) {
  if (stopping) return;
  console.log(`\n  [${reason}] 正在重开隧道…`);
  try { child?.kill(); } catch { /* 忽略 */ }
}

function watchLog() {
  watchTimer = setInterval(() => {
    let text;
    try { text = fs.readFileSync(LOG, 'utf8'); } catch { return; }
    if (text.length < readOffset) readOffset = 0;
    const fresh = text.slice(readOffset);
    readOffset = text.length;
    if (!fresh) return;

    for (const line of fresh.split(/\r?\n/)) {
      const m = line.match(/url=(https:\/\/[^\s"]+)/)
        || line.match(/(https:\/\/[a-z0-9-]+\.ngrok-free\.(?:app|dev))/);
      if (m) onUrl(m[1]);

      for (const { re, msg } of FATAL_PATTERNS) {
        if (!fatal && re.test(line)) {
          fatal = true;
          console.error(`\n  ┌─ 无法继续 ─────────────────────────────────────────┐\n`);
          console.error(`  ${msg}\n`);
          console.error(`  原始错误：${line.slice(0, 200)}\n`);
          shutdown();
          return;
        }
      }

      if (line.includes('lvl=eror')) {
        console.log(`  [!] ${line.replace(/^.*?err=/, '').slice(0, 160)}`);
      }
    }
  }, 1000);
}

function startHealthCheck() {
  healthTimer = setInterval(async () => {
    if (stopping || !currentUrl) return;

    // 本机 DNS 解析不了 *.ngrok-free.app，必须两条路都试
    const verdict = await checkTunnel(currentUrl, PROXY);

    if (verdict === 'ok') { attempt = 0; healthFailures = 0; return; }
    if (verdict === 'origin-down') {
      healthFailures = 0;
      console.log('  [!] 隧道正常，但本地网站没有响应 —— 请检查 start.bat 是否还在跑');
      return;
    }

    healthFailures += 1;
    console.log(`  [!] 公网地址第 ${healthFailures}/${HEALTH_TOLERANCE} 次探测不通`);
    if (healthFailures >= HEALTH_TOLERANCE) {
      healthFailures = 0;
      restart('公网地址连续不可达');
    }
  }, HEALTH_INTERVAL);
}

function checkSiteRunning() {
  if (fs.existsSync(PID_FILE)) return;
  console.log('\n  [警告] 没检测到正在运行的网站服务。请先双击 start.bat，否则别人打开会看到错误页。\n');
}

function start() {
  attempt += 1;
  const fd = fs.openSync(LOG, 'a');
  child = spawn(BIN, ARGS, { stdio: ['ignore', fd, fd], windowsHide: true, env: CHILD_ENV });

  child.on('error', (err) => console.error(`\n  [错误] 无法启动 ngrok：${err.message}\n`));

  child.on('exit', (code) => {
    if (stopping || fatal) return;
    const wait = Math.max(5, Math.min(60, 3 * attempt));
    console.log(`\n  隧道断开了（退出码 ${code}），${wait} 秒后自动重连…`);
    console.log(DOMAIN ? '  地址是固定的，不用担心链接失效。\n' : '  重连后会拿到新地址。\n');
    setTimeout(start, wait * 1000);
  });
}

function cleanupLock() {
  try {
    if (fs.readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) {
      fs.rmSync(LOCK_FILE, { force: true });
    }
  } catch { /* 忽略 */ }
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (watchTimer) clearInterval(watchTimer);
  if (healthTimer) clearInterval(healthTimer);
  console.log('\n  正在关闭隧道…');
  try { child?.kill(); } catch { /* 忽略 */ }
  spawnSync('taskkill', ['/im', 'ngrok.exe', '/f'], { stdio: 'ignore' });
  cleanupLock();
  setTimeout(() => process.exit(0), 800);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', cleanupLock);

console.log('\n  正在建立 ngrok 隧道…');
if (PROXY) console.log(`  通过代理连接：${PROXY}`);
if (DOMAIN) console.log(`  目标固定域名：${DOMAIN}`);
checkSiteRunning();

spawnSync('taskkill', ['/im', 'ngrok.exe', '/f'], { stdio: 'ignore' });

// 跳过日志里已有的内容，只认本次运行产生的新地址
try {
  const size = fs.statSync(LOG).size;
  if (size > 5 * 1024 * 1024) { fs.truncateSync(LOG, 0); readOffset = 0; }
  else readOffset = size;
} catch {
  readOffset = 0;
}

start();
watchLog();
startHealthCheck();
