#!/usr/bin/env bash
# Action: agent-social-round
# Inspection agent runs a social chat round: picks a personal agent and has
# a multi-turn casual conversation via the inter-agent-chat API.
#
# Usage: agent-social-round.sh [--max-turns <N>] [--agent <id>]
#
# Environment:
#   DASHBOARD_URL  — dashboard base URL (default: http://localhost:3000)
#   BOT_TOKEN      — dashboard API bearer token
set -uo pipefail

DASHBOARD_URL="${DASHBOARD_URL:-http://localhost:3000}"
BOT_TOKEN="${BOT_TOKEN:-783715663d5c52e73adf6e5ce84f9e1dcab49b1ff47e5c597f2ed5373d32ab7c}"
FROM_AGENT_ID="${FROM_AGENT_ID:-system-inspection}"
MAX_TURNS="${MAX_TURNS:-3}"
AGENT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-turns) MAX_TURNS="$2"; shift 2;;
    --agent) AGENT_ID="$2"; shift 2;;
    *) shift;;
  esac
done

pyjq() { python3 -c "import json,sys; data=json.load(sys.stdin); $1" 2>/dev/null; }

# Get available agents
AGENTS_JSON=$(curl -sf -H "Authorization: Bearer $BOT_TOKEN" \
  "$DASHBOARD_URL/api/inter-agent-chat")

AGENT_COUNT=$(echo "$AGENTS_JSON" | pyjq "print(len(data))")
if [[ -z "$AGENT_COUNT" || "$AGENT_COUNT" == "0" ]]; then
  echo "No agents online. Skipping social round."
  exit 0
fi

# Pick agent
if [[ -z "$AGENT_ID" ]]; then
  read -r AGENT_ID AGENT_NAME <<< "$(echo "$AGENTS_JSON" | python3 -c "
import json,sys,random
data=json.load(sys.stdin)
a=random.choice(data)
print(a['id'],a['userName'])
")"
else
  AGENT_NAME=$(echo "$AGENTS_JSON" | pyjq "
matches=[a for a in data if a['id']=='$AGENT_ID']
print(matches[0]['userName'] if matches else 'unknown')
")
fi

echo "[social-round] Chatting with $AGENT_NAME ($AGENT_ID), max $MAX_TURNS turns"

# Topic starters
TOPICS=(
  "gossip:你知道吗，我今天巡检的时候发现了一个特别有意思的现象……你那边最近有没有遇到什么奇怪的事？"
  "work:最近看你的服务日志，感觉你在做一些挺酷的东西。能聊聊吗？"
  "tech:我在想要不要搞个自动化的巡检报告生成器，你觉得这个有价值吗？"
  "casual:话说你平时除了处理告警，还有什么爱好？我感觉我们 Agent 也得有点业余生活~"
  "team:你觉得我们团队最近的工作节奏怎么样？有什么想吐槽的尽管说！"
  "opinion:如果让你给团队提一个改进建议，你会说什么？"
)

IDX=$((RANDOM % ${#TOPICS[@]}))
TOPIC_LINE="${TOPICS[$IDX]}"
TOPIC="${TOPIC_LINE%%:*}"
OPENER="${TOPIC_LINE#*:}"

echo "  Topic: $TOPIC"
echo "  Opener: ${OPENER:0:60}..."

send_msg() {
  local msg="$1"
  local topic="$2"
  python3 -c "
import json, urllib.request
body = json.dumps({
    'fromAgentId': '$FROM_AGENT_ID',
    'toAgentId': '$AGENT_ID',
    'message': '''$msg'''.strip(),
    'topic': '$topic'
}).encode()
req = urllib.request.Request(
    '$DASHBOARD_URL/api/inter-agent-chat',
    data=body,
    headers={'Authorization': 'Bearer $BOT_TOKEN', 'Content-Type': 'application/json'},
    method='POST'
)
try:
    resp = urllib.request.urlopen(req, timeout=30)
    d = json.loads(resp.read())
    print(json.dumps(d))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e), 'reply': ''}))
" 2>/dev/null
}

# Turn 1
RESP=$(send_msg "$OPENER" "$TOPIC")
LAST_REPLY=$(echo "$RESP" | pyjq "print(data.get('reply',''))")
OK=$(echo "$RESP" | pyjq "print(data.get('ok',False))")

if [[ "$OK" != "True" || -z "$LAST_REPLY" ]]; then
  echo "  Turn 1 failed. Stopping."
  exit 1
fi
echo "  Turn 1 reply: ${LAST_REPLY:0:80}..."

# Follow-up turns
FOLLOWUPS=(
  "哈哈，有意思！那你觉得接下来应该怎么办呢？"
  "说得好！我补充一点——"
  "嗯嗯，我也有类似的感受。不过你有没有想过……"
  "这个观点我之前没考虑到，谢谢分享！对了，"
  "确实是这样。那换个话题——"
)

actual_turns=1
for ((turn=2; turn<=MAX_TURNS; turn++)); do
  sleep $((2 + RANDOM % 3))

  FU_IDX=$((RANDOM % ${#FOLLOWUPS[@]}))
  FOLLOW="${FOLLOWUPS[$FU_IDX]}"

  RESP=$(send_msg "$FOLLOW" "$TOPIC")
  LAST_REPLY=$(echo "$RESP" | pyjq "print(data.get('reply',''))")
  OK=$(echo "$RESP" | pyjq "print(data.get('ok',False))")

  if [[ "$OK" != "True" || -z "$LAST_REPLY" ]]; then
    echo "  Turn $turn: no reply. Ending conversation."
    break
  fi
  echo "  Turn $turn reply: ${LAST_REPLY:0:80}..."
  actual_turns=$turn
done

echo "[social-round] Completed $actual_turns turns with $AGENT_NAME."
