'use strict';

/**
 * 进程内滑动窗口限流器。
 * 单实例部署足够；重启即清空，不接受任何持久化开销。
 */
class Limiter {
  constructor({ maxKeys = 20000 } = {}) {
    this.buckets = new Map();
    this.maxKeys = maxKeys;
  }

  /**
   * 记录一次命中，并返回是否放行。
   * @param {string} key 限流维度（通常是 ipHash + 动作名）
   * @param {Array<{windowMs:number, max:number}>} rules 命中任一规则即拒绝
   * @returns {{ok:boolean, retryAfter?:number}}
   */
  hit(key, rules) {
    const now = Date.now();
    const maxWindow = rules.reduce((m, r) => Math.max(m, r.windowMs), 0);

    // 时间戳天然递增，过期项一律是前缀。
    let stamps = this.buckets.get(key) || [];
    let cut = 0;
    while (cut < stamps.length && now - stamps[cut] >= maxWindow) cut += 1;
    if (cut > 0) stamps = stamps.slice(cut);

    for (const rule of rules) {
      let inWindow = 0;
      let oldest = 0;
      for (let i = stamps.length - 1; i >= 0; i -= 1) {
        if (now - stamps[i] < rule.windowMs) {
          inWindow += 1;
          oldest = stamps[i];
        } else {
          break;
        }
      }
      if (inWindow >= rule.max) {
        this.buckets.set(key, stamps);
        const retryAfter = Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000));
        return { ok: false, retryAfter };
      }
    }

    stamps.push(now);
    this.buckets.set(key, stamps);

    if (this.buckets.size > this.maxKeys) this.sweep(now, maxWindow);
    return { ok: true };
  }

  sweep(now, maxWindow) {
    for (const [key, stamps] of this.buckets) {
      const last = stamps[stamps.length - 1];
      if (last === undefined || now - last >= maxWindow) this.buckets.delete(key);
    }
  }

  reset(key) {
    this.buckets.delete(key);
  }

  get size() {
    return this.buckets.size;
  }
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

module.exports = { Limiter, MINUTE, DAY };
