#!/usr/bin/env bash
#
# 把本虚拟机停机（deallocate），以停止计算计费。
#
#   sudo bash self-deallocate.sh --check    # 只检查权限，不停机（安全）
#   sudo bash self-deallocate.sh            # 真的停机
#
# 原理：
#   虚拟机上启用了「系统分配的托管标识」，它可以从 Azure 实例元数据服务
#   （IMDS，169.254.169.254）拿到一个访问令牌，无需任何密钥文件。
#   再用这个令牌调用 Azure API 把自己停机。
#
#   好处：不依赖你自己的电脑，不需要把任何密钥写在磁盘上，
#        权限也仅限于「停机」这一个动作（自定义角色 VM Self Deallocate）。

set -euo pipefail

# ⚠️ 下面三项必须改成你自己的（占位符值跑不通）
#    订阅 ID: Azure 门户 → 订阅 → 复制订阅 ID
#    资源组 / 虚拟机名: Azure 门户 → 虚拟机 → 概述页
SUB="00000000-0000-0000-0000-000000000000"   # ← 替换成你的订阅 ID
RG="anon-ask-rg"                             # ← 替换成你的资源组名
VM="anon-ask-vm"                             # ← 替换成你的虚拟机名
API_VERSION="2024-07-01"

MODE="${1:-run}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# ---- 1. 从 IMDS 拿令牌 ----
log "获取托管标识令牌…"
IMDS_URL="http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/"

RAW="$(curl -sS --max-time 15 -H 'Metadata: true' "$IMDS_URL" 2>&1 || true)"

if [ -z "$RAW" ] || ! printf '%s' "$RAW" | grep -q access_token; then
  log "获取令牌失败。原始响应："
  printf '%s\n' "$RAW"
  log "可能原因：虚拟机上没有启用系统分配的托管标识"
  exit 1
fi

TOKEN="$(printf '%s' "$RAW" | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')"
log "拿到令牌（长度 ${#TOKEN}）"

VM_URL="https://management.azure.com/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Compute/virtualMachines/${VM}"

# ---- 2. 检查模式：只验证权限 ----
if [ "$MODE" = "--check" ]; then
  log "检查模式：验证「读取本机」权限"
  CODE="$(curl -sS --max-time 20 -o /tmp/_vm_read.json -w '%{http_code}' \
    -H "Authorization: Bearer ${TOKEN}" \
    "${VM_URL}?api-version=${API_VERSION}" || echo 000)"
  log "读取虚拟机 -> HTTP $CODE"
  if [ "$CODE" = "200" ]; then
    log "✓ 权限正常"
    python3 -c 'import json;d=json.load(open("/tmp/_vm_read.json"));print("  名称:",d["name"], " 规格:", d["properties"]["hardwareProfile"]["vmSize"], " 位置:", d["location"])'
  else
    log "✗ 读取失败，响应："; cat /tmp/_vm_read.json 2>/dev/null || true
    exit 1
  fi

  log "验证「停机」权限（查询本虚拟机范围内的有效权限列表）"
  PERM_URL="${VM_URL}/providers/Microsoft.Authorization/permissions?api-version=2022-04-01"
  CODE2="$(curl -sS --max-time 25 -o /tmp/_vm_perm.json -w '%{http_code}' \
    -H "Authorization: Bearer ${TOKEN}" "$PERM_URL" || echo 000)"

  if [ "$CODE2" != "200" ]; then
    log "? 查询权限列表返回 HTTP $CODE2，无法判定："
    cat /tmp/_vm_perm.json 2>/dev/null || true
    exit 1
  fi

  # 注意：不能用「对不存在的虚拟机名调用 deallocate」来探测 ——
  # 角色范围只限本虚拟机，探测别的名字必然返回 403，那是正确行为不是故障。
  RESULT="$(python3 - <<'PY'
import json
try:
    d = json.load(open('/tmp/_vm_perm.json'))
except Exception as e:
    print('PARSE_ERROR', e); raise SystemExit
actions = set()
for p in d.get('value', []):
    for a in p.get('actions', []):
        actions.add(a.lower())
    for a in p.get('notActions', []):
        actions.discard(a.lower())
need = 'microsoft.compute/virtualmachines/deallocate/action'
print('HAS' if need in actions else 'NO')
if actions:
    print('ACTIONS:' + ', '.join(sorted(actions)))
PY
)"

  if printf '%s' "$RESULT" | grep -q '^HAS'; then
    log "✓ 停机权限已确认（到期一定能停掉）"
    printf '%s\n' "$RESULT" | grep '^ACTIONS:' | sed 's/^ACTIONS:/  有效权限: /' || true
  else
    log "✗ 有效权限里没有 deallocate/action —— 角色分配可能还没生效（通常需 1-5 分钟）"
    printf '%s\n' "$RESULT" | sed 's/^/  /'
    exit 1
  fi

  rm -f /tmp/_vm_read.json /tmp/_vm_perm.json
  exit 0
fi

# ---- 3. 真正停机 ----
log "开始停机：${RG}/${VM}"
CODE="$(curl -sS --max-time 60 -o /tmp/_dealloc.json -w '%{http_code}' -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Length: 0' \
  "${VM_URL}/deallocate?api-version=${API_VERSION}" || echo 000)"

log "停机请求 -> HTTP $CODE"

case "$CODE" in
  200|202)
    log "✓ 停机请求已接受（操作是异步的，几十秒后生效）"
    log "  数据不会丢；下次开机：az vm start -g ${RG} -n ${VM}"
    ;;
  403)
    log "✗ 权限不足"; cat /tmp/_dealloc.json 2>/dev/null || true ;;
  404)
    log "✗ 找不到虚拟机"; cat /tmp/_dealloc.json 2>/dev/null || true ;;
  *)
    log "✗ 意外状态码 $CODE"; cat /tmp/_dealloc.json 2>/dev/null || true ;;
esac

rm -f /tmp/_dealloc.json
