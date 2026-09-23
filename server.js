'use strict';

/**
 * 匿名提问箱 · 主服务
 *
 *   - 纯 Node 内置模块，无任何 npm 依赖，无需构建
 *   - 匿名者提交问题 → 默认只有站长可见
 *   - 站长回答时逐条选择「公开」或「仅提问者可见」
 *   - 提问者拿到一条私密回执链接，可查看回答并追加补充
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { load } = require('./lib/config');
const auth = require('./lib/auth');
const clientIpLib = require('./lib/clientip');
const db = require('./lib/db');
const { Limiter, MINUTE, DAY } = require('./lib/ratelimit');

const { cfg, notices, generatedPassword, configPath } = load();

const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE_NAME = 'aq_sid';
const MAX_BODY_BYTES = 16 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PID_FILE = path.join(db.DATA_DIR, 'server.pid');

const submitLimiter = new Limiter();
const loginLimiter = new Limiter();
const followupLimiter = new Limiter();
const readLimiter = new Limiter();

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.publicMessage = message;
  return err;
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function setSecurityHeaders(res) {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
}

function clientIp(req) {
  return clientIpLib.clientIp(req, { trustProxy: cfg.trustProxy });
}

function ipKey(req, scope) {
  const normalized = clientIpLib.normalizeIpForLimit(clientIp(req));
  return `${scope}:${auth.hashIp(normalized, cfg.ipSalt)}`;
}

function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

function isAdmin(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  return auth.verifySession(token, cfg.sessionSecret, cfg.sessionDays * 86400);
}

/** 浏览器同源校验，SameSite=Strict 之外的第二道防线。 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflowed = false;

    req.on('data', (chunk) => {
      // 已超限：继续把剩余数据读掉（不再累积），这样 413 响应才发得出去。
      if (overflowed) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES * 64) req.destroy();
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        chunks.length = 0;
        reject(httpError(413, '请求内容过大'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (overflowed) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(httpError(400, '请求体格式不正确'));
        }
        resolve(parsed);
      } catch {
        reject(httpError(400, '请求体不是合法 JSON'));
      }
    });

    req.on('error', reject);
  });
}

function cleanText(value, maxLength, { required = false, label = '内容' } = {}) {
  if (value === undefined || value === null) {
    if (required) throw httpError(400, `${label}不能为空`);
    return '';
  }
  if (typeof value !== 'string') throw httpError(400, `${label}格式不正确`);

  // 去掉控制字符（保留换行/制表），统一换行，压缩过多空行。
  let text = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();

  if (required && text === '') throw httpError(400, `${label}不能为空`);
  if (text.length > maxLength) throw httpError(400, `${label}最多 ${maxLength} 个字`);
  return text;
}

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

function sendFile(res, relPath, status = 200) {
  const abs = path.resolve(PUBLIC_DIR, relPath);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: '禁止访问' });
  }
  fs.readFile(abs, (err, data) => {
    if (err) return sendJson(res, 404, { error: '页面不存在' });
    res.writeHead(status, {
      'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

async function handleStatic(req, res, pathname) {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    throw httpError(405, '不支持的请求方法');
  }
  if (pathname === '/') return sendFile(res, 'index.html');
  if (pathname === '/admin' || pathname === '/admin/') return sendFile(res, 'admin.html');
  if (pathname === '/my' || pathname === '/my/') return sendFile(res, 'mine.html');
  if (pathname.startsWith('/my/')) {
    const token = pathname.slice('/my/'.length);
    if (!TOKEN_RE.test(token)) return sendFile(res, 'mine.html', 200);
    return sendFile(res, 'mine.html');
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return undefined;
  }
  const rel = pathname.replace(/^\/+/, '');
  if (rel === '' || rel.includes('\0')) return sendJson(res, 404, { error: '页面不存在' });
  return sendFile(res, rel);
}

/* ------------------------------------------------------------------ */
/* 公开 API                                                            */
/* ------------------------------------------------------------------ */

async function handleSubmit(req, res) {
  if (!sameOrigin(req)) throw httpError(403, '来源校验失败');
  const body = await readBody(req);

  // 限流放在校验之前：垃圾请求同样要消耗配额，避免被无效流量刷爆。
  const limit = submitLimiter.hit(ipKey(req, 'submit'), [
    { windowMs: MINUTE, max: cfg.rateLimit.submitPerMinute },
    { windowMs: DAY, max: cfg.rateLimit.submitPerDay },
  ]);
  if (!limit.ok) throw httpError(429, `提交太频繁了，请 ${limit.retryAfter} 秒后再试`);

  // 蜜罐：真实用户看不见这个字段（CSS 隐藏），填了就当作机器人。
  // 返回一个格式合法的假回执，不给爬虫任何"被识别"的信号。
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    const fake = crypto.randomBytes(18).toString('base64url');
    return sendJson(res, 201, {
      ok: true,
      token: fake,
      receiptUrl: `/my/${fake}`,
      message: '已收到，只有站长能看到。请保存好回执链接。',
    });
  }

  const content = cleanText(body.content, cfg.maxQuestionLength, { required: true, label: '问题内容' });
  const nickname = cleanText(body.nickname, cfg.maxNicknameLength, { label: '昵称' });
  const tag = cleanText(body.tag, cfg.maxTagLength, { label: '标签' });

  const ipHash = auth.hashIp(clientIpLib.normalizeIpForLimit(clientIp(req)), cfg.ipSalt);
  const created = db.createQuestion({ content, nickname, tag, ipHash });

  return sendJson(res, 201, {
    ok: true,
    token: created.token,
    receiptUrl: `/my/${created.token}`,
    message: '已收到，只有站长能看到。请保存好回执链接。',
  });
}

async function handlePublicList(req, res, url) {
  const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const data = db.listPublic({ limit, offset });
  return sendJson(res, 200, {
    ok: true,
    ...data,
    hasMore: offset + data.items.length < data.total,
  });
}

async function handleMyQuestion(req, res, token) {
  if (!TOKEN_RE.test(token)) throw httpError(404, '回执链接无效');
  const limit = readLimiter.hit(ipKey(req, 'read'), [{ windowMs: MINUTE, max: 120 }]);
  if (!limit.ok) throw httpError(429, '请求过于频繁，请稍后再试');

  const question = db.getByToken(token);
  if (!question) throw httpError(404, '回执链接无效或提问已被删除');
  return sendJson(res, 200, { ok: true, question });
}

async function handleFollowup(req, res, token) {
  if (!sameOrigin(req)) throw httpError(403, '来源校验失败');
  if (!TOKEN_RE.test(token)) throw httpError(404, '回执链接无效');

  const limit = followupLimiter.hit(ipKey(req, 'followup'), [
    { windowMs: MINUTE, max: cfg.rateLimit.followupPerMinute },
    { windowMs: DAY, max: cfg.rateLimit.followupPerDay },
  ]);
  if (!limit.ok) throw httpError(429, `补充太频繁了，请 ${limit.retryAfter} 秒后再试`);

  const body = await readBody(req);
  const content = cleanText(body.content, cfg.maxFollowupLength, { required: true, label: '补充内容' });

  const result = db.addFollowup(token, content);
  if (result.error === 'not_found') throw httpError(404, '回执链接无效或提问已被删除');
  if (result.error === 'too_many') throw httpError(400, '这条提问的补充次数已达上限');
  return sendJson(res, 200, { ok: true, question: result.question });
}

/* ------------------------------------------------------------------ */
/* 管理 API                                                            */
/* ------------------------------------------------------------------ */

async function handleLogin(req, res) {
  if (!sameOrigin(req)) throw httpError(403, '来源校验失败');

  const limit = loginLimiter.hit(ipKey(req, 'login'), [
    { windowMs: 10 * MINUTE, max: cfg.rateLimit.loginPerTenMinutes },
  ]);
  if (!limit.ok) throw httpError(429, `尝试次数过多，请 ${limit.retryAfter} 秒后再试`);

  const body = await readBody(req);
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length === 0 || password.length > 256) throw httpError(400, '请输入口令');
  if (!auth.verifyPassword(password, cfg.adminPasswordHash)) {
    throw httpError(401, '口令不正确');
  }

  loginLimiter.reset(ipKey(req, 'login'));
  const token = auth.signSession(cfg.sessionSecret, cfg.sessionDays * 86400);
  const maxAge = cfg.sessionDays * 86400;
  return sendJson(res, 200, { ok: true }, {
    'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`,
  });
}

async function handleLogout(req, res) {
  return sendJson(res, 200, { ok: true }, {
    'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  });
}

async function handleAdminList(req, res, url) {
  const filter = url.searchParams.get('filter') || 'all';
  const search = (url.searchParams.get('q') || '').slice(0, 100);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  const data = db.listAdmin({ filter, search, limit, offset });
  return sendJson(res, 200, {
    ok: true,
    ...data,
    stats: db.getStats(),
    hasMore: offset + data.items.length < data.total,
  });
}

async function handleAdminUpdate(req, res, publicId) {
  if (!sameOrigin(req)) throw httpError(403, '来源校验失败');
  const body = await readBody(req);

  const current = db.getRawByPublicId(publicId);
  if (!current) throw httpError(404, '提问不存在');

  let item = null;

  if ('answer' in body || 'visibility' in body) {
    const nextAnswer = 'answer' in body ? String(body.answer ?? '') : current.answer || '';
    const answer = cleanText(nextAnswer, cfg.maxAnswerLength, { label: '回答' });
    const nextVisibility = 'visibility' in body ? body.visibility : current.visibility;
    if (nextVisibility !== 'public' && nextVisibility !== 'private') {
      throw httpError(400, 'visibility 只能是 public 或 private');
    }
    item = db.saveAnswer(publicId, answer, answer === '' ? 'private' : nextVisibility);
  }

  if ('pinned' in body) item = db.setPinned(publicId, body.pinned === true);
  if ('hidden' in body) item = db.setHidden(publicId, body.hidden === true);

  return sendJson(res, 200, { ok: true, item, stats: db.getStats() });
}

async function handleAdminDelete(req, res, publicId) {
  if (!sameOrigin(req)) throw httpError(403, '来源校验失败');
  const ok = db.deleteQuestion(publicId);
  if (!ok) throw httpError(404, '提问不存在');
  return sendJson(res, 200, { ok: true, stats: db.getStats() });
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, pathname, url) {
  const method = req.method || 'GET';
  const segments = pathname.split('/').filter(Boolean); // ['api', ...]

  if (segments[1] === 'meta' && segments.length === 2 && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      siteName: cfg.siteName,
      siteDesc: cfg.siteDesc,
      ownerName: cfg.ownerName,
      maxQuestionLength: cfg.maxQuestionLength,
      maxFollowupLength: cfg.maxFollowupLength,
      maxAnswerLength: cfg.maxAnswerLength,
      maxNicknameLength: cfg.maxNicknameLength,
      maxTagLength: cfg.maxTagLength,
      authed: isAdmin(req),
    });
  }

  if (segments[1] === 'questions' && segments.length === 2) {
    if (method === 'POST') return handleSubmit(req, res);
    if (method === 'GET') return handlePublicList(req, res, url);
    throw httpError(405, '不支持的请求方法');
  }

  if (segments[1] === 'my' && segments.length === 4 && segments[3] === 'followup' && method === 'POST') {
    return handleFollowup(req, res, segments[2]);
  }
  if (segments[1] === 'my' && segments.length === 3 && method === 'GET') {
    return handleMyQuestion(req, res, segments[2]);
  }

  if (segments[1] === 'admin') {
    if (segments[2] === 'login' && segments.length === 3 && method === 'POST') return handleLogin(req, res);
    if (segments[2] === 'logout' && segments.length === 3 && method === 'POST') return handleLogout(req, res);

    // 「我是谁」这类探测接口未登录时返回 200 + authed:false，
    // 而不是 401 —— 否则浏览器控制台每次打开后台都会报一条红色错误。
    if (segments[2] === 'session' && segments.length === 3 && method === 'GET') {
      if (!isAdmin(req)) return sendJson(res, 200, { ok: true, authed: false });
      return sendJson(res, 200, { ok: true, authed: true, stats: db.getStats() });
    }

    if (!isAdmin(req)) throw httpError(401, '未登录或登录已过期');

    if (segments[2] === 'questions' && segments.length === 3 && method === 'GET') {
      return handleAdminList(req, res, url);
    }
    if (segments[2] === 'questions' && segments.length === 4) {
      const publicId = segments[3];
      if (method === 'PATCH' || method === 'PUT') return handleAdminUpdate(req, res, publicId);
      if (method === 'DELETE') return handleAdminDelete(req, res, publicId);
      throw httpError(405, '不支持的请求方法');
    }
  }

  throw httpError(404, '接口不存在');
}

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);

  let pathname = '/';
  let url;
  try {
    url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: '请求地址不合法' });
  }

  try {
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, url);
    } else {
      await handleStatic(req, res, pathname);
    }
  } catch (err) {
    const status = Number(err && err.status) || 500;
    if (status >= 500) console.error('[error]', req.method, pathname, err);
    if (res.headersSent) {
      res.end();
    } else {
      sendJson(res, status, {
        error: status >= 500 ? '服务器内部错误' : err.publicMessage || err.message || '请求失败',
      });
    }
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

/** 只有确实写下了这个 pid 文件的实例才有权删它 —— 否则重复启动失败的那个实例
 *  在退出时会把正在运行的实例的 pid 文件删掉，导致 stop.bat 失效。 */
let ownsPidFile = false;

function releasePidFile() {
  if (!ownsPidFile) return;
  ownsPidFile = false;
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) {
      fs.rmSync(PID_FILE, { force: true });
    }
  } catch { /* 文件已经不在了，忽略 */ }
}

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

server.listen(cfg.port, cfg.host, () => {
  // 记录 pid，供 stop.bat 精确停止（比按进程名匹配可靠得多）
  try {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
    ownsPidFile = true;
  } catch { /* 忽略 */ }

  const line = '─'.repeat(58);
  console.log(`\n${line}`);
  console.log(`  ${cfg.siteName} 已启动`);
  console.log(line);
  console.log(`  本机访问   http://localhost:${cfg.port}`);
  for (const ip of lanAddresses()) {
    console.log(`  局域网访问 http://${ip}:${cfg.port}`);
  }
  console.log(`  管理后台   http://localhost:${cfg.port}/admin`);
  console.log(`  数据库     ${db.DB_PATH}`);
  console.log(`  配置文件   ${configPath}`);
  if (generatedPassword) {
    console.log(`\n  ⚠ 已自动生成管理口令：${generatedPassword}`);
    try {
      fs.writeFileSync(
        path.join(db.DATA_DIR, 'admin-password.txt'),
        `管理口令：${generatedPassword}\n生成时间：${new Date().toLocaleString()}\n登录地址：http://localhost:${cfg.port}/admin\n`,
        'utf8',
      );
      console.log(`    已同时写入 ${path.join(db.DATA_DIR, 'admin-password.txt')}`);
    } catch { /* 忽略写入失败 */ }
  }
  for (const notice of notices) console.log(`  · ${notice}`);
  console.log(`${line}\n`);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${cfg.port} 已被占用 —— 服务可能已经在运行了。`);
    console.error('  先双击 stop.bat 停止它，或者改 config.json 里的 port 换一个端口。\n');
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error(`\n  没有权限监听端口 ${cfg.port}，换一个 1024 以上的端口试试。\n`);
    process.exit(1);
  }
  throw err;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n正在关闭…');
    releasePidFile();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

process.on('exit', releasePidFile);
