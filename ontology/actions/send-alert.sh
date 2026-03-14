#!/usr/bin/env bash
# Action: send-alert
# 发送消息到飞书告警群
# 输入: 消息文本 ($1) 或 --file <path>
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../../../" && pwd)"
if [ -f "$PROJECT_DIR/.env.local" ]; then
  set -a; source "$PROJECT_DIR/.env.local"; set +a
fi

CHAT_ID="${ALERT_CHAT_ID:-oc_a6ff58eb04a1e2792b430caa9dd05790}"

if [ "${1:-}" = "--file" ]; then
  MESSAGE=$(cat "$2")
else
  MESSAGE="${1:?Usage: send-alert.sh <message> | send-alert.sh --file <path>}"
fi

cd "$PROJECT_DIR"
npx tsx scripts/feishu-im.ts send-to-chat \
  --chat-id "$CHAT_ID" \
  --message "$MESSAGE"
