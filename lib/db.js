'use strict';

/**
 * 数据层：Node 内置 node:sqlite，单文件数据库，零外部依赖。
 */

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.ANON_ASK_DATA || path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.ANON_ASK_DB || path.join(DATA_DIR, 'app.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS questions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id     TEXT    NOT NULL UNIQUE,
    token         TEXT    NOT NULL UNIQUE,
    content       TEXT    NOT NULL,
    nickname      TEXT    NOT NULL DEFAULT '',
    tag           TEXT    NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    ip_hash       TEXT    NOT NULL DEFAULT '',
    answer        TEXT,
    answered_at   INTEGER,
    visibility    TEXT    NOT NULL DEFAULT 'private',
    pinned        INTEGER NOT NULL DEFAULT 0,
    hidden        INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_questions_wall
    ON questions (visibility, hidden, pinned, answered_at);
  CREATE INDEX IF NOT EXISTS idx_questions_created
    ON questions (created_at DESC);

  CREATE TABLE IF NOT EXISTS followups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    content     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_followups_question
    ON followups (question_id, created_at);
`);

const MAX_FOLLOWUPS_PER_QUESTION = 20;

const stmt = {
  insertQuestion: db.prepare(`
    INSERT INTO questions (public_id, token, content, nickname, tag, created_at, ip_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  byToken: db.prepare('SELECT * FROM questions WHERE token = ?'),
  byPublicId: db.prepare('SELECT * FROM questions WHERE public_id = ?'),
  byId: db.prepare('SELECT * FROM questions WHERE id = ?'),

  listPublic: db.prepare(`
    SELECT * FROM questions
    WHERE visibility = 'public'
      AND hidden = 0
      AND answer IS NOT NULL
      AND TRIM(answer) <> ''
    ORDER BY pinned DESC, COALESCE(answered_at, created_at) DESC, id DESC
    LIMIT ? OFFSET ?
  `),
  countPublic: db.prepare(`
    SELECT COUNT(*) AS n FROM questions
    WHERE visibility = 'public' AND hidden = 0
      AND answer IS NOT NULL AND TRIM(answer) <> ''
  `),

  saveAnswer: db.prepare(`
    UPDATE questions
    SET answer = ?, answered_at = ?, visibility = ?
    WHERE id = ?
  `),
  clearAnswer: db.prepare(`
    UPDATE questions SET answer = NULL, answered_at = NULL, visibility = 'private' WHERE id = ?
  `),
  setPinned: db.prepare('UPDATE questions SET pinned = ? WHERE id = ?'),
  setHidden: db.prepare('UPDATE questions SET hidden = ? WHERE id = ?'),
  deleteQuestion: db.prepare('DELETE FROM questions WHERE id = ?'),

  insertFollowup: db.prepare(
    'INSERT INTO followups (question_id, content, created_at) VALUES (?, ?, ?)',
  ),
  listFollowups: db.prepare(
    'SELECT id, content, created_at FROM followups WHERE question_id = ? ORDER BY id ASC',
  ),
  countFollowups: db.prepare('SELECT COUNT(*) AS n FROM followups WHERE question_id = ?'),
  followupCounts: db.prepare(`
    SELECT question_id, COUNT(*) AS n FROM followups
    WHERE question_id IN (SELECT value FROM json_each(?))
    GROUP BY question_id
  `),

  stats: db.prepare(`
    SELECT
      COUNT(*)                                                                    AS total,
      COALESCE(SUM(answer IS NULL), 0)                                            AS unanswered,
      COALESCE(SUM(answer IS NOT NULL AND TRIM(answer) <> '' AND visibility = 'public' AND hidden = 0), 0) AS published,
      COALESCE(SUM(answer IS NOT NULL AND TRIM(answer) <> '' AND visibility = 'private'), 0)              AS private_count,
      COALESCE(SUM(hidden = 1), 0)                                                AS hidden,
      COALESCE(SUM(created_at >= ?), 0)                                           AS today
    FROM questions
  `),
};

function newPublicId() {
  return crypto.randomBytes(5).toString('hex');
}

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function now() {
  return Date.now();
}

function isAnswered(row) {
  return Boolean(row.answer && row.answer.trim() !== '');
}

function createQuestion({ content, nickname = '', tag = '', ipHash = '', at = now() }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const publicId = newPublicId();
    const token = newToken();
    try {
      const info = stmt.insertQuestion.run(
        publicId,
        token,
        content,
        nickname,
        tag,
        at,
        ipHash,
      );
      return { id: Number(info.lastInsertRowid), publicId, token };
    } catch (err) {
      if (!/UNIQUE/i.test(String(err.message))) throw err;
    }
  }
  throw new Error('无法生成唯一 ID，请重试');
}

/** 公开墙上的条目。 */
function toWallItem(row) {
  return {
    id: row.public_id,
    content: row.content,
    nickname: row.nickname || '',
    tag: row.tag || '',
    answer: row.answer,
    answeredAt: row.answered_at,
    createdAt: row.created_at,
    pinned: Boolean(row.pinned),
  };
}

/** 管理后台看到的完整条目。 */
function toAdminItem(row, followupCount = 0) {
  return {
    id: row.public_id,
    content: row.content,
    nickname: row.nickname || '',
    tag: row.tag || '',
    answer: row.answer || '',
    answeredAt: row.answered_at,
    createdAt: row.created_at,
    visibility: row.visibility,
    pinned: Boolean(row.pinned),
    hidden: Boolean(row.hidden),
    answered: isAnswered(row),
    followupCount,
  };
}

/** 提问者凭 token 看到的自己的条目。 */
function toOwnerItem(row, followups = []) {
  const answered = isAnswered(row);
  return {
    id: row.public_id,
    content: row.content,
    nickname: row.nickname || '',
    tag: row.tag || '',
    createdAt: row.created_at,
    answered,
    answer: answered ? row.answer : '',
    answeredAt: row.answered_at,
    visibility: answered ? row.visibility : 'private',
    published: answered && row.visibility === 'public' && !row.hidden,
    hidden: Boolean(row.hidden),
    followups: followups.map((f) => ({
      id: f.id,
      content: f.content,
      createdAt: f.created_at,
    })),
  };
}

function listPublic({ limit = 10, offset = 0 } = {}) {
  const rows = stmt.listPublic.all(limit, offset);
  const total = Number(stmt.countPublic.get().n);
  return { items: rows.map(toWallItem), total, limit, offset };
}

const FILTERS = {
  all: '1 = 1',
  unanswered: "answer IS NULL AND hidden = 0",
  published: "answer IS NOT NULL AND TRIM(answer) <> '' AND visibility = 'public' AND hidden = 0",
  private: "answer IS NOT NULL AND TRIM(answer) <> '' AND visibility = 'private' AND hidden = 0",
  hidden: 'hidden = 1',
};

function listAdmin({ filter = 'all', search = '', limit = 50, offset = 0 } = {}) {
  const where = [FILTERS[filter] || FILTERS.all];
  const params = [];
  if (search) {
    where.push('(content LIKE ? OR answer LIKE ? OR nickname LIKE ? OR tag LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const clause = where.join(' AND ');

  const rows = db
    .prepare(
      `SELECT * FROM questions WHERE ${clause}
       ORDER BY hidden ASC, (answer IS NULL) DESC, pinned DESC, created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);

  const total = Number(
    db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE ${clause}`).get(...params).n,
  );

  let counts = new Map();
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    const found = stmt.followupCounts.all(JSON.stringify(ids));
    counts = new Map(found.map((r) => [Number(r.question_id), Number(r.n)]));
  }

  return {
    items: rows.map((r) => toAdminItem(r, counts.get(Number(r.id)) || 0)),
    total,
    limit,
    offset,
  };
}

function getByToken(token) {
  const row = stmt.byToken.get(String(token));
  if (!row) return null;
  return toOwnerItem(row, stmt.listFollowups.all(row.id));
}

function getRawByToken(token) {
  return stmt.byToken.get(String(token)) || null;
}

function getRawByPublicId(publicId) {
  return stmt.byPublicId.get(String(publicId)) || null;
}

function saveAnswer(publicId, answer, visibility) {
  const row = stmt.byPublicId.get(String(publicId));
  if (!row) return null;
  const trimmed = String(answer ?? '').trim();
  if (trimmed === '') {
    stmt.clearAnswer.run(row.id);
  } else {
    const vis = visibility === 'public' ? 'public' : 'private';
    const answeredAt = isAnswered(row) && row.answered_at ? row.answered_at : now();
    stmt.saveAnswer.run(trimmed, answeredAt, vis, row.id);
  }
  const updated = stmt.byId.get(row.id);
  return toAdminItem(updated, Number(stmt.countFollowups.get(row.id).n));
}

function setPinned(publicId, pinned) {
  const row = stmt.byPublicId.get(String(publicId));
  if (!row) return null;
  stmt.setPinned.run(pinned ? 1 : 0, row.id);
  return toAdminItem(stmt.byId.get(row.id), Number(stmt.countFollowups.get(row.id).n));
}

function setHidden(publicId, hidden) {
  const row = stmt.byPublicId.get(String(publicId));
  if (!row) return null;
  stmt.setHidden.run(hidden ? 1 : 0, row.id);
  return toAdminItem(stmt.byId.get(row.id), Number(stmt.countFollowups.get(row.id).n));
}

function deleteQuestion(publicId) {
  const row = stmt.byPublicId.get(String(publicId));
  if (!row) return false;
  stmt.deleteQuestion.run(row.id);
  return true;
}

function addFollowup(token, content) {
  const row = stmt.byToken.get(String(token));
  if (!row) return { error: 'not_found' };
  const count = Number(stmt.countFollowups.get(row.id).n);
  if (count >= MAX_FOLLOWUPS_PER_QUESTION) return { error: 'too_many' };
  stmt.insertFollowup.run(row.id, content, now());
  return { ok: true, question: toOwnerItem(stmt.byId.get(row.id), stmt.listFollowups.all(row.id)) };
}

function getStats() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const row = stmt.stats.get(startOfDay.getTime());
  return {
    total: Number(row.total),
    unanswered: Number(row.unanswered),
    published: Number(row.published),
    private: Number(row.private_count),
    hidden: Number(row.hidden),
    today: Number(row.today),
  };
}

module.exports = {
  db,
  DB_PATH,
  DATA_DIR,
  MAX_FOLLOWUPS_PER_QUESTION,
  createQuestion,
  getByToken,
  getRawByToken,
  getRawByPublicId,
  listPublic,
  listAdmin,
  saveAnswer,
  setPinned,
  setHidden,
  deleteQuestion,
  addFollowup,
  getStats,
};
