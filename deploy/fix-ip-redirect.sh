#!/usr/bin/env bash
#
# 修复：裸 IP 访问返回 404 → 改成跳转到正式域名
#
#   sudo bash fix-ip-redirect.sh
#
# 背景：certbot 改写配置后，80 端口的 default_server 变成 return 404，
# 于是 http://203.0.113.10/ 直接 404。这里改成 301 跳到 HTTPS 域名，
# 顺便让「用 IP 测试连通性」这个诊断手段可用。

set -euo pipefail

# ⚠️ 替换成你自己的域名
DOMAIN="your-name.duckdns.org"
CONF=/etc/nginx/sites-available/anon-ask

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[错误]\033[0m %s\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root：sudo bash fix-ip-redirect.sh"
[ -f "$CONF" ] || die "找不到 $CONF"

info "备份原配置"
cp "$CONF" "${CONF}.bak.$(date +%Y%m%d%H%M%S)"
ok "已备份"

info "检查当前 default_server 块"

# 找到 80 端口那个 default_server 里的 return 404，改成跳转
# 用 python 处理，避免 sed 的转义问题
python3 - "$CONF" "$DOMAIN" <<'PY'
import re, sys

path, domain = sys.argv[1], sys.argv[2]
src = open(path, encoding='utf-8').read()

# 匹配：listen 80 default_server; ... 直到该 server 块结束
pattern = re.compile(
    r'(server\s*\{[^{}]*?listen\s+(?:\[::\]:)?80\s+default_server;[^{}]*?server_name\s+[^;]*;)'
    r'(\s*)return\s+404;',
    re.S,
)

def repl(m):
    head, gap = m.group(1), m.group(2)
    return (
        head
        + gap
        + '# 裸 IP 访问 -> 跳转到正式域名（也方便用来测试连通性）\n'
        + '    return 301 https://' + domain + '$request_uri;'
    )

new, n = pattern.subn(repl, src)

if n == 0:
    print('NO_MATCH')
    sys.exit(2)

open(path, 'w', encoding='utf-8').write(new)
print('REPLACED', n)
PY
RC=$?

if [ $RC -eq 2 ]; then
  # 可能已经是跳转，或者结构不同 —— 打印相关片段供人工判断
  info "没找到 'listen 80 default_server + return 404' 的组合，当前的 80 端口块："
  awk '/listen.*80.*default_server/,/^}/' "$CONF" | head -20 | sed 's/^/    /'
  info "如果上面已经是 301 跳转，说明无需修改"
  exit 0
elif [ $RC -ne 0 ]; then
  die "python 处理失败（退出码 $RC）"
fi

ok "已改为 301 跳转到 https://$DOMAIN"

info "语法检查并重载"
if nginx -t 2>/dev/null; then
  ok "语法正常"
  systemctl reload nginx
  ok "nginx 已重载"
else
  nginx -t || true
  die "语法错误！已保留备份，请手动恢复"
fi

info "自检"
printf '    http://127.0.0.1/  (Host: IP)   -> HTTP %s\n' \
  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H 'Host: 203.0.113.10' http://127.0.0.1/ || echo 000)"
printf '    https://%s/                     -> HTTP %s\n' "$DOMAIN" \
  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/" || echo 000)"
