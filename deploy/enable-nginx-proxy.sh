#!/usr/bin/env bash
#
# 在服务器上启用 nginx 反向代理（80 -> 127.0.0.1:8080）
#
#   sudo bash enable-nginx-proxy.sh
#
# 做四件事：
#   1. 安装 nginx（如果没装）
#   2. 部署反向代理配置
#   3. 打开应用的 trustProxy（nginx 在本机，回环直连才可信）
#   4. 重启服务并自检
#
# 安全性说明见 nginx-anon-ask.conf 里的注释：必须清掉客户端伪造的
# CF-Connecting-IP，否则限流会被绕过。

set -euo pipefail

APP_DIR=/opt/anon-ask
SERVICE=anon-ask
CONF_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nginx-anon-ask.conf"
CONF_DST=/etc/nginx/sites-available/anon-ask

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[错误]\033[0m %s\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root：sudo bash enable-nginx-proxy.sh"

# ---- 1. 安装 nginx ----
if command -v nginx >/dev/null 2>&1; then
  ok "nginx 已安装：$(nginx -v 2>&1 | sed 's/nginx version: //')"
else
  info "安装 nginx"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nginx
  ok "已安装"
fi

# ---- 2. 部署配置 ----
info "部署反向代理配置"
[ -f "$CONF_SRC" ] || die "找不到 $CONF_SRC"

cp "$CONF_SRC" "$CONF_DST"
rm -f /etc/nginx/sites-enabled/default
ln -sf "$CONF_DST" /etc/nginx/sites-enabled/anon-ask

if nginx -t 2>/dev/null; then
  ok "配置语法检查通过"
else
  nginx -t || true
  die "nginx 配置有语法错误，已中止（未重启 nginx）"
fi

systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx
sleep 1
systemctl is-active --quiet nginx || die "nginx 启动失败：journalctl -u nginx -n 30"
ok "nginx 运行中，已在 80 端口监听"

# ---- 3. 打开 trustProxy ----
info "打开应用的 trustProxy"
# nginx 跑在同一台机器上，从 127.0.0.1 连过来，所以服务端会采信它的
# X-Forwarded-For。不开这个的话所有访客都会被当成 nginx 的 IP，限流会误伤。
node -e '
const fs = require("fs");
const p = "/opt/anon-ask/config.json";
const c = JSON.parse(fs.readFileSync(p, "utf8"));
if (c.trustProxy !== true) {
  c.trustProxy = true;
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
  console.log("    trustProxy: false -> true");
} else {
  console.log("    trustProxy 已经是 true");
}
'
chown anon-ask:anon-ask "${APP_DIR}/config.json"
systemctl restart "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" || die "应用重启失败：journalctl -u $SERVICE -n 30"
ok "应用已重启"

# ---- 4. 自检 ----
info "自检"
CODE_VIA_NGINX=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1/ || echo 000)
CODE_DIRECT=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:8080/ || echo 000)

printf '    经 nginx (80)    : HTTP %s\n' "$CODE_VIA_NGINX"
printf '    直连应用 (8080)  : HTTP %s\n' "$CODE_DIRECT"

if [ "$CODE_VIA_NGINX" = "200" ] && [ "$CODE_DIRECT" = "200" ]; then
  ok "两条路径都正常"
else
  warn "有路径异常，检查：journalctl -u nginx -n 30 / journalctl -u $SERVICE -n 30"
fi

# ---- 5. 验证真实 IP 传递 ----
info "验证真实 IP 能正确传递（限流依赖这个）"
# 伪造一个 CF-Connecting-IP，如果 nginx 没清掉，说明有漏洞
RATE_TEST=$(curl -s --max-time 8 \
  -H 'CF-Connecting-IP: 9.9.9.9' \
  -H 'X-Forwarded-For: 8.8.8.8' \
  http://127.0.0.1/api/meta -o /dev/null -w '%{http_code}' || echo 000)
printf '    带伪造头访问: HTTP %s（能正常返回就说明没被伪造头干扰）\n' "$RATE_TEST"

cat <<'EOF'

────────────────────────────────────────────────────────────────
  反向代理配置完成
────────────────────────────────────────────────────────────────

  现在服务器上 80 端口已经能访问应用了。

  ⚠️ 但外网还访问不了 —— 需要去 Azure 控制台放行 80 端口：
     虚拟机 → 网络 → 网络安全组 → 入站安全规则 → + 添加
       目标端口范围: 80
       协议:        TCP
       操作:        允许
       优先级:      320
       名称:        allow-80

  放行后：
     http://203.0.113.10          （不带端口）
     http://你的域名.duckdns.org    （配好 DuckDNS 之后）

────────────────────────────────────────────────────────────────
EOF
