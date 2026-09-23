#!/usr/bin/env bash
#
# 为本站配置 HTTPS（Let's Encrypt 免费证书 + 自动续期）
#
#   sudo bash enable-https.sh your-name.duckdns.org
#
# 前提：
#   1. 域名已解析到本机公网 IP（用公共 DNS 能查到）
#   2. 安全组已放行 80 和 443
#   3. nginx 反向代理已启用（enable-nginx-proxy.sh 跑过）
#
# certbot 会：申请证书 → 自动改 nginx 配置 → 加上 80→443 跳转 → 装续期定时器

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-you@example.com}"

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[错误]\033[0m %s\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root：sudo bash enable-https.sh $DOMAIN"
[ -n "$DOMAIN" ] || die "用法：sudo bash enable-https.sh 你的域名"

info "目标域名：$DOMAIN"

# ---- 0. 前置检查 ----
info "前置检查"

# 域名能不能解析到本机的公网 IP？
PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || echo '')"
RESOLVED="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)"

printf '    本机公网 IP   : %s\n' "${PUBLIC_IP:-未知}"
printf '    域名解析到    : %s\n' "${RESOLVED:-解析失败}"

if [ -z "$RESOLVED" ]; then
  warn "域名目前解析不了 —— certbot 的验证会失败"
  warn "如果你刚在 DuckDNS 改了 IP，等 1-2 分钟再试"
elif [ -n "$PUBLIC_IP" ] && [ "$RESOLVED" != "$PUBLIC_IP" ]; then
  warn "域名解析到的 IP 和本机公网 IP 不一致，certbot 可能失败"
fi

# 80 端口 nginx 在听吗？
if systemctl is-active --quiet nginx; then
  ok "nginx 运行中"
else
  die "nginx 没在运行，先跑 enable-nginx-proxy.sh"
fi

# ---- 1. 安装 certbot ----
if command -v certbot >/dev/null 2>&1; then
  ok "certbot 已安装"
else
  info "安装 certbot"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq certbot python3-certbot-nginx
  ok "已安装 $(certbot --version 2>&1)"
fi

# ---- 2. 申请证书 ----
info "申请证书（约 10-30 秒）"
set +e
certbot --nginx \
  -d "$DOMAIN" \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  --redirect \
  --keep-until-expiring
RC=$?
set -e

if [ $RC -ne 0 ]; then
  warn "certbot 退出码 $RC"
  echo
  echo "  常见原因："
  echo "    · 域名还没解析好（等 1-2 分钟再试）"
  echo "    · 80 端口外网访问不了（检查安全组）"
  echo "    · 换个邮箱重试：sudo bash enable-https.sh $DOMAIN 你的邮箱@example.com"
  echo
  exit $RC
fi

ok "证书申请成功"

# ---- 3. 续期检查 ----
info "续期配置"
if systemctl list-timers --all 2>/dev/null | grep -q certbot; then
  ok "自动续期定时器已就绪"
else
  warn "没看到 certbot 定时器，检查：systemctl list-timers | grep certbot"
fi
certbot renew --dry-run >/dev/null 2>&1 && ok "续期演练通过" || warn "续期演练失败，请检查"

# ---- 4. 自检 ----
info "自检"
nginx -t >/dev/null 2>&1 && ok "nginx 配置语法正常" || { nginx -t; die "nginx 配置有问题"; }

CODE_HTTP=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $DOMAIN" http://127.0.0.1/ || echo 000)
CODE_HTTPS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || echo 000)

printf '    http  (应 301 跳转) : %s\n' "$CODE_HTTP"
printf '    https               : %s\n' "$CODE_HTTPS"

CERT_END=$(openssl x509 -enddate -noout -in "/etc/letsencrypt/live/$DOMAIN/cert.pem" 2>/dev/null | cut -d= -f2 || echo '未知')

cat <<EOF

────────────────────────────────────────────────────────────────
  HTTPS 配置完成
────────────────────────────────────────────────────────────────

  ✅ https://$DOMAIN
  ✅ 管理后台  https://$DOMAIN/admin

  证书到期：$CERT_END
  自动续期：已启用（systemd 定时器，到期前 30 天自动续）

  http 会自动 301 跳转到 https。

  常用命令：
    certbot certificates              # 查看证书
    certbot renew --dry-run           # 演练续期
    systemctl list-timers | grep certbot

────────────────────────────────────────────────────────────────
EOF
