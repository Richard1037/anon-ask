'use strict';

/* 管理后台：审核、回答、公开/私密、置顶、隐藏、删除 */
(function () {
  const $ = (id) => document.getElementById(id);
  const PAGE_SIZE = 30;

  const state = {
    filter: 'unanswered',
    search: '',
    offset: 0,
    loading: false,
    maxAnswerLength: 4000,
  };

  const cards = new Map();
  let toastTimer = null;
  let searchTimer = null;
  let siteMeta = null;

  /* ---------------- 基础 ---------------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  class Unauthorized extends Error {}

  async function api(path, { method = 'GET', body } = {}) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (res.status === 401) throw new Unauthorized((data && data.error) || '未登录');
    if (!res.ok) {
      const error = new Error((data && data.error) || `请求失败（${res.status}）`);
      error.status = res.status;
      throw error;
    }
    return data;
  }

  function toast(message, isError) {
    const node = $('toast');
    node.textContent = message;
    node.classList.toggle('toast--error', Boolean(isError));
    node.classList.add('toast--show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => node.classList.remove('toast--show'), 2400);
  }

  function panelError(message) {
    const box = $('panelError');
    box.textContent = message || '';
    box.hidden = !message;
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - Number(ts);
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return '刚刚';
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
    const d = new Date(Number(ts));
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function statusOf(item) {
    if (item.hidden) return { cls: 'badge--hidden', text: '已隐藏' };
    if (!item.answered) return { cls: 'badge--new', text: '待回答' };
    if (item.visibility === 'public') return { cls: 'badge--public', text: '已公开' };
    return { cls: 'badge--private', text: '仅提问者可见' };
  }

  function matchesFilter(item, filter) {
    switch (filter) {
      case 'unanswered': return !item.answered && !item.hidden;
      case 'published': return item.answered && item.visibility === 'public' && !item.hidden;
      case 'private': return item.answered && item.visibility === 'private' && !item.hidden;
      case 'hidden': return item.hidden;
      default: return true;
    }
  }

  /* ---------------- 统计 ---------------- */

  function renderStats(stats) {
    if (!stats) return;
    const box = $('stats');
    box.textContent = '';
    const entries = [
      ['待回答', stats.unanswered],
      ['已公开', stats.published],
      ['仅提问者可见', stats.private],
      ['已隐藏', stats.hidden],
      ['总计', stats.total],
      ['今天新增', stats.today],
    ];
    for (const [key, value] of entries) {
      const node = el('div', 'stat');
      node.appendChild(el('span', 'stat__n', value));
      node.appendChild(el('span', 'stat__k', key));
      box.appendChild(node);
    }
  }

  /* ---------------- 卡片 ---------------- */

  function buildCard(initial) {
    let current = { ...initial };
    let visibility = current.answered && current.visibility === 'public' ? 'public' : 'private';

    const card = el('article', 'card qcard');
    card.dataset.id = current.id;

    const head = el('div', 'qcard__head');
    head.appendChild(el('span', null, `#${current.id}`));
    head.appendChild(el('span', 'qa__author', current.nickname || '匿名'));
    const tagNode = el('span', 'tag', current.tag || '');
    if (current.tag) head.appendChild(tagNode);
    head.appendChild(el('span', null, `提问于 ${timeAgo(current.createdAt)}`));
    const badge = el('span', 'badge');
    head.appendChild(badge);
    const pinBadge = el('span', 'badge badge--private', '置顶');
    head.appendChild(pinBadge);
    card.appendChild(head);

    card.appendChild(el('p', 'qcard__content', current.content));

    const followups = el('div', 'followups');
    card.appendChild(followups);

    const tools = el('div', 'qcard__tools');

    const textarea = el('textarea', 'textarea');
    textarea.rows = 3;
    textarea.placeholder = '写下你的回答…（清空后保存 = 撤销回答）';
    textarea.value = current.answer || '';
    textarea.maxLength = state.maxAnswerLength;
    tools.appendChild(textarea);

    const counter = el('div', 'counter');
    tools.appendChild(counter);

    const rows = el('div', 'btn-row');

    const seg = el('div', 'seg');
    seg.setAttribute('role', 'group');
    const segPrivate = el('button', null, '仅提问者可见');
    const segPublic = el('button', null, '公开到提问墙');
    segPrivate.type = 'button';
    segPublic.type = 'button';
    seg.appendChild(segPrivate);
    seg.appendChild(segPublic);
    rows.appendChild(seg);
    rows.appendChild(el('div', 'spacer'));

    const saveBtn = el('button', 'btn btn--sm btn--primary', '保存回答');
    const pinBtn = el('button', 'btn btn--sm', '置顶');
    const hideBtn = el('button', 'btn btn--sm', '隐藏');
    const deleteBtn = el('button', 'btn btn--sm btn--danger', '删除');
    for (const b of [saveBtn, pinBtn, hideBtn, deleteBtn]) {
      b.type = 'button';
      rows.appendChild(b);
    }
    tools.appendChild(rows);
    tools.appendChild(el('p', 'hint',
      '「公开到提问墙」任何人都能看到这条问答；「仅提问者可见」则只有拿着回执链接的人能看到。'));
    card.appendChild(tools);

    /* --- 绘制 --- */

    function paintSeg() {
      segPrivate.setAttribute('aria-pressed', String(visibility !== 'public'));
      segPublic.setAttribute('aria-pressed', String(visibility === 'public'));
    }

    function paintCounter() {
      counter.textContent = `${textarea.value.length} / ${state.maxAnswerLength}`;
      counter.classList.toggle('counter--over', textarea.value.length > state.maxAnswerLength);
    }

    function paintBadge() {
      const status = statusOf(current);
      badge.className = `badge ${status.cls}`;
      badge.textContent = status.text;
      card.classList.toggle('qcard--hidden', Boolean(current.hidden));
      pinBadge.hidden = !current.pinned;
      pinBtn.textContent = current.pinned ? '取消置顶' : '置顶';
      hideBtn.textContent = current.hidden ? '取消隐藏' : '隐藏';
    }

    function paintFollowups() {
      const list = current.followups || [];
      followups.textContent = '';
      if (list.length === 0) {
        followups.hidden = true;
        return;
      }
      followups.hidden = false;
      followups.appendChild(el('span', 'followups__label', `提问者的补充（${list.length}）`));
      for (const f of list) {
        const row = el('div', 'followups__item');
        row.appendChild(el('span', null, f.content));
        row.appendChild(el('span', 'hint', ` · ${timeAgo(f.createdAt)}`));
        followups.appendChild(row);
      }
    }

    function setBusy(busy) {
      for (const b of [saveBtn, pinBtn, hideBtn, deleteBtn, segPrivate, segPublic]) b.disabled = busy;
    }

    function absorb(target) {
      current = { ...current, ...target };
      visibility = current.answered && current.visibility === 'public' ? 'public' : 'private';
      paintSeg();
      paintBadge();
      if (typeof target.answer === 'string' && document.activeElement !== textarea) {
        textarea.value = target.answer;
      }
      paintCounter();
      if (target.followups) paintFollowups();
    }

    async function patch(payload) {
      setBusy(true);
      panelError('');
      try {
        const data = await api(`/api/admin/questions/${encodeURIComponent(current.id)}`, {
          method: 'PATCH',
          body: payload,
        });
        if (data.item) absorb(data.item);
        renderStats(data.stats);
        if (!matchesFilter(current, state.filter)) removeCard(current.id);
        return true;
      } catch (err) {
        if (err instanceof Unauthorized) {
          showLogin();
          return false;
        }
        panelError(err.message);
        return false;
      } finally {
        setBusy(false);
      }
    }

    /* --- 事件 --- */

    segPrivate.addEventListener('click', () => { visibility = 'private'; paintSeg(); });
    segPublic.addEventListener('click', () => { visibility = 'public'; paintSeg(); });
    textarea.addEventListener('input', paintCounter);

    saveBtn.addEventListener('click', () => {
      const answer = textarea.value.trim();
      if (answer === '' && current.answered) {
        if (!window.confirm('清空回答？这条提问会回到「待回答」，并且不再公开。')) return;
      }
      const wasPublic = visibility === 'public';
      patch({ answer, visibility }).then((ok) => {
        if (!ok) return;
        if (answer === '') toast('回答已撤销');
        else toast(wasPublic ? '已公开回答' : '已单独回答提问者');
      });
    });

    pinBtn.addEventListener('click', () => {
      patch({ pinned: !current.pinned }).then((ok) => {
        if (ok) toast(current.pinned ? '已置顶' : '已取消置顶');
      });
    });

    hideBtn.addEventListener('click', () => {
      patch({ hidden: !current.hidden }).then((ok) => {
        if (ok) toast(current.hidden ? '已隐藏' : '已恢复显示');
      });
    });

    deleteBtn.addEventListener('click', async () => {
      if (!window.confirm('彻底删除这条提问？此操作不可恢复。')) return;
      setBusy(true);
      panelError('');
      try {
        const data = await api(`/api/admin/questions/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
        removeCard(current.id);
        renderStats(data.stats);
        toast('已删除');
      } catch (err) {
        if (err instanceof Unauthorized) showLogin();
        else panelError(err.message);
      } finally {
        setBusy(false);
      }
    });

    paintSeg();
    paintCounter();
    paintBadge();
    paintFollowups();

    return card;
  }

  function removeCard(id) {
    const card = cards.get(id);
    if (!card) return;
    card.remove();
    cards.delete(id);
    updateEmptyState();
  }

  function updateEmptyState() {
    $('listEmpty').hidden = cards.size > 0;
  }

  /* ---------------- 列表 ---------------- */

  async function loadList(reset) {
    if (state.loading) return;
    state.loading = true;
    const button = $('loadMore');
    button.disabled = true;

    if (reset) {
      state.offset = 0;
      cards.clear();
      $('list').textContent = '';
    }

    const params = new URLSearchParams({
      filter: state.filter,
      limit: String(PAGE_SIZE),
      offset: String(state.offset),
    });
    if (state.search) params.set('q', state.search);

    try {
      const data = await api(`/api/admin/questions?${params.toString()}`);
      const list = $('list');
      for (const item of data.items) {
        const card = buildCard(item);
        cards.set(item.id, card);
        list.appendChild(card);
      }
      state.offset += data.items.length;
      renderStats(data.stats);
      button.hidden = !data.hasMore;
      panelError('');
    } catch (err) {
      if (err instanceof Unauthorized) {
        showLogin();
        return;
      }
      panelError(err.message);
    } finally {
      state.loading = false;
      button.disabled = false;
      updateEmptyState();
    }
  }

  /* ---------------- 视图切换 ---------------- */

  function showLogin() {
    $('panelView').hidden = true;
    $('loginView').hidden = false;
    $('password').focus();
  }

  function showPanel() {
    state.maxAnswerLength = (siteMeta && siteMeta.maxAnswerLength) || 4000;
    $('loginView').hidden = true;
    $('panelView').hidden = false;
    if (siteMeta) document.title = `管理后台 · ${siteMeta.siteName}`;
  }

  async function onLogin(event) {
    event.preventDefault();
    const box = $('loginError');
    box.hidden = true;

    const password = $('password').value;
    if (!password) {
      box.textContent = '请输入口令';
      box.hidden = false;
      return;
    }

    const button = $('loginBtn');
    button.disabled = true;
    button.textContent = '登录中…';

    try {
      await api('/api/admin/login', { method: 'POST', body: { password } });
      $('password').value = '';
      showPanel();
      await loadList(true);
    } catch (err) {
      box.textContent = err.message;
      box.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = '登录';
    }
  }

  /** 让筛选标签的高亮始终跟着 state.filter 走，避免和 HTML 默认值不一致。 */
  function syncChips() {
    for (const chip of $('filters').querySelectorAll('.chip')) {
      chip.setAttribute('aria-pressed', String(chip.dataset.filter === state.filter));
    }
  }

  function setFilter(filter) {
    if (state.filter === filter) return;
    state.filter = filter;
    syncChips();
    loadList(true);
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    for (const chip of $('filters').querySelectorAll('.chip')) {
      chip.addEventListener('click', () => setFilter(chip.dataset.filter));
    }
    syncChips();

    $('loginForm').addEventListener('submit', onLogin);
    $('refreshBtn').addEventListener('click', () => loadList(true));
    $('loadMore').addEventListener('click', () => loadList(false));

    $('logoutBtn').addEventListener('click', async () => {
      try {
        await api('/api/admin/logout', { method: 'POST' });
      } catch { /* 忽略 */ }
      showLogin();
      toast('已退出登录');
    });

    $('search').addEventListener('input', (event) => {
      const value = event.target.value.trim();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        state.search = value;
        loadList(true);
      }, 300);
    });

    try {
      siteMeta = await api('/api/meta');
    } catch { /* 忽略 */ }

    try {
      const session = await api('/api/admin/session');
      if (session && session.authed) {
        showPanel();
        renderStats(session.stats);
        await loadList(true);
        document.documentElement.dataset.ready = '1';
        return;
      }
    } catch (err) {
      if (!(err instanceof Unauthorized)) panelError(err.message);
    }
    showLogin();

    // 供自动化测试判断「首屏加载完成」的标记（对用户无影响）
    document.documentElement.dataset.ready = '1';
  }

  init();
})();
