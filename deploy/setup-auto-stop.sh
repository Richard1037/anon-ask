#!/usr/bin/env bash
#
# 在服务器上安装「到期自动停机」定时器
#
#   sudo bash setup-auto-stop.sh 2026-10-23          # 默认 03:00 UTC 停机
#   sudo bash setup-auto-stop.sh 2026-10-23 19:00    # 指定时间（UTC）
#   sudo bash setup-auto-stop.sh --check             # 只验证权限，不装定时器
#   sudo bash setup-auto-stop.sh --status            # 查看当前定时器
#   sudo bash setup-auto-stop.sh --cancel            # 取消定时器
#
# 到期时虚拟机会把自己停机（deallocate），计算费用随即停止。
# 磁盘和公共 IP 仍会计费（省不掉），数据和网址不变，随时可以用
#   az vm start -g anon-ask-rg -n anon-ask-vm
# 重新开机。

set -euo pipefail

SCRIPT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/self-deallocate.sh"
SCRIPT_DST=/usr/local/bin/anon-ask-selfstop.sh
SERVICE=/etc/systemd/system/anon-ask-selfstop.service
TIMER=/etc/systemd/system/anon-ask-selfstop.timer

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[错误]\033[0m %s\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root：sudo bash setup-auto-stop.sh <日期>"

MODE="${1:-}"

# ---- 查看状态 ----
if [ "$MODE" = "--status" ]; then
  info "定时器状态"
  systemctl list-timers anon-ask-selfstop.timer --all --no-pager 2>/dev/null || warn "定时器未安装"
  echo
  if [ -f "$TIMER" ]; then
    info "当前配置"
    grep -E '^OnCalendar|^Persistent' "$TIMER" | sed 's/^/    /'
  fi
  exit 0
fi

# ---- 取消 ----
if [ "$MODE" = "--cancel" ]; then
  info "取消定时器"
  systemctl disable --now anon-ask-selfstop.timer >/dev/null 2>&1 || true
  rm -f "$TIMER" "$SERVICE" "$SCRIPT_DST"
  systemctl daemon-reload
  ok "已取消并清理"
  exit 0
fi

# ---- 只验证权限 ----
if [ "$MODE" = "--check" ]; then
  info "验证托管标识与权限"
  [ -f "$SCRIPT_DST" ] || { mkdir -p /usr/local/bin; cp "$SCRIPT_SRC" "$SCRIPT_DST"; chmod 755 "$SCRIPT_DST"; }
  bash "$SCRIPT_DST" --check
  exit $?
fi

# ---- 安装定时器 ----
DATE="${1:-}"
TIME="${2:-03:00}"
[ -n "$DATE" ] || die "用法：sudo bash setup-auto-stop.sh 2026-10-23 [HH:MM]"

[[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "日期格式应为 YYYY-MM-DD，收到：$DATE"
[[ "$TIME" =~ ^[0-9]{2}:[0-9]{2}$ ]] || die "时间格式应为 HH:MM（UTC），收到：$TIME"

TARGET="${DATE} ${TIME}:00"

# 时间必须在未来
TARGET_EPOCH=$(date -u -d "$TARGET" +%s 2>/dev/null) || die "无法解析时间：$TARGET"
NOW_EPOCH=$(date -u +%s)
if [ "$TARGET_EPOCH" -le "$NOW_EPOCH" ]; then
  die "时间必须在未来。你给的是 $TARGET UTC，当前是 $(date -u '+%Y-%m-%d %H:%M') UTC"
fi

DAYS=$(( (TARGET_EPOCH - NOW_EPOCH) / 86400 ))

info "安装自动停机定时器"
# 注意：不要用 date -d "$TARGET +8 hours" —— "+8" 会被当成时区解析，算出错误结果。
# 正确做法是用 TZ 指定时区来显示。
BEIJING="$(TZ='Asia/Shanghai' date -d "${TARGET} UTC" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '?')"
printf '    停机时间：%s UTC（北京时间 %s）\n' "$TARGET" "$BEIJING"
printf '    距今还有：%s 天\n' "$DAYS"

# 1. 部署脚本
mkdir -p /usr/local/bin
cp "$SCRIPT_SRC" "$SCRIPT_DST"
chmod 755 "$SCRIPT_DST"
ok "脚本已安装到 $SCRIPT_DST"

# 2. systemd service
cat > "$SERVICE" <<EOF
[Unit]
Description=Deallocate this Azure VM to stop compute billing
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${SCRIPT_DST}
StandardOutput=append:/var/log/anon-ask-selfstop.log
StandardError=append:/var/log/anon-ask-selfstop.log
EOF

# 3. systemd timer
cat > "$TIMER" <<EOF
[Unit]
Description=One-shot timer: deallocate the VM on ${TARGET} UTC

[Timer]
OnCalendar=${TARGET}
# 如果到点时机器正好关机/重启，开机后补跑一次
Persistent=true
Unit=anon-ask-selfstop.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now anon-ask-selfstop.timer >/dev/null 2>&1
ok "定时器已启用"

# 4. 立即验证权限（关键：确保到点真能停掉）
info "验证停机权限（现在就测，避免到点发现没权限）"
if bash "$SCRIPT_DST" --check; then
  ok "权限验证通过 —— 到期一定能停掉"
else
  warn "权限验证失败！到点可能停不掉，请检查："
  warn "  角色分配需要几分钟生效，稍后重跑：sudo bash setup-auto-stop.sh --check"
fi

# 5. 汇总
info "完成"
echo
systemctl list-timers anon-ask-selfstop.timer --all --no-pager 2>/dev/null | head -3 | sed 's/^/    /'
cat <<EOF

────────────────────────────────────────────────────────────────
  到期自动停机已配置
────────────────────────────────────────────────────────────────

  停机时间: ${TARGET} UTC  （北京时间 ${BEIJING}）

  到期后：
    · 虚拟机会自动停机，计算费用停止（约省 \$9/月）
    · 磁盘和公共 IP 仍计费（约 \$6/月）
    · 数据、代码、证书、网址全部保留

  想提前手动停：
    az vm deallocate -g anon-ask-rg -n anon-ask-vm

  想重新开机：
    az vm start -g anon-ask-rg -n anon-ask-vm

  想改时间：
    sudo bash setup-auto-stop.sh 2026-12-01
  想取消：
    sudo bash setup-auto-stop.sh --cancel
  看状态：
    sudo bash setup-auto-stop.sh --status
  看停机日志：
    tail -20 /var/log/anon-ask-selfstop.log

────────────────────────────────────────────────────────────────
EOF
