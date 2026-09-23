#!/usr/bin/env bash
#
# 匿名提问箱 · 服务器一键部署脚本
#
# 在全新的 Ubuntu / Debian 服务器上运行（需要 root）：
#
#     sudo bash deploy.sh
#
# 做的事：
#   1. 安装 Node.js 22
#   2. 把项目复制到 /opt/anon-ask
#   3. 装成 systemd 服务（开机自启、崩溃自动重启）
#   4. 放行防火墙端口
#   5. 启动并打印访问地址
#
# 重复运行是安全的：会更新代码并重启服务，不会覆盖已存在的数据。

set -euo pipefail

APP_NAME="anon-ask"
APP_DIR="/opt/${APP_NAME}"
SERVICE_NAME="${APP_NAME}"
NODE_MAJOR=22

# 脚本所在目录的上一级 = 项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "${SCRIPT_DIR}")"

# ------------------------------------------------------------------
# 工具函数
# ------------------------------------------------------------------

info()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '    \033[1;33m!\033[0m %s\n' "$*"; }
die()   { printf '\n\033[1;31m[错误]\033[0m %s\n\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------
# 0. 前置检查
# ------------------------------------------------------------------

[ "$(id -u)" -eq 0 ] || die "需要 root 权限。请用：sudo bash deploy.sh"

[ -f "${PROJECT_DIR}/server.js" ] || die "在 ${PROJECT_DIR} 里找不到 server.js，请确认在项目目录内运行本脚本。"

PORT="$(grep -oP '"port"\s*:\s*\K[0-9]+' "${PROJECT_DIR}/config.json" 2>/dev/null || echo 8080)"
[ -n "${PORT}" ] || PORT=8080

info "项目目录：${PROJECT_DIR}"
info "部署目标：${APP_DIR}"
info "监听端口：${PORT}"

# ------------------------------------------------------------------
# 1. 安装 Node.js
# ------------------------------------------------------------------

need_node=1
if command -v node >/dev/null 2>&1; then
  CURRENT_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "${CURRENT_MAJOR}" -ge "${NODE_MAJOR}" ]; then
    ok "已有 Node.js $(node -v)"
    need_node=0
  else
    warn "现有 Node.js $(node -v) 版本过低，将升级"
  fi
fi

if [ "${need_node}" -eq 1 ]; then
  info "安装 Node.js ${NODE_MAJOR}…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
  ok "已安装 Node.js $(node -v)"
fi

# ------------------------------------------------------------------
# 2. 准备运行账户与目录
# ------------------------------------------------------------------

if ! id "${APP_NAME}" >/dev/null 2>&1; then
  info "创建系统账户 ${APP_NAME}"
  useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${APP_NAME}"
  ok "已创建"
else
  ok "系统账户 ${APP_NAME} 已存在"
fi

info "复制项目文件到 ${APP_DIR}"

# data/ 是数据库所在，必须保留；其余文件覆盖更新
BACKUP_DIR=""
if [ -d "${APP_DIR}/data" ]; then
  BACKUP_DIR="$(mktemp -d)"
  cp -a "${APP_DIR}/data/." "${BACKUP_DIR}/" 2>/dev/null || true
  ok "已临时备份现有数据库"
fi

mkdir -p "${APP_DIR}"
# 用 tar 管道复制，顺带排除运行时产物
tar -C "${PROJECT_DIR}" \
    --exclude='./data' \
    --exclude='./logs' \
    --exclude='./backup' \
    --exclude='./bin' \
    --exclude='./test/.tmp' \
    --exclude='./test/.shots' \
    -cf - . | tar -C "${APP_DIR}" -xf -

if [ -n "${BACKUP_DIR}" ]; then
  mkdir -p "${APP_DIR}/data"
  cp -a "${BACKUP_DIR}/." "${APP_DIR}/data/" 2>/dev/null || true
  rm -rf "${BACKUP_DIR}"
  ok "数据库已还原"
fi

mkdir -p "${APP_DIR}/data" "${APP_DIR}/logs"

# 服务器上不需要隧道守护进程的锁文件
rm -f "${APP_DIR}/data/tunnel.pid" "${APP_DIR}/data/ngrok.pid" "${APP_DIR}/data/server.pid"

# 服务器直接对外，前面没有代理，关掉 trustProxy 更符合实际
if [ -f "${APP_DIR}/config.json" ]; then
  node -e "
    const fs=require('fs');
    const p='${APP_DIR}/config.json';
    const c=JSON.parse(fs.readFileSync(p,'utf8'));
    c.trustProxy=false;
    c.host='0.0.0.0';
    fs.writeFileSync(p, JSON.stringify(c,null,2)+'\n');
  "
  ok "已把 config.json 的 trustProxy 设为 false（服务器直连，无代理）"
fi

chown -R "${APP_NAME}:${APP_NAME}" "${APP_DIR}"
chmod 750 "${APP_DIR}"
ok "文件就位，权限已设置"

# ------------------------------------------------------------------
# 3. 安装 systemd 服务
# ------------------------------------------------------------------

info "安装 systemd 服务"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Anonymous Question Box
Documentation=file://${APP_DIR}/README.md
After=network.target

[Service]
Type=simple
User=${APP_NAME}
Group=${APP_NAME}
WorkingDirectory=${APP_DIR}
ExecStart=$(command -v node) ${APP_DIR}/server.js
Restart=always
RestartSec=3
StandardOutput=append:${APP_DIR}/logs/server.out.log
StandardError=append:${APP_DIR}/logs/server.err.log

# 基础加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1 || true
ok "服务已注册并设为开机自启"

# ------------------------------------------------------------------
# 4. 防火墙
# ------------------------------------------------------------------

info "配置防火墙"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "${PORT}/tcp" >/dev/null 2>&1 && ok "ufw 已放行 ${PORT}/tcp"
else
  ok "ufw 未启用，跳过"
fi

if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  ok "firewalld 已放行 ${PORT}/tcp"
fi

# ------------------------------------------------------------------
# 5. 启动
# ------------------------------------------------------------------

info "启动服务"
systemctl restart "${SERVICE_NAME}"
sleep 3

if systemctl is-active --quiet "${SERVICE_NAME}"; then
  ok "服务运行中"
else
  echo
  echo "---- 最近日志 ----"
  journalctl -u "${SERVICE_NAME}" -n 30 --no-pager || true
  echo "------------------"
  die "服务启动失败，日志见上。"
fi

# ------------------------------------------------------------------
# 6. 自检
# ------------------------------------------------------------------

info "自检"
if curl -fsS --max-time 8 "http://127.0.0.1:${PORT}/api/meta" >/dev/null 2>&1; then
  ok "本机接口正常"
else
  warn "本机接口无响应，稍等几秒再试，或查看：journalctl -u ${SERVICE_NAME} -f"
fi

PUBLIC_IP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo '')"
[ -n "${PUBLIC_IP}" ] || PUBLIC_IP="$(hostname -I | awk '{print $1}')"

cat <<EOF

$(printf '%.0s─' {1..64})
  部署完成
$(printf '%.0s─' {1..64})

  普通用户   http://${PUBLIC_IP}:${PORT}
  管理后台   http://${PUBLIC_IP}:${PORT}/admin

  管理口令在 ${APP_DIR}/config.json 里（改完要重启服务）

  常用命令：
    systemctl status  ${SERVICE_NAME}     # 看状态
    systemctl restart ${SERVICE_NAME}     # 重启
    systemctl stop    ${SERVICE_NAME}     # 停止
    journalctl -u ${SERVICE_NAME} -f      # 实时日志

  数据备份：
    node ${APP_DIR}/backup.mjs /root/anonask-backup.db

$(printf '%.0s─' {1..64})

  ⚠️ 如果浏览器打不开，多半是**云服务商的安全组**没放行 ${PORT} 端口 ——
     这个要在控制台网页里改，本脚本改不了。

EOF
