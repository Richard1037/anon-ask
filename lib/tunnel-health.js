'use strict';

/**
 * 隧道健康检查。
 *
 * 为什么不能简单用 fetch：
 *   本机的 DNS 是内网 DNS（10.0.0.53 / 10.0.0.54），**解析不了
 *   *.trycloudflare.com / *.ngrok-free.app 这类域名**（公共 DNS 却可以）。
 *   浏览器之所以能打开，是因为它走 Clash 代理，DNS 在代理那端解析。
 *
 *   如果健康检查直接用本地 DNS，就会把「本地解析失败」误判成「隧道挂了」，
 *   于是不停重开隧道、不停换地址 —— 这正是之前地址乱变的真正原因。
 *
 * 所以策略是：**直连和走代理各测一次，任意一个通就算健康**。
 *   - 本地 DNS 坏但代理好 → 代理那次通 → 健康
 *   - 代理没开但本地 DNS 好 → 直连那次通 → 健康
 *   - 两个都不通 → 才判定隧道真的挂了
 */

const { spawn } = require('node:child_process');

/** 用 curl 取 HTTP 状态码（curl 支持 --proxy，Node 的 fetch 默认不认代理）。 */
function curlStatus(url, proxy, timeoutSec = 10) {
  return new Promise((resolve) => {
    const args = [
      '-s', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
      '-w', '%{http_code}',
      '--max-time', String(timeoutSec),
    ];
    if (proxy) args.push('--proxy', proxy);
    args.push(url);

    let child;
    try {
      child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return resolve('000');
    }

    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.on('error', () => resolve('000'));
    child.on('close', () => resolve(out.trim() || '000'));
    return undefined;
  });
}

const ORIGIN_DOWN = new Set(['502', '503', '504']);

/**
 * @returns {Promise<'ok'|'origin-down'|'down'>}
 */
async function checkTunnel(url, proxy) {
  const direct = await curlStatus(url, null);
  if (direct === '200') return 'ok';
  if (ORIGIN_DOWN.has(direct)) return 'origin-down';

  if (proxy) {
    const proxied = await curlStatus(url, proxy);
    if (proxied === '200') return 'ok';
    if (ORIGIN_DOWN.has(proxied)) return 'origin-down';
  }

  return 'down';
}

module.exports = { checkTunnel, curlStatus };
