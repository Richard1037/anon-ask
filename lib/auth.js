'use strict';

/**
 * 口令派生（scrypt）+ 会话签名（HMAC-SHA256）+ IP 哈希。
 * 全部基于 Node 内置 crypto，没有任何第三方依赖。
 */

const crypto = require('node:crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptOptions(N, r, p) {
  return { N, r, p, maxmem: 128 * N * r * 2 };
}

/** 生成 `scrypt$N$r$p$salt$hash` 形式的可存储字符串。 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(
    Buffer.from(String(password), 'utf8'),
    salt,
    SCRYPT.keylen,
    scryptOptions(SCRYPT.N, SCRYPT.r, SCRYPT.p),
  );
  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/** 恒定时间校验，参数被篡改时一律返回 false 而不是抛错。 */
function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || typeof password !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (N < 1024 || N > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let actual;
  try {
    actual = crypto.scryptSync(
      Buffer.from(password, 'utf8'),
      salt,
      expected.length,
      scryptOptions(N, r, p),
    );
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

/** 会话令牌 = base64url(payload).hmac，服务端不保存任何会话状态。 */
function signSession(secret, ttlSeconds, now = Date.now()) {
  const payload = Buffer.from(
    JSON.stringify({ exp: Math.floor(now / 1000) + ttlSeconds, n: crypto.randomBytes(9).toString('hex') }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${hmac(secret, payload)}`;
}

function verifySession(token, secret, ttlSeconds) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 4096) return false;
  const i = token.lastIndexOf('.');
  if (i <= 0) return false;

  const payload = token.slice(0, i);
  const signature = token.slice(i + 1);
  const expected = hmac(secret, payload);

  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed.exp !== 'number') return false;
  if (parsed.exp * 1000 <= Date.now()) return false;
  if (ttlSeconds && parsed.exp * 1000 > Date.now() + ttlSeconds * 1000 + 60_000) return false;
  return true;
}

/** IP 只以加盐 HMAC 形式参与限流，绝不保存明文。 */
function hashIp(ip, salt) {
  return crypto.createHmac('sha256', salt).update(String(ip)).digest('hex').slice(0, 32);
}

/** 恒定时间字符串比较，用于 token 之类的高熵短串。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { hashPassword, verifyPassword, signSession, verifySession, hashIp, safeEqual };
