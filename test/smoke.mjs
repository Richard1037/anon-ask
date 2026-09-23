/**
 * 端到端冒烟测试。
 *
 *   node test/smoke.mjs
 *
 * 会在 test/.tmp/ 下起一个独立配置、独立数据库的临时服务实例（默认端口 8791），
 * 跑完全部断言后自动关闭并清理，不会碰到 config.json 和 data/app.db。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ipUtil = require('../lib/clientip.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TMP = path.join(HERE, '.tmp');

const PORT = 8791;
const PASSWORD = 'smoke-test-password-9271';
const SUBMIT_LIMIT = 8;        // 必须与下面的测试配置一致
const LOGIN_LIMIT = 5;         // 必须与下面的测试配置一致

/* ------------------------------------------------------------------ */
/* 临时实例                                                            */
/* ------------------------------------------------------------------ */

let child = null;
let logPath = null;

function startServer() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  logPath = path.join(TMP, 'server.log');

  fs.writeFileSync(
    path.join(TMP, 'config.json'),
    JSON.stringify(
      {
        siteName: '冒烟测试站',
        siteDesc: '测试用',
        port: PORT,
        host: '127.0.0.1',
        trustProxy: false,
        adminPassword: PASSWORD,
        rateLimit: {
          submitPerMinute: SUBMIT_LIMIT,
          submitPerDay: 500,
          loginPerTenMinutes: LOGIN_LIMIT,
          followupPerMinute: 5,
          followupPerDay: 100,
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  // 子进程输出重定向到普通文件（不能用管道：受限沙箱下 spawn 的管道会 EPERM）。
  const logFd = fs.openSync(logPath, 'a');

  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      ANON_ASK_CONFIG: path.join(TMP, 'config.json'),
      ANON_ASK_DATA: TMP,
      ANON_ASK_DB: path.join(TMP, 'app.db'),
    },
  });

  child.on('error', (err) => {
    console.error(`无法启动临时服务：${err.message}`);
  });
}

function serverLog() {
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch {
    return '（没有日志）';
  }
}

async function waitForReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request('GET', '/api/meta');
      if (res.status === 200) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function stopServer() {
  if (child && child.exitCode === null) child.kill();
  // 等文件句柄释放后再删，否则 Windows 上会 EBUSY
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* 清理失败不影响测试结论 */
  }
}

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function group(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ */
/* HTTP 客户端                                                         */
/* ------------------------------------------------------------------ */

function request(method, pathname, { body, headers = {}, raw } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== undefined
      ? Buffer.from(raw)
      : body === undefined ? null : Buffer.from(JSON.stringify(body));

    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path: pathname,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieOf(res) {
  const set = res.headers['set-cookie'];
  if (!Array.isArray(set) || set.length === 0) return null;
  return set[0].split(';')[0];
}

/* ------------------------------------------------------------------ */
/* 测试主体                                                            */
/* ------------------------------------------------------------------ */

let submitHits = 0;
const XSS_PAYLOAD = '<script>alert("xss")</script><img src=x onerror=alert(1)>';

async function run() {
  console.log(`冒烟测试 · 临时实例 127.0.0.1:${PORT}`);
  console.log('─'.repeat(56));

  let publicToken = null;
  let privateToken = null;
  let cookie = null;

  group('1. 元信息与静态资源');
  {
    const meta = await request('GET', '/api/meta');
    check('GET /api/meta 返回 200', meta.status === 200, `实际 ${meta.status}`);
    check('meta 含 siteName', typeof meta.json?.siteName === 'string');
    check('meta 报告未登录', meta.json?.authed === false);
    check('meta 暴露长度上限', typeof meta.json?.maxQuestionLength === 'number');

    const home = await request('GET', '/');
    check('GET / 返回 200', home.status === 200, `实际 ${home.status}`);
    const csp = home.headers['content-security-policy'] || '';
    check('首页带 CSP 头', csp.length > 0);
    check("CSP 限制 script-src 'self'", /script-src 'self'/.test(csp));
    check('CSP 禁止 object-src', /object-src 'none'/.test(csp));
    check('CSP 禁止被 iframe 嵌套', /frame-ancestors 'none'/.test(csp));
    check('带 nosniff', home.headers['x-content-type-options'] === 'nosniff');

    check('GET /admin 返回 200', (await request('GET', '/admin')).status === 200);
    check('GET /my 返回 200', (await request('GET', '/my')).status === 200);
    check('GET /style.css 返回 200', (await request('GET', '/style.css')).status === 200);
    check('未知静态资源返回 404', (await request('GET', '/nope.html')).status === 404);
  }

  group('2. 路径穿越防护');
  {
    const paths = [
      '/../config.json',
      '/..%2fconfig.json',
      '/%2e%2e%2fconfig.json',
      '/....//config.json',
      '/../server.js',
      '/../data/app.db',
      '/public/../../config.json',
    ];
    for (const p of paths) {
      const res = await request('GET', p);
      check(`拒绝 ${p}`,
        res.status === 400 || res.status === 403 || res.status === 404,
        `实际 ${res.status}`);
      check(`${p} 未泄漏敏感字段`,
        !res.text.includes('adminPasswordHash') && !res.text.includes('sessionSecret'));
    }
  }

  group('3. 匿名提交与输入校验');
  {
    const q1 = await request('POST', '/api/questions', {
      body: { content: '第一条公开测试问题', nickname: '小明', tag: '测试' },
    });
    submitHits += 1;
    check('提交问题返回 201', q1.status === 201, `实际 ${q1.status} ${q1.text.slice(0, 140)}`);
    check('返回回执 token', typeof q1.json?.token === 'string' && q1.json.token.length >= 16);
    check('返回回执链接', typeof q1.json?.receiptUrl === 'string');
    publicToken = q1.json?.token;

    const q2 = await request('POST', '/api/questions', { body: { content: '第二条私密测试问题' } });
    submitHits += 1;
    check('第二次提交成功', q2.status === 201, `实际 ${q2.status}`);
    privateToken = q2.json?.token;

    const q3 = await request('POST', '/api/questions', { body: { content: XSS_PAYLOAD } });
    submitHits += 1;
    check('含 XSS 载荷的提交被接受', q3.status === 201, `实际 ${q3.status}`);
    check('响应体不回显原文（无反射型 XSS）', !q3.text.includes('<script>'));

    const empty = await request('POST', '/api/questions', { body: { content: '   ' } });
    submitHits += 1;
    check('纯空白内容返回 400', empty.status === 400, `实际 ${empty.status}`);

    const long = await request('POST', '/api/questions', { body: { content: 'x'.repeat(2000) } });
    submitHits += 1;
    check('超长内容返回 400', long.status === 400, `实际 ${long.status}`);
    check('超长报错提示字数上限', /最多\s*\d+\s*个字/.test(long.json?.error || ''), long.json?.error);

    const badJson = await request('POST', '/api/questions', { raw: '{not json' });
    check('非法 JSON 返回 400', badJson.status === 400, `实际 ${badJson.status}`);

    const huge = await request('POST', '/api/questions', {
      raw: JSON.stringify({ content: 'y'.repeat(40000) }),
    });
    check('超大请求体返回 413', huge.status === 413, `实际 ${huge.status}`);
    check('413 有可读错误体', typeof huge.json?.error === 'string');

    const arr = await request('POST', '/api/questions', { raw: '[1,2,3]' });
    check('非对象 JSON 返回 400', arr.status === 400, `实际 ${arr.status}`);

    const csrf = await request('POST', '/api/questions', {
      body: { content: '跨站提交' },
      headers: { Origin: 'http://evil.example' },
    });
    check('跨站 Origin 返回 403', csrf.status === 403, `实际 ${csrf.status}`);

    const honeypot = await request('POST', '/api/questions', {
      body: { content: '机器人提交', website: 'http://spam.example' },
    });
    submitHits += 1;
    check('蜜罐字段触发假成功 201', honeypot.status === 201, `实际 ${honeypot.status}`);
    check('蜜罐返回伪 token（格式合法）',
      typeof honeypot.json?.token === 'string' && honeypot.json.token.length >= 16);
  }

  group('4. 提问墙不泄漏未公开内容');
  {
    const wall = await request('GET', '/api/questions');
    check('提问墙返回 200', wall.status === 200);
    check('未回答的提问不上墙', wall.json?.total === 0, `实际 total=${wall.json?.total}`);
    check('墙内容不含测试问题原文', !wall.text.includes('第一条公开测试问题'));

    const big = await request('GET', '/api/questions?limit=99999');
    check('limit 被夹紧不报错', big.status === 200);
  }

  group('5. 提问者回执页');
  {
    const mine = await request('GET', `/api/my/${publicToken}`);
    check('凭 token 读到自己的提问', mine.status === 200, `实际 ${mine.status}`);
    check('未回答时 answered=false', mine.json?.question?.answered === false);
    check('未回答时不返回答案内容', mine.json?.question?.answer === '');
    check('回执页带原始昵称', mine.json?.question?.nickname === '小明');

    check('伪造 token 返回 404',
      (await request('GET', '/api/my/aaaaaaaaaaaaaaaaaaaaaaaa')).status === 404);
    check('过短 token 返回 404',
      (await request('GET', '/api/my/short')).status === 404);
    check('含非法字符的 token 返回 404',
      (await request('GET', '/api/my/aaaaaaaaaaaa<script>')).status === 404);

    const follow = await request('POST', `/api/my/${publicToken}/followup`, {
      body: { content: '补充：其实我是想问细节。' },
    });
    check('追加补充成功', follow.status === 200, `实际 ${follow.status}`);
    check('补充出现在回执页', follow.json?.question?.followups?.length === 1);

    const followBad = await request('POST', `/api/my/${publicToken}/followup`, { body: { content: '' } });
    check('空补充返回 400', followBad.status === 400, `实际 ${followBad.status}`);

    const followBogus = await request('POST', '/api/my/aaaaaaaaaaaaaaaaaaaaaaaa/followup', {
      body: { content: '你好' },
    });
    check('伪造 token 追加返回 404', followBogus.status === 404, `实际 ${followBogus.status}`);
  }

  group('6. 管理后台鉴权');
  {
    check('未登录读列表返回 401',
      (await request('GET', '/api/admin/questions')).status === 401);

    const anonSession = await request('GET', '/api/admin/session');
    check('未登录读会话返回 200 + authed:false（避免控制台 401 红字）',
      anonSession.status === 200 && anonSession.json?.authed === false,
      `实际 ${anonSession.status} authed=${anonSession.json?.authed}`);

    const wrong = await request('POST', '/api/admin/login', { body: { password: 'definitely-wrong' } });
    check('错误口令返回 401', wrong.status === 401, `实际 ${wrong.status}`);
    check('错误口令不下发 Cookie', cookieOf(wrong) === null);

    const shortPw = await request('POST', '/api/admin/login', { body: { password: '' } });
    check('空口令返回 400', shortPw.status === 400, `实际 ${shortPw.status}`);

    const login = await request('POST', '/api/admin/login', { body: { password: PASSWORD } });
    check('正确口令登录返回 200', login.status === 200, `实际 ${login.status} ${login.text.slice(0, 140)}`);
    cookie = cookieOf(login);
    const setCookie = login.headers['set-cookie']?.[0] || '';
    check('下发会话 Cookie', typeof cookie === 'string' && cookie.startsWith('aq_sid='));
    check('Cookie 带 HttpOnly', /HttpOnly/i.test(setCookie));
    check('Cookie 带 SameSite=Strict', /SameSite=Strict/i.test(setCookie));
    check('Cookie 带 Max-Age', /Max-Age=\d+/i.test(setCookie));

    const tampered = `${cookie.slice(0, -4)}AAAA`;
    check('被篡改的会话 Cookie 返回 401',
      (await request('GET', '/api/admin/questions', { headers: { Cookie: tampered } })).status === 401);

    const forged = 'aq_sid=eyJleHAiOjk5OTk5OTk5OTl9.deadbeef';
    check('伪造的会话 Cookie 返回 401',
      (await request('GET', '/api/admin/questions', { headers: { Cookie: forged } })).status === 401);
  }

  const authed = () => ({ Cookie: cookie });
  let publicId = null;
  let secondId = null;
  let xssId = null;

  group('7. 管理列表与数据完整性');
  {
    const list = await request('GET', '/api/admin/questions?filter=all&limit=50', { headers: authed() });
    check('管理员可读列表', list.status === 200, `实际 ${list.status}`);
    check('列表恰好 3 条真实提问', list.json?.total === 3, `实际 ${list.json?.total}`);
    check('蜜罐提交未入库', !list.text.includes('机器人提交'));

    const items = list.json.items;
    publicId = items.find((i) => i.content === '第一条公开测试问题')?.id;
    secondId = items.find((i) => i.content === '第二条私密测试问题')?.id;
    xssId = items.find((i) => i.content.startsWith('<script>'))?.id;
    check('能找到三条提问的 ID', Boolean(publicId && secondId && xssId));

    check('json_each 聚合出补充计数',
      items.some((i) => i.followupCount > 0), 'followupCount 全为 0');
    check('XSS 载荷按原文存储，未被破坏',
      items.find((i) => i.id === xssId)?.content === XSS_PAYLOAD,
      JSON.stringify(items.find((i) => i.id === xssId)?.content));
    check('统计：待回答 3 条', list.json?.stats?.unanswered === 3, `实际 ${list.json?.stats?.unanswered}`);
    check('统计：已公开 0 条', list.json?.stats?.published === 0, `实际 ${list.json?.stats?.published}`);

    const unanswered = await request('GET', '/api/admin/questions?filter=unanswered', { headers: authed() });
    check('filter=unanswered 命中 3 条', unanswered.json?.total === 3, `实际 ${unanswered.json?.total}`);

    const search = await request('GET',
      `/api/admin/questions?filter=all&q=${encodeURIComponent('私密测试')}`, { headers: authed() });
    check('搜索命中 1 条', search.json?.total === 1, `实际 ${search.json?.total}`);

    // filter 不在白名单里 → 回退 all；q 走参数化 LIKE → 注入串只是普通搜索词，匹配不到任何行
    const inject = await request('GET',
      "/api/admin/questions?filter=%27%20OR%201%3D1--&q=%27%20OR%201%3D1--", { headers: authed() });
    check('SQL 注入不生效（filter 白名单回退 + q 参数化）',
      inject.status === 200 && inject.json?.total === 0,
      `实际 ${inject.status} total=${inject.json?.total}`);
    const survived = await request('GET', '/api/admin/questions?filter=all', { headers: authed() });
    check('SQL 注入未清空或污染数据', survived.json?.total === 3, `实际 ${survived.json?.total}`);
  }

  group('8. 回答 · 公开 / 仅提问者可见');
  {
    const pub = await request('PATCH', `/api/admin/questions/${publicId}`, {
      headers: authed(),
      body: { answer: '这是公开回答。', visibility: 'public' },
    });
    check('公开回答保存成功', pub.status === 200, `实际 ${pub.status} ${pub.text.slice(0, 140)}`);
    check('返回 visibility=public', pub.json?.item?.visibility === 'public');
    check('返回 answered=true', pub.json?.item?.answered === true);

    const wall = await request('GET', '/api/questions');
    check('公开回答后提问墙出现 1 条', wall.json?.total === 1, `实际 ${wall.json?.total}`);
    check('墙上答案正确', wall.json?.items?.[0]?.answer === '这是公开回答。');
    check('墙上带昵称', wall.json?.items?.[0]?.nickname === '小明');
    check('墙上带标签', wall.json?.items?.[0]?.tag === '测试');
    check('墙上不暴露 visibility 字段', wall.json?.items?.[0]?.visibility === undefined);
    check('墙上不暴露 ip_hash 字段', wall.json?.items?.[0]?.ipHash === undefined);

    const priv = await request('PATCH', `/api/admin/questions/${secondId}`, {
      headers: authed(),
      body: { answer: '这是只给你看的回答。', visibility: 'private' },
    });
    check('单独回答保存成功', priv.status === 200);
    check('返回 visibility=private', priv.json?.item?.visibility === 'private');

    const wall2 = await request('GET', '/api/questions');
    check('单独回答不上提问墙', wall2.json?.total === 1, `实际 ${wall2.json?.total}`);
    check('提问墙不泄漏私密回答', !wall2.text.includes('只给你看的回答'));

    const mine = await request('GET', `/api/my/${privateToken}`);
    check('提问者能看到单独回答', mine.json?.question?.answer === '这是只给你看的回答。');
    check('单独回答 published=false', mine.json?.question?.published === false);

    const minePub = await request('GET', `/api/my/${publicToken}`);
    check('公开回答的提问者也能看到', minePub.json?.question?.answer === '这是公开回答。');
    check('公开回答 published=true', minePub.json?.question?.published === true);

    check('未登录 PATCH 返回 401',
      (await request('PATCH', `/api/admin/questions/${publicId}`, {
        body: { answer: '匿名者篡改', visibility: 'public' },
      })).status === 401);
    check('未登录的篡改未生效',
      (await request('GET', '/api/questions')).json?.items?.[0]?.answer === '这是公开回答。');

    check('跨站 PATCH 返回 403',
      (await request('PATCH', `/api/admin/questions/${publicId}`, {
        headers: { ...authed(), Origin: 'http://evil.example' },
        body: { answer: '跨站篡改' },
      })).status === 403);
    check('跨站篡改未生效',
      (await request('GET', '/api/questions')).json?.items?.[0]?.answer === '这是公开回答。');

    const badVis = await request('PATCH', `/api/admin/questions/${publicId}`, {
      headers: authed(), body: { answer: 'x', visibility: 'nonsense' },
    });
    check('非法 visibility 返回 400', badVis.status === 400, `实际 ${badVis.status}`);

    // 8000 字：低于 16KB 请求体上限，但超过 4000 字回答上限 → 应该走校验分支而不是 413
    const longAnswer = await request('PATCH', `/api/admin/questions/${publicId}`, {
      headers: authed(), body: { answer: 'z'.repeat(8000), visibility: 'private' },
    });
    check('超长回答返回 400', longAnswer.status === 400, `实际 ${longAnswer.status}`);
    check('超长回答提示字数上限', /最多\s*\d+\s*个字/.test(longAnswer.json?.error || ''), longAnswer.json?.error);

    const missing = await request('PATCH', '/api/admin/questions/deadbeef00', {
      headers: authed(), body: { pinned: true },
    });
    check('操作不存在的提问返回 404', missing.status === 404, `实际 ${missing.status}`);
  }

  group('9. 撤销回答 · 置顶 · 隐藏');
  {
    const set = await request('PATCH', `/api/admin/questions/${xssId}`, {
      headers: authed(), body: { answer: '临时回答', visibility: 'public' },
    });
    check('给第三条一个公开回答', set.json?.item?.visibility === 'public');
    const before = (await request('GET', '/api/questions')).json.total;

    const cleared = await request('PATCH', `/api/admin/questions/${xssId}`, {
      headers: authed(), body: { answer: '', visibility: 'public' },
    });
    check('清空回答后回到 private', cleared.json?.item?.visibility === 'private');
    check('清空回答后 answered=false', cleared.json?.item?.answered === false);
    const after = (await request('GET', '/api/questions')).json.total;
    check('撤回后提问墙减少一条', after === before - 1, `${before} → ${after}`);

    const pin = await request('PATCH', `/api/admin/questions/${publicId}`, {
      headers: authed(), body: { pinned: true },
    });
    check('置顶成功', pin.json?.item?.pinned === true);
    check('墙上首条为置顶项',
      (await request('GET', '/api/questions')).json?.items?.[0]?.pinned === true);

    const unpin = await request('PATCH', `/api/admin/questions/${publicId}`, {
      headers: authed(), body: { pinned: false },
    });
    check('取消置顶成功', unpin.json?.item?.pinned === false);

    const hide = await request('PATCH', `/api/admin/questions/${publicId}`, {
      headers: authed(), body: { hidden: true },
    });
    check('隐藏成功', hide.json?.item?.hidden === true);
    check('隐藏后从提问墙消失',
      (await request('GET', '/api/questions')).json?.total === 0);

    const unhide = await request('PATCH', `/api/admin/questions/${publicId}`, {
      headers: authed(), body: { hidden: false },
    });
    check('取消隐藏成功', unhide.json?.item?.hidden === false);
    check('取消隐藏后恢复',
      (await request('GET', '/api/questions')).json?.total === 1);

    check('DELETE 未登录返回 401',
      (await request('DELETE', `/api/admin/questions/${xssId}`)).status === 401);
  }

  group('10. 清理测试数据 · 登出');
  {
    const list = await request('GET', '/api/admin/questions?filter=all&limit=100', { headers: authed() });
    for (const item of list.json.items) {
      const del = await request('DELETE', `/api/admin/questions/${item.id}`, { headers: authed() });
      check(`删除 ${item.id}`, del.status === 200, `实际 ${del.status}`);
    }
    const final = await request('GET', '/api/admin/questions?filter=all', { headers: authed() });
    check('清空后列表为空', final.json?.total === 0, `实际 ${final.json?.total}`);
    check('提问墙随之为空', (await request('GET', '/api/questions')).json?.total === 0);

    check('删除不存在的提问返回 404',
      (await request('DELETE', '/api/admin/questions/deadbeef00', { headers: authed() })).status === 404);

    const out = await request('POST', '/api/admin/logout', { headers: authed() });
    check('登出返回 200', out.status === 200);
    check('登出清除 Cookie', /Max-Age=0/.test(out.headers['set-cookie']?.[0] || ''));
  }

  group('11. 未知接口');
  {
    check('未知 API 返回 404 JSON',
      (await request('GET', '/api/nope')).status === 404);
    check('不支持的方法返回 405',
      (await request('PUT', '/api/questions')).status === 405);
    check('对静态资源用 POST 返回 405',
      (await request('POST', '/')).status === 405);
  }

  group(`12. 提交限流（上限 ${SUBMIT_LIMIT} 次/分钟）`);
  {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await request('POST', '/api/questions', { body: { content: `限流探测 ${i}` } });
      statuses.push(res.status);
      if (res.status === 201) submitHits += 1;
    }
    const blocked = statuses.filter((s) => s === 429).length;

    check('探测过程中出现 429', blocked > 0, `状态序列 ${statuses.join(',')}`);
    check('最后一次探测被拒绝', statuses[statuses.length - 1] === 429, `状态序列 ${statuses.join(',')}`);
    check('一旦被限流不会自我恢复',
      statuses.indexOf(429) === -1 || statuses.slice(statuses.indexOf(429)).every((s) => s === 429),
      `状态序列 ${statuses.join(',')}`);

    const retry = await request('POST', '/api/questions', { body: { content: '再来一次' } });
    check('持续请求仍被限流', retry.status === 429, `实际 ${retry.status}`);
    check('429 错误信息含等待秒数', /秒后再试/.test(retry.json?.error || ''), retry.json?.error);
  }

  group(`13. 登录限流（上限 ${LOGIN_LIMIT} 次/10 分钟，精确计数）`);
  {
    const statuses = [];
    for (let i = 0; i < LOGIN_LIMIT + 2; i += 1) {
      const res = await request('POST', '/api/admin/login', { body: { password: 'wrong-password' } });
      statuses.push(res.status);
    }
    check(`前 ${LOGIN_LIMIT} 次均返回 401`,
      statuses.slice(0, LOGIN_LIMIT).every((s) => s === 401), `状态序列 ${statuses.join(',')}`);
    check('第 ' + (LOGIN_LIMIT + 1) + ' 次起返回 429',
      statuses[LOGIN_LIMIT] === 429 && statuses[LOGIN_LIMIT + 1] === 429,
      `状态序列 ${statuses.join(',')}`);

    const locked = await request('POST', '/api/admin/login', { body: { password: PASSWORD } });
    check('限流期间正确口令同样被拒', locked.status === 429, `实际 ${locked.status}`);
  }

  group('14. IP 解析与归一化（纯单元测试）');
  {
    check('纯 IPv4 原样保留',
      ipUtil.normalizeIpForLimit('203.0.113.9') === '203.0.113.9');
    check('IPv4-mapped IPv6 还原成 IPv4',
      ipUtil.normalizeIpForLimit('::ffff:203.0.113.9') === '203.0.113.9');

    const a = ipUtil.normalizeIpForLimit('240e:604:312:c523:b05b:ca71:512:d1aa');
    const b = ipUtil.normalizeIpForLimit('240e:604:312:c523:ffff:ffff:ffff:ffff');
    check('同一 /64 内的不同地址归一到同一前缀（防换地址绕过限流）',
      a === b, `${a} vs ${b}`);
    check('归一化结果为 /64 形式', a === '240e:604:312:c523::/64', a);

    const c = ipUtil.normalizeIpForLimit('240e:604:312:c524::1');
    check('不同 /64 互不影响', c !== a, `${a} vs ${c}`);

    check('正确处理 :: 缩写',
      ipUtil.normalizeIpForLimit('2001:db8::1') === '2001:db8:0:0::/64',
      ipUtil.normalizeIpForLimit('2001:db8::1'));
    check('去掉 zone id',
      ipUtil.normalizeIpForLimit('fe80::1%12') === 'fe80:0:0:0::/64',
      ipUtil.normalizeIpForLimit('fe80::1%12'));
    check('空值兜底', ipUtil.normalizeIpForLimit('') === 'unknown');
    check('null 兜底', ipUtil.normalizeIpForLimit(null) === 'unknown');

    const req = (remote, headers) => ({ socket: { remoteAddress: remote }, headers });

    check('trustProxy 关闭时忽略转发头',
      ipUtil.clientIp(req('10.0.0.5', { 'x-forwarded-for': '1.2.3.4' }), { trustProxy: false }) === '10.0.0.5');
    check('非回环直连时忽略转发头（局域网伪造无效）',
      ipUtil.clientIp(req('10.0.0.5', { 'x-forwarded-for': '1.2.3.4' }), { trustProxy: true }) === '10.0.0.5');
    check('回环直连时优先采信 CF-Connecting-IP',
      ipUtil.clientIp(
        req('127.0.0.1', { 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '1.2.3.4' }),
        { trustProxy: true },
      ) === '198.51.100.7');
    check('回环直连时回退到 X-Forwarded-For 首段',
      ipUtil.clientIp(req('::1', { 'x-forwarded-for': '198.51.100.8, 10.0.0.1' }),
        { trustProxy: true }) === '198.51.100.8');
    check('回环且无转发头时使用直连地址',
      ipUtil.clientIp(req('127.0.0.1', {}), { trustProxy: true }) === '127.0.0.1');
  }
}

/* ------------------------------------------------------------------ */

let exitCode = 0;
try {
  startServer();
  const ready = await waitForReady();
  if (!ready) throw new Error(`临时服务在 15 秒内没有就绪。服务日志：\n${serverLog()}`);

  await run();

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.log('\n失败清单：');
    for (const name of failures) console.log(`  · ${name}`);
    exitCode = 1;
  } else {
    console.log('全部通过 ✓');
  }
} catch (err) {
  console.error(`\n测试中断：${err.message}`);
  exitCode = 1;
} finally {
  stopServer();
}

process.exit(exitCode);
