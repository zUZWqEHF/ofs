#!/usr/bin/env bash
# Action: query-topology
# 查询 ByteGraph MCP 获取 PSM 拓扑信息
# 输入: PSM (参数 $1)
# 输出: JSON 到 stdout，同时写入 instances/services/<psm>.yaml
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ONTOLOGY_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$(dirname "$ONTOLOGY_DIR")")"

if [ -f "$PROJECT_DIR/.env.local" ]; then
  set -a; source "$PROJECT_DIR/.env.local"; set +a
fi

PSM="${1:?Usage: query-topology.sh <psm>}"
MCP_URL="${BYTEGRAPH_MCP_URL:-http://cis-sre-cmdb-bytegraph-mcp.bytedance.net/mcp}"

# 初始化 MCP session
SESSION_ID=$(curl -s -i -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ontology-action","version":"1.0.0"}}}' 2>/dev/null \
  | grep -i 'Mcp-Session-Id' | awk '{print $2}' | tr -d '\r')

if [ -z "$SESSION_ID" ]; then
  echo '{"error": "MCP session init failed"}' >&2
  exit 1
fi

# 查询依赖
DEPS=$(curl -s -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"execute_gremlin\",\"arguments\":{\"query\":\"g.V().has(\\\"type\\\",\\\"Service\\\").has(\\\"id\\\",\\\"${PSM}:tce\\\").in(\\\"INSTANCE_OWNED_BY\\\").out(\\\"DEPENDS_ON\\\").properties(\\\"id\\\")\"}}}")

# 查询部署
DEPLOY=$(curl -s -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"execute_gremlin\",\"arguments\":{\"query\":\"g.V().has(\\\"type\\\",\\\"Service\\\").has(\\\"id\\\",\\\"${PSM}:tce\\\").in(\\\"INSTANCE_OWNED_BY\\\").out(\\\"DEPLOYED_IN\\\").properties(\\\"id\\\")\"}}}")

# 写入实例文件
INSTANCE_DIR="$ONTOLOGY_DIR/instances/services"
mkdir -p "$INSTANCE_DIR"
SAFE_PSM=$(echo "$PSM" | tr '.' '-')

cat > "$INSTANCE_DIR/${SAFE_PSM}.yaml" << EOF
# Instance: service/$PSM
# Generated: $(date -Iseconds)
type: service
psm: "$PSM"
topology:
  dependencies: $(echo "$DEPS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('content',[{}])[0].get('text','[]'))" 2>/dev/null || echo "[]")
  deployment: $(echo "$DEPLOY" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('result',{}).get('content',[{}])[0].get('text','[]'))" 2>/dev/null || echo "[]")
EOF

echo "{\"psm\": \"$PSM\", \"instance_file\": \"$INSTANCE_DIR/${SAFE_PSM}.yaml\"}"
