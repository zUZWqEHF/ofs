#!/usr/bin/env bash
# Action: query-metrics
# 查询 Argos 监控指标
# 输入: PSM ($1), 指标类型 ($2, 可选: success_rate|latency|qps)
# 输出: JSON 到 stdout
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../../../" && pwd)"
if [ -f "$PROJECT_DIR/.env.local" ]; then
  set -a; source "$PROJECT_DIR/.env.local"; set +a
fi

PSM="${1:?Usage: query-metrics.sh <psm> [metric_type]}"
METRIC_TYPE="${2:-success_rate}"
ARGOS_URL="${ARGOS_MCP_BASE_URL:-}"
ARGOS_TOKEN="${ARGOS_AUTH_TOKEN:-}"

if [ -z "$ARGOS_URL" ]; then
  echo '{"error": "ARGOS_MCP_BASE_URL not set"}' >&2
  exit 1
fi

# Argos SSE 查询
curl -s -N "${ARGOS_URL}/sse" \
  -H "Authorization: Bearer $ARGOS_TOKEN" \
  -d "{\"psm\": \"$PSM\", \"metric\": \"$METRIC_TYPE\", \"duration\": \"1h\"}" 2>/dev/null \
  | head -20
