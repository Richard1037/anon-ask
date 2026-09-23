'use strict';

/**
 * 客户端 IP 的提取与归一化。
 *
 * 抽成独立模块是为了能单独测试 —— 这段逻辑一旦出错，后果是限流静默失效，
 * 而限流失效在界面上完全看不出来。
 */

function isLoopbackAddress(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** 把 IPv6 展开成 8 组（处理 `::` 缩写），便于取前缀。 */
function expandIpv6(addr) {
  const zone = addr.indexOf('%');
  const clean = zone >= 0 ? addr.slice(0, zone) : addr;
  const gap = clean.indexOf('::');

  if (gap < 0) return clean.split(':');

  const left = clean.slice(0, gap).split(':').filter(Boolean);
  const right = clean.slice(gap + 2).split(':').filter(Boolean);
  const fill = Math.max(0, 8 - left.length - right.length);
  return [...left, ...new Array(fill).fill('0'), ...right];
}

/**
 * 限流用的 IP 归一化。
 *
 * IPv6 只取 /64 前缀 —— 运营商给家宽的是一整个 /64，客户端可以在其中任意换地址。
 * 若按完整地址分桶，等于每个用户白送 2^64 份配额，限流形同虚设。
 * IPv4 保持原样：一个地址就是一个用户。
 */
function normalizeIpForLimit(ip) {
  const addr = String(ip == null ? '' : ip).trim().toLowerCase();
  if (addr === '') return 'unknown';
  if (addr.startsWith('::ffff:')) return addr.slice(7);   // IPv4-mapped IPv6
  if (!addr.includes(':')) return addr;                    // 纯 IPv4
  return `${expandIpv6(addr).slice(0, 4).join(':')}::/64`;
}

/**
 * 取客户端真实 IP。
 *
 * 关键点：只有当**直连方是本机**时才采信转发头。
 * 否则一旦 trustProxy 打开，局域网里任何人都能自己在请求里塞一个
 * X-Forwarded-For，每个请求换一个假 IP，限流就完全失效了。
 *
 * 优先级：CF-Connecting-IP（Cloudflare 边缘写入，客户端无法伪造）
 *        → X-Forwarded-For 第一段 → 直连地址
 */
function clientIp(req, { trustProxy = false } = {}) {
  const direct = (req.socket && req.socket.remoteAddress) || 'unknown';

  if (trustProxy && isLoopbackAddress(direct)) {
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp.trim() !== '') return cfIp.trim();

    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      const first = forwarded.split(',')[0].trim();
      if (first) return first;
    }
  }

  return direct;
}

module.exports = { isLoopbackAddress, expandIpv6, normalizeIpForLimit, clientIp };
