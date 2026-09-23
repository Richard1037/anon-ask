'use strict';

/* 提问者回执页：查看回答、追加补充 */
(function () {
  const STORE_KEY = 'anonask.receipts.v1';
  const $ = (id) => document.getElementById(id);
  const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

  let token = null;
  let toastTimer = null;
  let maxFollowupLength = 500;

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
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < minute) return '刚刚';
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    return `${Math.floor(diff / day)} 天前`;
  }

  function showError(message) {
    const box = $('pageError');
    box.textContent = message;
    box.hidden = !message;
  }

  function readReceipts() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
      return Array.isArray(parsed) ? parsed.filter((x) => x && TOKEN_RE.test(String(x.token))) : [];
    } catch {
      return [];
    }
  }

  /* ---------------- 历史列表 ---------------- */

  function renderHistory() {
    const items = readReceipts();
    const list = $('historyList');
    list.textContent = '';
    $('historyEmpty').hidden = items.length > 0;

    for (const item of items) {
      const button = el('button', 'history__item');
      button.type = 'button';
      button.appendChild(el('span', 'qa__author', item.snippet || '（无内容）'));
      button.appendChild(el('span', 'history__snippet', `${timeAgo(item.at)}提交`));
      button.addEventListener('click', () => {
        location.href = `/my/${item.token}`;
      });
      list.appendChild(button);
    }
  }

  /* ---------------- 详情 ---------------- */

  function renderQuestion(question) {
    const metaRow = $('qMeta');
    metaRow.textContent = '';
    metaRow.appendChild(el('span', 'qa__author', question.nickname || '匿名'));
    if (question.tag) metaRow.appendChild(el('span', 'tag', question.tag));
    metaRow.appendChild(el('span', null, `${timeAgo(question.createdAt)}提交`));

    if (question.published) {
      metaRow.appendChild(el('span', 'badge badge--public', '已公开'));
    } else if (question.answered) {
      metaRow.appendChild(el('span', 'badge badge--private', '仅你可见'));
    } else {
      metaRow.appendChild(el('span', 'badge badge--new', '等待回答'));
    }

    $('qContent').textContent = question.content;

    const followups = $('qFollowups');
    followups.textContent = '';
    if (question.followups && question.followups.length > 0) {
      followups.hidden = false;
      followups.appendChild(el('span', 'followups__label', '我的补充'));
      for (const f of question.followups) {
        const row = el('div', 'followups__item');
        row.appendChild(el('span', null, f.content));
        row.appendChild(el('span', 'hint', ` · ${timeAgo(f.createdAt)}`));
        followups.appendChild(row);
      }
    } else {
      followups.hidden = true;
    }

    if (question.answered) {
      $('answerCard').hidden = false;
      $('waitingCard').hidden = true;
      $('qAnswer').textContent = question.answer;
    } else {
      $('answerCard').hidden = true;
      $('waitingCard').hidden = false;
    }

    const info = $('pageInfo');
    if (question.answered && question.published) {
      info.textContent = '这条提问已经被公开回答，任何人都能在提问墙上看到。';
      info.hidden = false;
    } else if (question.answered) {
      info.textContent = '站长选择了单独回答你 —— 只有拿着这条链接的人能看到下面的内容，请不要把链接转发给别人。';
      info.hidden = false;
    } else {
      info.hidden = true;
    }
  }

  async function load(tokenValue) {
    token = tokenValue;
    $('historyView').hidden = true;
    $('detailView').hidden = false;
    try {
      const data = await api(`/api/my/${encodeURIComponent(token)}`);
      renderQuestion(data.question);
      document.title = '我的提问 · 匿名提问箱';
    } catch (err) {
      showError(err.message);
      $('detailView').hidden = true;
      $('historyView').hidden = false;
      renderHistory();
    }
  }

  function updateCounter() {
    const input = $('followupContent');
    const counter = $('followupCounter');
    counter.textContent = `${input.value.length} / ${maxFollowupLength}`;
    counter.classList.toggle('counter--over', input.value.length > maxFollowupLength);
  }

  async function onFollowup(event) {
    event.preventDefault();
    const box = $('followupError');
    box.hidden = true;

    const content = $('followupContent').value.trim();
    if (!content) {
      box.textContent = '先写点内容吧。';
      box.hidden = false;
      return;
    }

    const button = $('followupBtn');
    button.disabled = true;
    const original = button.textContent;
    button.textContent = '提交中…';

    try {
      const data = await api(`/api/my/${encodeURIComponent(token)}/followup`, {
        method: 'POST',
        body: { content },
      });
      renderQuestion(data.question);
      $('followupForm').reset();
      updateCounter();
      toast('补充已提交');
    } catch (err) {
      box.textContent = err.message;
      box.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  async function init() {
    try {
      const data = await api('/api/meta');
      maxFollowupLength = data.maxFollowupLength || 500;
      $('followupContent').maxLength = maxFollowupLength;
    } catch {
      /* 用默认值 */
    }
    updateCounter();
    $('followupContent').addEventListener('input', updateCounter);
    $('followupForm').addEventListener('submit', onFollowup);

    const parts = location.pathname.split('/').filter(Boolean);
    const candidate = parts[1];
    if (parts[0] === 'my' && candidate && TOKEN_RE.test(candidate)) {
      await load(candidate);
    } else {
      $('detailView').hidden = true;
      $('historyView').hidden = false;
      $('pageInfo').hidden = true;
      renderHistory();
    }

    // 供自动化测试判断「首屏加载完成」的标记（对用户无影响）
    document.documentElement.dataset.ready = '1';
  }

  init();
})();
