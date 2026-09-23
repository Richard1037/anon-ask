/**
 * 真实浏览器验证（Chrome DevTools Protocol）。
 *
 *   node test/browser-check.mjs [baseUrl] [管理口令] [私密回执token]
 *
 * 检查项：页面无 JS 报错、无横向溢出、关键元素渲染正确，
 * 并在真实浏览器里完整走一遍「登录后台 → 渲染提问列表」。
 *
 * 需要本机装有 Chrome（可用 CHROME 环境变量指定路径）。
 * 注意：Chrome 的多进程 IPC 依赖命名管道，在受限沙箱下无法启动。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.CHROME
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.argv[2] || 'http://127.0.0.1:8080';
const PASSWORD = process.argv[3] || 'askbox-cjrinwgy';
const PRIVATE_TOKEN = process.argv[4] || '';
// 随机挑一个调试端口：固定端口一旦被上一次残留的 Chrome 占住，
// /json/list 会返回「别人」的页面目标，脚本就会去驱动错误的浏览器甚至卡住。
const PORT = 9300 + Math.floor(Math.random() * 600);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function group(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ */

class Session {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.events = [];

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        this.events.push(msg);
        for (const fn of [...this.listeners]) fn(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 20000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const fn = (msg) => {
        if (msg.method !== method) return;
        this.listeners = this.listeners.filter((x) => x !== fn);
        resolve(msg.params);
      };
      this.listeners.push(fn);
    });
  }

  clear() {
    this.events.length = 0;
  }

  problems() {
    const out = [];
    for (const msg of this.events) {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        out.push(`未捕获异常：${d.exception?.description || d.text}`);
      } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        out.push(`console.error：${msg.params.entry.text}`);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        out.push(`console.error：${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
      }
    }
    return out;
  }
}

async function evaluate(session, expression) {
  const res = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result.value;
}

/** 轮询直到表达式为真；公网访问时网络往返更慢，靠固定 sleep 会误判。 */
async function waitFor(session, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(session, expression)) return true;
    } catch {
      /* 页面可能正在导航，忽略后重试 */
    }
    await sleep(150);
  }
  return false;
}

/** 页面 init() 结束时会打上这个标记。 */
const READY = "document.documentElement.dataset.ready === '1'";

async function visit(session, url, readyExpression = READY) {
  session.clear();
  const loaded = session.once('Page.loadEventFired');
  await session.send('Page.navigate', { url });
  await Promise.race([loaded, sleep(10000)]);
  const ok = await waitFor(session, readyExpression);
  if (!ok) console.log(`  warn 等待就绪超时：${url}`);
}

/** 设置 SHOTS=<目录> 时顺手保存整页截图，便于人工核对排版。 */
const SHOT_DIR = process.env.SHOTS || '';

async function capture(session, name) {
  if (!SHOT_DIR) return;
  const res = await session.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
  console.log(`  shot ${file}`);
}

/* ------------------------------------------------------------------ */

const profile = path.join(os.tmpdir(), `anonask-cdp-${Date.now()}`);
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-crash-reporter',
  '--disable-crashpad',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--window-size=430,1200',
  'about:blank',
], { stdio: 'ignore' });

let session = null;
let exitCode = 0;

async function connect() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      // 必须确认这个调试端口确实是我们刚启动的那个 Chrome 实例
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl
        && t.url === 'about:blank');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  throw new Error(`25 秒内没能连上 Chrome 的调试端口 ${PORT}`);
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });
}

try {
  console.log(`浏览器验证 · ${BASE}`);
  console.log('─'.repeat(56));

  session = new Session(await connectWs(await connect()));
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Log.enable');
  await session.send('Network.enable');
  // ngrok 免费版会给浏览器插一个「You are about to visit」提示页，
  // 带上这个头即可跳过，方便对着 ngrok 地址做自动化验证（对普通地址无影响）。
  await session.send('Network.setExtraHTTPHeaders', {
    headers: { 'ngrok-skip-browser-warning': '1' },
  });

  // 找出真正把页面撑宽的元素，失败时能直接定位到选择器
  const layout = `(() => {
    const de = document.documentElement;
    const limit = de.clientWidth;
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el === de || el === document.body) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.right > limit + 1 || r.left < -1) {
        bad.push(el.tagName.toLowerCase()
          + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '')
          + ' [' + Math.round(r.left) + '→' + Math.round(r.right) + ']');
      }
    }
    return {
      scrollWidth: de.scrollWidth,
      clientWidth: limit,
      overflow: de.scrollWidth - limit,
      offenders: [...new Set(bad)].slice(0, 6),
    };
  })()`;

  function layoutDetail(l) {
    return `scrollWidth=${l.scrollWidth} clientWidth=${l.clientWidth}`
      + (l.offenders.length ? ` 溢出元素: ${l.offenders.join(' | ')}` : '');
  }

  async function expectNoOverflow(session, name) {
    const l = await evaluate(session, layout);
    check(name, l.overflow <= 0, layoutDetail(l));
    return l;
  }

  await session.send('Emulation.setDeviceMetricsOverride', {
    width: 430, height: 900, deviceScaleFactor: 2, mobile: true,
  });

  group('1. 首页 /');
  {
    await visit(session, `${BASE}/`);
    check('页面无 JS 报错', session.problems().length === 0, session.problems().join(' | '));

    await expectNoOverflow(session, '无横向溢出');

    check('站点名已由 /api/meta 填充',
      (await evaluate(session, `document.getElementById('siteName').textContent.trim()`)).length > 0);
    check('主题色已应用',
      (await evaluate(session, `getComputedStyle(document.body).backgroundColor`)) !== 'rgba(0, 0, 0, 0)');
    const wall = await evaluate(session, `(() => ({
      cards: document.querySelectorAll('#wall .qa').length,
      loadMoreHidden: document.getElementById('loadMore').hidden,
      emptyHidden: document.getElementById('wallEmpty').hidden,
    }))()`);
    check('问号墙已渲染', wall.cards > 0, JSON.stringify(wall));
    check('条目不足一页时隐藏「加载更多」',
      wall.cards !== 10 ? wall.loadMoreHidden === true : wall.loadMoreHidden === false,
      JSON.stringify(wall));
    check('有内容时隐藏空状态提示', wall.emptyHidden === true, JSON.stringify(wall));
    check('回执面板初始隐藏',
      (await evaluate(session, `document.getElementById('receipt').hidden`)) === true);

    // 提交表单的字符计数器是否绑定
    await evaluate(session, `(() => {
      const t = document.getElementById('content');
      t.value = '测试计数器';
      t.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    check('字数计数器随输入更新',
      (await evaluate(session, `document.getElementById('contentCounter').textContent`)).startsWith('5 /'),
      await evaluate(session, `document.getElementById('contentCounter').textContent`));
    await capture(session, 'home-mobile');
  }

  group('2. 提问墙内容渲染');
  {
    // 同样数据驱动：墙可能是空的，也不一定有人置顶
    const wallApi = await evaluate(session,
      `(async () => (await (await fetch('/api/questions?limit=20')).json()))()`);

    if (wallApi.total === 0) {
      console.log('  skip 提问墙当前为空，跳过卡片渲染检查');
    } else {
      const card = await evaluate(session, `(() => {
        const qa = document.querySelector('#wall .qa');
        if (!qa) return null;
        return {
          author: qa.querySelector('.qa__author')?.textContent,
          hasAnswer: Boolean(qa.querySelector('.qa__answer')),
          pinned: qa.classList.contains('qa--pinned'),
        };
      })()`);
      check('墙上的卡片数与接口一致',
        (await evaluate(session, `document.querySelectorAll('#wall .qa').length`)) === wallApi.items.length,
        `界面 ${await evaluate(session, `document.querySelectorAll('#wall .qa').length`)} / 接口 ${wallApi.items.length}`);
      check('卡片含昵称', Boolean(card?.author), JSON.stringify(card));
      check('卡片含回答区', card?.hasAnswer === true, JSON.stringify(card));

      const anyPinned = wallApi.items.some((i) => i.pinned);
      if (anyPinned) {
        check('置顶条目排在提问墙最前', card?.pinned === true, JSON.stringify(card));
      } else {
        console.log('  skip 当前没有置顶条目');
      }

      const escaped = await evaluate(session,
        `document.querySelectorAll('#wall script, #wall img').length`);
      check('墙内没有注入的 script/img 节点', escaped === 0, `找到 ${escaped} 个`);
    }
  }

  group('3. 管理后台 /admin（未登录）');
  {
    await visit(session, `${BASE}/admin`);
    check('页面无 JS 报错', session.problems().length === 0, session.problems().join(' | '));

    await expectNoOverflow(session, '无横向溢出');

    check('显示登录视图',
      (await evaluate(session, `document.getElementById('loginView').hidden`)) === false);
    check('隐藏管理面板',
      (await evaluate(session, `document.getElementById('panelView').hidden`)) === true);
    check('登录表单存在',
      (await evaluate(session, `Boolean(document.getElementById('loginForm'))`)) === true);
  }

  group('4. 管理后台：真实浏览器登录并渲染列表');
  {
    const loginResult = await evaluate(session, `(async () => {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: ${JSON.stringify(PASSWORD)} }),
      });
      return res.status;
    })()`);
    check('页面内登录成功（200）', loginResult === 200, `实际 ${loginResult}`);

    await visit(session, `${BASE}/admin`);
    check('登录后无 JS 报错', session.problems().length === 0, session.problems().join(' | '));
    await expectNoOverflow(session, '移动端管理面板无横向溢出');

    check('显示管理面板',
      (await evaluate(session, `document.getElementById('panelView').hidden`)) === false);
    check('隐藏登录视图',
      (await evaluate(session, `document.getElementById('loginView').hidden`)) === true);

    const stats = await evaluate(session, `document.querySelectorAll('#stats .stat').length`);
    check('统计栏渲染 6 项', stats === 6, `实际 ${stats}`);

    // 数据驱动：先问接口要真实数据，再核对界面是否与之一致。
    // 不写死条数 —— 这套检查要能跑在任何一份真实数据上。
    const api = await evaluate(session, `(async () => {
      const read = async (f) => (await fetch('/api/admin/questions?filter=' + f + '&limit=100')).json();
      const all = await read('all');
      const unanswered = await read('unanswered');
      return {
        allTotal: all.total,
        unansweredTotal: unanswered.total,
        stats: all.stats,
        items: all.items.map(i => ({
          id: i.id, answered: i.answered, visibility: i.visibility, hidden: i.hidden,
        })),
      };
    })()`);

    const initial = await evaluate(session, `(() => ({
      filter: document.querySelector('#filters .chip[aria-pressed="true"]')?.dataset.filter,
      rendered: document.querySelectorAll('#list .qcard').length,
      firstStat: document.querySelector('#stats .stat .stat__n')?.textContent,
    }))()`);
    check('默认选中「待回答」筛选', initial.filter === 'unanswered', String(initial.filter));
    check('默认筛选下渲染条数与接口一致',
      initial.rendered === api.unansweredTotal, `界面 ${initial.rendered} / 接口 ${api.unansweredTotal}`);
    check('统计栏「待回答」数字与接口一致',
      initial.firstStat === String(api.stats.unanswered), `界面 ${initial.firstStat} / 接口 ${api.stats.unanswered}`);

    // 切到「全部」验证列表渲染
    await evaluate(session, `document.querySelector('[data-filter="all"]').click()`);
    const allShown = await waitFor(session,
      `document.querySelectorAll('#list .qcard').length === ${api.allTotal}`);
    const rendered = await evaluate(session, `document.querySelectorAll('#list .qcard').length`);
    check('切换「全部」后渲染条数与接口一致',
      allShown && rendered === api.allTotal, `界面 ${rendered} / 接口 ${api.allTotal}`);

    const cards = await evaluate(session, `(() => [...document.querySelectorAll('#list .qcard')].map(c => ({
      id: c.dataset.id,
      badge: c.querySelector('.badge')?.textContent,
      hasTextarea: Boolean(c.querySelector('textarea.textarea')),
      seg: [...c.querySelectorAll('.seg button')].map(b => b.getAttribute('aria-pressed')),
      actions: [...c.querySelectorAll('.btn-row .btn')].map(b => b.textContent.trim()),
    })))()`);

    check('每张卡片都有回答输入框',
      cards.length > 0 && cards.every((c) => c.hasTextarea), `${cards.length} 张卡片`);
    check('每张卡片的公开/私密切换都有 2 个选项',
      cards.every((c) => c.seg.length === 2), JSON.stringify(cards[0]?.seg));
    check('每张卡片都有保存/置顶/隐藏/删除按钮',
      cards.every((c) => {
        const has = (t) => c.actions.some((a) => a.includes(t));
        return ['保存回答', '置顶', '隐藏', '删除'].every(has);
      }), JSON.stringify(cards[0]?.actions));

    const expectedBadge = (it) => {
      if (it.hidden) return '已隐藏';
      if (!it.answered) return '待回答';
      return it.visibility === 'public' ? '已公开' : '仅提问者可见';
    };
    const byId = new Map(api.items.map((i) => [i.id, i]));
    const badgeMismatch = cards
      .filter((c) => byId.has(c.id) && expectedBadge(byId.get(c.id)) !== c.badge)
      .map((c) => ({ id: c.id, shown: c.badge, want: expectedBadge(byId.get(c.id)) }));
    check('状态徽章与接口数据一致', badgeMismatch.length === 0, JSON.stringify(badgeMismatch.slice(0, 3)));

    const publicCards = cards.filter((c) => {
      const it = byId.get(c.id);
      return it && it.answered && it.visibility === 'public' && !it.hidden;
    });
    if (publicCards.length > 0) {
      check('已公开条目的分段控件选中「公开到提问墙」',
        publicCards.every((c) => c.seg[1] === 'true' && c.seg[0] === 'false'),
        JSON.stringify(publicCards.slice(0, 2).map((c) => c.seg)));
    } else {
      console.log('  skip 当前没有「已公开」的条目');
    }

    const privateCards = cards.filter((c) => {
      const it = byId.get(c.id);
      return it && it.answered && it.visibility === 'private' && !it.hidden;
    });
    if (privateCards.length > 0) {
      check('单独回答条目的分段控件选中「仅提问者可见」',
        privateCards.every((c) => c.seg[0] === 'true' && c.seg[1] === 'false'),
        JSON.stringify(privateCards.slice(0, 2).map((c) => c.seg)));
    } else {
      console.log('  skip 当前没有「仅提问者可见」的条目');
    }

    await capture(session, 'admin-panel');
  }

  group('5. 提问者回执页 /my/:token');
  // 先探一下 token 还有效没 —— 提问被删掉后旧 token 会 404，
  // 那是数据变了，不是页面坏了，应当明确跳过而不是报失败。
  const tokenStatus = PRIVATE_TOKEN
    ? await evaluate(session,
      `(async () => (await fetch('/api/my/${PRIVATE_TOKEN}')).status)()`)
    : 0;

  if (!PRIVATE_TOKEN) {
    console.log('  skip 未提供回执 token');
  } else if (tokenStatus !== 200) {
    console.log(`  skip 回执 token 已失效或提问已被删除（HTTP ${tokenStatus}）`);
    console.log('       想跑这一组，用 /my 页面上的当前有效链接里的 token 再执行一次');
  } else {
    await visit(session, `${BASE}/my/${PRIVATE_TOKEN}`);
    check('页面无 JS 报错', session.problems().length === 0, session.problems().join(' | '));

    await expectNoOverflow(session, '无横向溢出');

    const shown = await evaluate(session, `(async () => {
      const q = await (await fetch('/api/my/${PRIVATE_TOKEN}')).json();
      return {
        answered: q.question.answered,
        visibility: q.question.visibility,
        badge: document.querySelector('#qMeta .badge')?.textContent,
        detailHidden: document.getElementById('detailView').hidden,
        answerHidden: document.getElementById('answerCard').hidden,
        waitingHidden: document.getElementById('waitingCard').hidden,
        answerLen: document.getElementById('qAnswer').textContent.trim().length,
      };
    })()`);

    check('显示详情视图', shown.detailHidden === false, JSON.stringify(shown));

    if (shown.answered) {
      check('显示回答卡片', shown.answerHidden === false, JSON.stringify(shown));
      check('隐藏等待中提示', shown.waitingHidden === true, JSON.stringify(shown));
      check('回答内容非空', shown.answerLen > 0, JSON.stringify(shown));
    } else {
      check('未回答时显示等待提示', shown.waitingHidden === false, JSON.stringify(shown));
      check('未回答时隐藏回答卡片', shown.answerHidden === true, JSON.stringify(shown));
    }

    const wantBadge = !shown.answered ? '等待回答'
      : shown.visibility === 'public' ? '已公开' : '仅你可见';
    check('状态徽章与接口数据一致', shown.badge === wantBadge,
      `界面 ${shown.badge} / 期望 ${wantBadge}`);

    await capture(session, 'mine-receipt');
  }

  group('6. 移动端窄屏（360px）无溢出');
  {
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 360, height: 720, deviceScaleFactor: 2, mobile: true,
    });
    await visit(session, `${BASE}/`);
    await expectNoOverflow(session, '首页 360px 无横向溢出');

    await visit(session, `${BASE}/admin`);
    await expectNoOverflow(session, '后台 360px 无横向溢出');
    await session.send('Emulation.clearDeviceMetricsOverride');

    await session.send('Emulation.setDeviceMetricsOverride', {
      width: 1180, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await visit(session, `${BASE}/`);
    await expectNoOverflow(session, '首页桌面宽度无横向溢出');
    await capture(session, 'home-desktop');
    await session.send('Emulation.clearDeviceMetricsOverride');
  }

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log(failed === 0 ? '浏览器端全部通过 ✓' : '存在失败项 ✗');
  if (failed > 0) exitCode = 1;
} catch (err) {
  console.error(`\n浏览器验证中断：${err.message}`);
  exitCode = 1;
} finally {
  try {
    session?.ws.close();
  } catch { /* 忽略 */ }
  chrome.kill();
  await sleep(400);
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* 忽略 */ }
}

process.exit(exitCode);
