#!/usr/bin/env bash
# 前端契约一致性检查（与后端 openapi.yaml 对齐）。
#
# 检查项：
#   A. 前端调用的每个静态 /api/v1/* 路径，必须在 src/api/openapi.yaml 中声明
#      （动态模板字符串如 `/api/v1/x/${id}` 不在此检查范围，由人工/类型保证）
#   B. 前端不得绕过统一 client（src/api/client.ts）直接 fetch
#
# 用法：./ci/check-contract.sh

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

FAIL=0
fail() { echo "  ✗ $1"; FAIL=1; }
pass() { echo "  ✓ $1"; }

if [ ! -f src/api/openapi.yaml ]; then
  echo "  ✗ 缺少契约文件 src/api/openapi.yaml（应来自后端 docs/api/openapi.yaml）"; exit 1
fi

# ── 后端契约中声明的全部路径 ──
CONTRACT=$(grep -oE '^  /api/v1/[a-zA-Z0-9/_{}-]+:' src/api/openapi.yaml | sed -E 's/^  //; s/:$//' | sort -u)

# ── 前端调用的静态路径（单引号字符串字面量）──
FRONTEND=$(grep -rhoE "'/api/v1/[a-zA-Z0-9/_-]+'" src --include="*.ts" --include="*.vue" 2>/dev/null | tr -d "'" | sort -u)

echo "== [A] 前端静态调用路径必须已在契约声明 =="
MISSING=""
for p in $FRONTEND; do
  if ! echo "$CONTRACT" | grep -qxF "$p"; then MISSING="$MISSING $p"; fi
done
if [ -n "$MISSING" ]; then
  fail "前端调用了契约未声明的路径：$MISSING"
else
  pass "全部前端静态调用路径均已声明"
fi

echo "== [B] 不得绕过 api/client.ts 直接 fetch =="
RAW=$(grep -rnE '(^|[^.a-zA-Z])fetch\(' src --include="*.ts" --include="*.vue" 2>/dev/null | grep -v "src/api/client.ts")
if [ -n "$RAW" ]; then
  fail "发现绕过 client.ts 的直接 fetch（会漏掉 CSRF / 401 处理）："
  echo "$RAW" | sed 's/^/      /'
else
  pass "全部请求经过 api/client.ts"
fi

echo
if [ "$FAIL" -eq 0 ]; then echo "PASS：前端契约一致"; exit 0; else echo "FAIL：契约不一致"; exit 1; fi
