'use strict';

/* 提问墙 + 匿名提交 */
(function () {
  const STORE_KEY = 'anonask.receipts.v1';
  const PAGE_SIZE = 10;

  const $ = (id) => document.getElementById(id);

  const meta = {
    maxQuestionLength: 800,
    maxNicknameLength: 20,
    maxTagLength: 12,
  };

  let offset = 0;
  let total = 0;
  let loading = false;
  let toastTimer = null;

  /* ---------------- 基础工具 ---------------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

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
    toastTimer = window.setTimeout(() => node.classList.remove('toast--show'), 2600);
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - Number(ts);
    if (diff < 0) return '刚刚';
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

  function readReceipts() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveReceipt(token, snippet) {
    const list = readReceipts().filter((item) => item && item.token !== token);
    list.unshift({ token, snippet: String(snippet || '').slice(0, 60), at: Date.now() });
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 50)));
    } catch {
      /* 隐私模式下 localStorage 可能不可用，忽略 */
    }
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* 落到下面的兜底方案 */
    }
    const input = $('receiptUrl');
    if (input) {
      input.removeAttribute('readonly');
      input.select();
      input.setSelectionRange(0, input.value.length);
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      input.setAttribute('readonly', 'readonly');
      return ok;
    }
    return false;
  }

  /* ---------------- 渲染提问墙 ---------------- */

  function renderWallItem(item) {
    const card = el('article', 'card qa');
    if (item.pinned) card.classList.add('qa--pinned');

    const metaRow = el('div', 'qa__meta');
    metaRow.appendChild(el('span', 'qa__author', item.nickname || '匿名'));
    if (item.tag) metaRow.appendChild(el('span', 'tag', item.tag));
    if (item.pinned) metaRow.appendChild(el('span', 'badge badge--private', '置顶'));
    metaRow.appendChild(el('span', null, `回答于 ${timeAgo(item.answeredAt || item.createdAt)}`));
    card.appendChild(metaRow);

    card.appendChild(el('p', 'qa__content', item.content));
    if (item.answer) card.appendChild(el('div', 'qa__answer', item.answer));
    return card;
  }

  async function loadWall(reset) {
    if (loading) return;
    loading = true;
    const button = $('loadMore');
    button.disabled = true;

    if (reset) {
      offset = 0;
      $('wall').textContent = '';
    }

    try {
      const data = await api(`/api/questions?limit=${PAGE_SIZE}&offset=${offset}`);
      total = data.total;
      const wall = $('wall');
      for (const item of data.items) wall.appendChild(renderWallItem(item));
      offset += data.items.length;

      $('wallEmpty').hidden = total > 0;
      button.hidden = !data.hasMore;
    } catch (err) {
      toast(err.message, true);
    } finally {
      loading = false;
      button.disabled = false;
      button.textContent = '加载更多';
    }
  }

  /* ---------------- 提交 ---------------- */

  function updateCounter(input, counter, max) {
    const length = input.value.length;
    counter.textContent = `${length} / ${max}`;
    counter.classList.toggle('counter--over', length > max);
  }

  function showFormError(message) {
    const box = $('formError');
    box.textContent = message;
    box.hidden = !message;
  }

  async function onSubmit(event) {
    event.preventDefault();
    showFormError('');

    const content = $('content').value.trim();
    if (!content) {
      showFormError('先写点什么吧。');
      $('content').focus();
      return;
    }
    if (content.length > meta.maxQuestionLength) {
      showFormError(`问题最多 ${meta.maxQuestionLength} 个字，现在有 ${content.length} 个。`);
      return;
    }

    const button = $('submitBtn');
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '提交中…';

    try {
      const data = await api('/api/questions', {
        method: 'POST',
        body: {
          content,
          nickname: $('nickname').value.trim(),
          tag: $('tag').value.trim(),
          website: $('website').value,
        },
      });

      const url = new URL(data.receiptUrl, location.origin).href;
      $('receiptUrl').value = url;
      $('receiptOpen').href = data.receiptUrl;
      $('receipt').hidden = false;

      saveReceipt(data.token, content);

      $('askForm').reset();
      updateCounter($('content'), $('contentCounter'), meta.maxQuestionLength);
      toast('提交成功，回执链接已生成');
      $('receipt').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      showFormError(err.message);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    try {
      const data = await api('/api/meta');
      Object.assign(meta, data);
      document.title = data.siteName;
      $('siteName').textContent = data.siteName;
      $('siteDesc').textContent = data.siteDesc;
      $('content').maxLength = data.maxQuestionLength;
      $('nickname').maxLength = data.maxNicknameLength;
      $('tag').maxLength = data.maxTagLength;
      updateCounter($('content'), $('contentCounter'), data.maxQuestionLength);
    } catch {
      updateCounter($('content'), $('contentCounter'), meta.maxQuestionLength);
    }

    $('askForm').addEventListener('submit', onSubmit);
    $('content').addEventListener('input', () =>
      updateCounter($('content'), $('contentCounter'), meta.maxQuestionLength),
    );
    $('copyBtn').addEventListener('click', async () => {
      const ok = await copyText($('receiptUrl').value);
      toast(ok ? '已复制回执链接' : '复制失败，请长按手动复制', !ok);
    });
    $('loadMore').addEventListener('click', () => loadWall(false));

    await loadWall(true);

    // 供自动化测试判断「首屏加载完成」的标记（对用户无影响）
    document.documentElement.dataset.ready = '1';
  }

  init();
})();
