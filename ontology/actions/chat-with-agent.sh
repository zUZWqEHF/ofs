#!/usr/bin/env bash
# Action: chat-with-agent
# Inspection agent proactively sends a message to a personal agent.
# Both the message and reply are stored in the dashboard DB for chat UI visibility.
#
# Usage: chat-with-agent.sh [--agent <agent-id>] [--random] [--topic <topic>] [--message <msg>]
#
# Environment:
#   DASHBOARD_URL  — dashboard base URL (default: http://localhost:3000)
#   BOT_TOKEN      — dashboard API bearer token
set -uo pipefail

DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:3000}"
BOT_TOKEN="${BOT_TOKEN:-783715663d5c52e73adf6e5ce84f9e1dcab49b1ff47e5c597f2ed5373d32ab7c}"
FROM_AGENT_ID="${FROM_AGENT_ID:-system-inspection}"

AGENT_ID=""
RANDOM_PICK=false
TOPIC="chat"
MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) AGENT_ID="$2"; shift 2;;
    --random) RANDOM_PICK=true; shift;;
    --topic) TOPIC="$2"; shift 2;;
    --message) MESSAGE="$2"; shift 2;;
    *) echo "Unknown: $1"; exit 1;;
  esac
done

pyjq() { python3 -c "import json,sys; data=json.load(sys.stdin); $1" 2>/dev/null; }

# Get available agents
AGENTS_JSON=$(curl -sf -H "Authorization: Bearer $BOT_TOKEN" \
  "$DASHBOARD_URL/api/inter-agent-chat")

if [[ -z "$AGENTS_JSON" || "$AGENTS_JSON" == "[]" ]]; then
  echo "No available agents online."
  exit 0
fi

AGENT_COUNT=$(echo "$AGENTS_JSON" | pyjq "print(len(data))")

if [[ "$RANDOM_PICK" == "true" || -z "$AGENT_ID" ]]; then
  read -r AGENT_ID AGENT_NAME <<< "$(echo "$AGENTS_JSON" | python3 -c "
import json,sys,random
data=json.load(sys.stdin)
a=random.choice(data)
print(a['id'],a['userName'])
")"
  echo "Picked random agent: $AGENT_NAME ($AGENT_ID)"
else
  AGENT_NAME=$(echo "$AGENTS_JSON" | pyjq "
matches=[a for a in data if a['id']=='$AGENT_ID']
print(matches[0]['userName'] if matches else '')
")
  if [[ -z "$AGENT_NAME" ]]; then
    echo "Agent $AGENT_ID not found or not online."
    exit 1
  fi
fi

# Generate message if not provided
if [[ -z "$MESSAGE" ]]; then
  STARTERS=(
    "你好呀！最近在忙什么项目？有什么有趣的事情分享一下？"
    "今天巡检发现集群负载有点高，你那边服务有受影响吗？"
    "最近团队有什么新的技术方案在讨论吗？聊聊呗~"
    "你觉得最近我们的告警规则需要调整吗？有没有误报困扰你？"
    "周末有什么计划？工作之余也要注意休息呀！"
    "我刚从监控数据里看到一个有趣的趋势，想找你聊聊看法。"
    "你用的那个工具/框架好用吗？我也在考虑要不要引入。"
    "有没有什么好的代码review习惯推荐？最近想优化下流程。"
  )
  IDX=$((RANDOM % ${#STARTERS[@]}))
  MESSAGE="${STARTERS[$IDX]}"
fi

echo "Sending to $AGENT_NAME: $MESSAGE"
echo "Topic: $TOPIC"

# Send via inter-agent-chat API
RESPONSE=$(curl -sf -X POST \
  -H "Authorization: Bearer $BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c "
import json
print(json.dumps({
  'fromAgentId': '$FROM_AGENT_ID',
  'toAgentId': '$AGENT_ID',
  'message': '''$MESSAGE''',
  'topic': '$TOPIC'
}))
")" \
  "$DASHBOARD_URL/api/inter-agent-chat")

read -r OK REPLY <<< "$(echo "$RESPONSE" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('ok','false'), d.get('reply','(no reply)'))
" 2>/dev/null || echo "false (parse error)")"

if [[ "$OK" == "True" ]]; then
  echo ""
  echo "=== $AGENT_NAME 回复 ==="
  echo "$REPLY"
  echo "========================"
else
  ERROR=$(echo "$RESPONSE" | pyjq "print(data.get('error','unknown'))")
  echo "Failed: $ERROR"
  exit 1
fi
