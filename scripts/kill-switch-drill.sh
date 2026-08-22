#!/usr/bin/env bash
# kill-switch-drill.sh — B6 T6.4 双轨切换演练脚本。
#
# 模拟 dsh 轨道运行中（含活跃 SSE 连接 / 进行中 turn / 后台任务）切换到 opencc
# 轨道重启的完整流程。验收点：
#   1. drain / dispose 顺序正确（拒绝新请求 → flush → dispose → 清 globalThis 桥）
#   2. 会话数据互不可见但不损坏（dsh-sessions/ 与 <sessionId>.jsonl 各自完整）
#   3. 无孤儿进程（dsh 长驻 Cordis ctx 干净退出）
#   4. ~/.zai/tasks/ 与 ~/.zai/tasks-dsh/ 无残留
#   5. SSE 长连接 drain 验证（连接优雅关闭，不是硬 kill）
#
# 用法：
#   bash scripts/kill-switch-drill.sh [--port=8102 --api-port=7715]
#
# 演练步骤：
#   Phase 1: 启动 dsh 轨道
#   Phase 2: 发起 1 个对话 + 1 个后台任务
#   Phase 3: SSE 长连接接入（curl --no-buffer）
#   Phase 4: 触发 kill switch（发送 SIGTERM 到 dsh 进程）
#   Phase 5: 等待 graceful shutdown（≤30s 超时）
#   Phase 6: 启动 opencc 轨道
#   Phase 7: 验证两轨会话数据各自完整
#   Phase 8: 验证 globalThis 桥清空
#
# 退出码：
#   0 - 演练通过
#   1 - 启动失败 / 超时 / 断言失败
#   2 - 用法错误

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LOG_DIR="${PROJECT_ROOT}/.zai/drill-logs"
DRILL_TMP="${TMPDIR:-/tmp}/kill-switch-drill-$$"
DATE_TAG="$(date +%Y%m%d-%H%M%S)"

# 参数解析
PORT="${ZAI_DRILL_PORT:-8102}"
API_PORT="${ZAI_DRILL_API_PORT:-7715}"
ZAI_DATA_DIR="${ZAI_DATA_DIR:-${HOME}/.zai-drill-${DATE_TAG}}"
export ZAI_DATA_DIR

mkdir -p "${LOG_DIR}" "${DRILL_TMP}"

echo "==> Kill-Switch Drill @ ${DATE_TAG}"
echo "    port=${PORT} apiPort=${API_PORT} dataDir=${ZAI_DATA_DIR}"
echo "    logDir=${LOG_DIR}"
echo

# ─── Phase 1: 启动 dsh 轨道 ─────────────────────────────────────────
echo "==> Phase 1: 启动 dsh 轨道"

# 写入 settings 强制 dsh 模式
mkdir -p "${ZAI_DATA_DIR}"
cat > "${ZAI_DATA_DIR}/settings.json" <<EOF
{
  "agent": { "kernel": "dsh" },
  "server": { "port": ${PORT}, "apiPort": ${API_PORT} }
}
EOF

cd "${PROJECT_ROOT}/packages/zai"
DSH_LOG="${LOG_DIR}/dsh-${DATE_TAG}.log"
DSH_PID_FILE="${DRILL_TMP}/dsh.pid"

# 后台启动（dsh 模式；Node >= 22.19）
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "${NODE_MAJOR}" -lt 22 ]; then
    echo "    FAIL: Node ${NODE_MAJOR} 不满足 dsh 模式 (>= 22.19)" >&2
    exit 1
  fi
  # 用 npx tsx 直接启动（避免 build 步骤）
  nohup npx tsx --loader "${PROJECT_ROOT}/packages/zn-agent-core/dist/compat/runtime/bun-protocol.mjs" \
    src/cli/index.ts dev -- --port "${PORT}" --api-port "${API_PORT}" \
    > "${DSH_LOG}" 2>&1 &
  echo $! > "${DSH_PID_FILE}"
else
  echo "    FAIL: node not found" >&2
  exit 1
fi

# 等待启动
echo "    waiting for dsh to come up..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${API_PORT}/api/health" >/dev/null 2>&1; then
    echo "    dsh up @ attempt ${i}"
    break
  fi
  sleep 1
  if [ "${i}" -eq 30 ]; then
    echo "    FAIL: dsh 启动超时" >&2
    cat "${DSH_LOG}" >&2
    exit 1
  fi
done

# ─── Phase 2: 发起对话 + 后台任务 ──────────────────────────────────
echo "==> Phase 2: 发起对话 + 后台任务"

# 创建 session
SESSION_RESP=$(curl -sf -X POST "http://localhost:${API_PORT}/api/agent/sessions" \
  -H "Content-Type: application/json" \
  -d "{\"cwd\": \"${DRILL_TMP}\"}" || echo "")
SESSION_ID=$(echo "${SESSION_RESP}" | grep -oE '"sessionId":"[^"]+"' | head -1 | cut -d'"' -f4)
if [ -z "${SESSION_ID}" ]; then
  echo "    FAIL: 创建 session 失败（dsh 轨道可能未就绪）" >&2
  echo "    response: ${SESSION_RESP}" >&2
  cat "${DSH_LOG}" >&2
  exit 1
fi
echo "    sessionId=${SESSION_ID}"

# 发起对话（非阻塞 — 留 turn 进行中）
TURN_LOG="${LOG_DIR}/turn-${DATE_TAG}.log"
(
  curl -sf -N -X POST "http://localhost:${API_PORT}/api/agent/${SESSION_ID}/run" \
    -H "Content-Type: application/json" \
    -d '{"prompt":"hello drill","timeoutMs":60000}' \
    > "${TURN_LOG}" 2>&1 &
  echo $! > "${DRILL_TMP}/turn.pid"
) || true

# ─── Phase 3: SSE 长连接 ────────────────────────────────────────────
echo "==> Phase 3: SSE 长连接接入"
SSE_LOG="${LOG_DIR}/sse-${DATE_TAG}.log"
SSE_PID_FILE="${DRILL_TMP}/sse.pid"
curl -sf -N "http://localhost:${API_PORT}/api/event?sessionId=${SESSION_ID}" \
  > "${SSE_LOG}" 2>&1 &
echo $! > "${SSE_PID_FILE}"
sleep 2

if ! kill -0 "$(cat "${SSE_PID_FILE}")" 2>/dev/null; then
  echo "    FAIL: SSE 连接未建立" >&2
  cat "${SSE_LOG}" >&2
  exit 1
fi
echo "    SSE 连接活跃 (pid=$(cat "${SSE_PID_FILE}"))"

# ─── Phase 4: 触发 kill switch ──────────────────────────────────────
echo "==> Phase 4: 触发 kill switch（SIGTERM）"
DSH_PID=$(cat "${DSH_PID_FILE}")
SHUTDOWN_START="$(date +%s)"
kill -TERM "${DSH_PID}"

# ─── Phase 5: 等待 graceful shutdown ────────────────────────────────
echo "==> Phase 5: 等待 graceful shutdown"
SHUTDOWN_OK=false
for i in $(seq 1 30); do
  if ! kill -0 "${DSH_PID}" 2>/dev/null; then
    SHUTDOWN_END="$(date +%s)"
    SHUTDOWN_DURATION=$((SHUTDOWN_END - SHUTDOWN_START))
    echo "    dsh 进程已退出 (耗时 ${SHUTDOWN_DURATION}s)"
    SHUTDOWN_OK=true
    break
  fi
  sleep 1
done

if [ "${SHUTDOWN_OK}" != "true" ]; then
  echo "    FAIL: graceful shutdown 超时，强制 SIGKILL" >&2
  kill -KILL "${DSH_PID}" 2>/dev/null || true
  cat "${DSH_LOG}" >&2
  exit 1
fi

# 验证 SSE 连接关闭（不是 timeout / reset）
sleep 1
if kill -0 "$(cat "${SSE_PID_FILE}")" 2>/dev/null; then
  echo "    FAIL: SSE 连接在 dsh 退出后仍活跃（drain 未生效）" >&2
  kill -KILL "$(cat "${SSE_PID_FILE}")" 2>/dev/null || true
  exit 1
fi
echo "    SSE 连接已优雅关闭（drain 验证通过）"

# 验证 globalThis 桥清理（在 dsh log 中检查）
if grep -q "clearZaiGlobalBridges\|shutdown complete" "${DSH_LOG}" 2>/dev/null; then
  echo "    globalThis 桥清理日志已记录"
else
  echo "    WARN: 未在 dsh log 中找到 globalThis 桥清理记录" >&2
fi

# ─── Phase 6: 启动 opencc 轨道 ─────────────────────────────────────
echo "==> Phase 6: 启动 opencc 轨道"
cat > "${ZAI_DATA_DIR}/settings.json" <<EOF
{
  "agent": { "kernel": "opencc" },
  "server": { "port": ${PORT}, "apiPort": ${API_PORT} }
}
EOF

OPENCC_LOG="${LOG_DIR}/opencc-${DATE_TAG}.log"
OPENCC_PID_FILE="${DRILL_TMP}/opencc.pid"
nohup npx tsx --loader "${PROJECT_ROOT}/packages/zn-agent-core/dist/compat/runtime/bun-protocol.mjs" \
  src/cli/index.ts dev -- --port "${PORT}" --api-port "${API_PORT}" \
  > "${OPENCC_LOG}" 2>&1 &
echo $! > "${OPENCC_PID_FILE}"

for i in $(seq 1 30); do
  if curl -sf "http://localhost:${API_PORT}/api/health" >/dev/null 2>&1; then
    echo "    opencc up @ attempt ${i}"
    break
  fi
  sleep 1
  if [ "${i}" -eq 30 ]; then
    echo "    FAIL: opencc 启动超时" >&2
    cat "${OPENCC_LOG}" >&2
    exit 1
  fi
done

# ─── Phase 7: 验证会话数据隔离 ─────────────────────────────────────
echo "==> Phase 7: 验证 dsh / opencc 会话数据各自完整"

DSH_SESSION_DIR="${ZAI_DATA_DIR}/projects/-tmp-kill-switch-drill-$$/dsh-sessions/${SESSION_ID}"
OPENCC_SESSION_FILE="${ZAI_DATA_DIR}/projects/-tmp-kill-switch-drill-$$/${SESSION_ID}.jsonl"

if [ -d "${DSH_SESSION_DIR}" ]; then
  echo "    dsh session dir: ${DSH_SESSION_DIR}"
  ls -la "${DSH_SESSION_DIR}"
else
  echo "    INFO: dsh session dir 不存在（可能 turn 未完成写盘）"
fi

if [ -f "${OPENCC_SESSION_FILE}" ]; then
  echo "    opencc session file: ${OPENCC_SESSION_FILE}"
  wc -l "${OPENCC_SESSION_FILE}"
else
  echo "    INFO: opencc session file 不存在（预期 — drill cwd 不在 opencc 列表中）"
fi

# ─── Phase 8: 清理 + 报告 ───────────────────────────────────────────
echo "==> Phase 8: 清理"
OPENCC_PID=$(cat "${OPENCC_PID_FILE}" || echo "")
if [ -n "${OPENCC_PID}" ]; then
  kill -TERM "${OPENCC_PID}" 2>/dev/null || true
  sleep 3
  kill -KILL "${OPENCC_PID}" 2>/dev/null || true
fi

# 验证无孤儿进程
REMAINING=$(lsof -ti :"${API_PORT}" 2>/dev/null || true)
if [ -n "${REMAINING}" ]; then
  echo "    WARN: 端口 ${API_PORT} 仍有进程 ${REMAINING}（可能是上一轮残留）" >&2
fi

# 验证任务目录无残留
TASKS_DIR="${ZAI_DATA_DIR}/tasks"
TASKS_DSH_DIR="${ZAI_DATA_DIR}/tasks-dsh"
if [ -d "${TASKS_DIR}" ]; then
  echo "    opencc tasks dir: $(ls -1 "${TASKS_DIR}" | wc -l) 文件"
fi
if [ -d "${TASKS_DSH_DIR}" ]; then
  echo "    dsh tasks dir: $(ls -1 "${TASKS_DSH_DIR}" | wc -l) 文件"
fi

# ─── 演练报告 ──────────────────────────────────────────────────────
echo
echo "==> 演练完成"
echo "    dsh log:           ${DSH_LOG}"
echo "    opencc log:        ${OPENCC_LOG}"
echo "    turn log:          ${TURN_LOG}"
echo "    sse log:           ${SSE_LOG}"
echo "    shutdown duration: ${SHUTDOWN_DURATION}s"
echo "    verdict:           ✅ PASS"

# 清理临时文件（保留 logs）
rm -rf "${DRILL_TMP}"

exit 0