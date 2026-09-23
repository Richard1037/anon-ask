'use strict';

/**
 * 配置加载器。
 * 首次启动时会自动补齐密钥（sessionSecret / ipSalt），
 * 并把 config.json 里的明文 adminPassword 就地转成 scrypt 哈希后回写。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const auth = require('./auth');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = process.env.ANON_ASK_CONFIG || path.join(ROOT, 'config.json');

const DEFAULTS = {
  siteName: '匿名提问箱',
  siteDesc: '有什么想问的，匿名写下来吧。',
  ownerName: '站长',
  port: 8080,
  host: '0.0.0.0',
  trustProxy: false,
  sessionDays: 7,
  maxQuestionLength: 800,
  maxFollowupLength: 500,
  maxAnswerLength: 4000,
  maxNicknameLength: 20,
  maxTagLength: 12,
  rateLimit: {
    submitPerMinute: 3,
    submitPerDay: 50,
    loginPerTenMinutes: 5,
    followupPerMinute: 5,
    followupPerDay: 30,
  },
  adminPassword: null,
  adminPasswordHash: null,
  sessionSecret: null,
  ipSalt: null,
};

function readFileConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`config.json 解析失败：${err.message}`);
    }
  }
  return {};
}

function load() {
  const fromFile = readFileConfig();
  const cfg = {
    ...DEFAULTS,
    ...fromFile,
    rateLimit: { ...DEFAULTS.rateLimit, ...(fromFile.rateLimit || {}) },
  };

  const notices = [];
  let dirty = false;

  if (!cfg.sessionSecret) {
    cfg.sessionSecret = crypto.randomBytes(32).toString('hex');
    dirty = true;
    notices.push('已生成新的 sessionSecret');
  }
  if (!cfg.ipSalt) {
    cfg.ipSalt = crypto.randomBytes(16).toString('hex');
    dirty = true;
    notices.push('已生成新的 ipSalt');
  }

  // 用户手写明文口令 → 立刻转哈希，并把明文从磁盘上抹掉。
  if (typeof cfg.adminPassword === 'string' && cfg.adminPassword.length > 0) {
    cfg.adminPasswordHash = auth.hashPassword(cfg.adminPassword);
    delete cfg.adminPassword;
    dirty = true;
    notices.push('adminPassword 已转换为 scrypt 哈希并回写');
  } else if (cfg.adminPassword !== undefined && cfg.adminPassword !== null) {
    delete cfg.adminPassword;
    dirty = true;
  }

  let generatedPassword = null;
  if (!cfg.adminPasswordHash) {
    generatedPassword = `askbox-${crypto.randomBytes(5).toString('hex')}`;
    cfg.adminPasswordHash = auth.hashPassword(generatedPassword);
    dirty = true;
    notices.push('配置里没有口令，已自动生成一个');
  }

  // 数值兜底，避免配置文件被改坏后出现 NaN 扩散。
  cfg.port = clampInt(cfg.port, 1, 65535, DEFAULTS.port);
  cfg.sessionDays = clampInt(cfg.sessionDays, 1, 365, DEFAULTS.sessionDays);
  cfg.maxQuestionLength = clampInt(cfg.maxQuestionLength, 10, 10000, DEFAULTS.maxQuestionLength);
  cfg.maxFollowupLength = clampInt(cfg.maxFollowupLength, 10, 10000, DEFAULTS.maxFollowupLength);
  cfg.maxAnswerLength = clampInt(cfg.maxAnswerLength, 10, 50000, DEFAULTS.maxAnswerLength);
  cfg.maxNicknameLength = clampInt(cfg.maxNicknameLength, 0, 100, DEFAULTS.maxNicknameLength);
  cfg.maxTagLength = clampInt(cfg.maxTagLength, 0, 100, DEFAULTS.maxTagLength);
  cfg.trustProxy = cfg.trustProxy === true;
  cfg.siteName = String(cfg.siteName || DEFAULTS.siteName).slice(0, 60);
  cfg.siteDesc = String(cfg.siteDesc || '').slice(0, 300);
  cfg.ownerName = String(cfg.ownerName || DEFAULTS.ownerName).slice(0, 40);

  if (dirty) {
    try {
      fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    } catch (err) {
      console.warn(`[warn] config.json 回写失败（不影响运行）：${err.message}`);
    }
  }

  return { cfg, notices, generatedPassword, configPath: CONFIG_PATH };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

module.exports = { load, CONFIG_PATH, ROOT };
