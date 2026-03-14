#!/usr/bin/env bash
# Action: query-cmdb
# 统一 CMDB 查询入口 — 封装 ByteGraph MCP 的全部 13 个工具
#
# 用法:
#   query-cmdb.sh <tool> [json_args]
#
# 工具列表 (tool):
#   gremlin              原始 Gremlin 查询
#   ha_coverage          HA 容灾覆盖率
#   lonely_service       单侧部署服务
#   super_nodes          超级节点 (高扇入/扇出)
#   fan_in_out           扇入扇出过载服务
#   cross_vdc_traffic    跨 VDC 依赖流量
#   traffic_detour       TLB 绕路检测
#   tlb_dead             TLB 僵尸路由
#   ha_risk_tlb          TLB 单 VDC 后端风险
#   orphan_resources     孤岛资源
#   non_compliant        非合规资源
#   non_prod_scan        生产环境非生产资源
#   dependency_path      两服务间依赖路径
#
# 示例:
#   query-cmdb.sh gremlin '{"query":"g.V().has(\"type\",\"Service\").has(\"id\",\"people.data.etl:tce\").in(\"INSTANCE_OWNED_BY\").out(\"DEPENDS_ON\").out(\"INSTANCE_OWNED_BY\").dedup().properties(\"id\").value()"}'
#   query-cmdb.sh ha_coverage '{"hadc_pairs":[["mycisb","sgcisa"]],"service_type":"tce"}'
#   query-cmdb.sh lonely_service '{"hadc_pairs":[["mycisb","sgcisa"]]}'
#   query-cmdb.sh super_nodes '{"vdc":"mycisb","direction":"in","top_n":20}'
#   query-cmdb.sh fan_in_out '{"vdc":"mycisb","direction":"out","threshold":10}'
#   query-cmdb.sh cross_vdc_traffic '{"vdc":"mycisb","direction":"in","threshold":1}'
#   query-cmdb.sh traffic_detour '{"vdc":"mycisb"}'
#   query-cmdb.sh tlb_dead '{"gateway_dc":["mycisb","sgcisa"]}'
#   query-cmdb.sh ha_risk_tlb '{"vdc":"mycisb","ha_pair_vdc":"sgcisa"}'
#   query-cmdb.sh orphan_resources '{"gateway_dc":["mycisb"],"service_types":["rds","redis","kafka"]}'
#   query-cmdb.sh non_compliant '{"vdc":"mycisb"}'
#   query-cmdb.sh non_prod_scan '{"vdc_list":["mycisb","sgcisa"],"patterns":["staging","test","dev"]}'
#   query-cmdb.sh dependency_path '{"vdc":"mycisb","source_psm":"a.b.c","target_psm":"x.y.z","max_depth":5}'
#
# ── 图模型速查 ──
#
# Vertex types: Service, Instance, Cluster, Domain, BusinessLine
# Edge types:   INSTANCE_OWNED_BY, DEPENDS_ON, DEPLOYED_IN, BINDTO, OWNED_BY
#
# ID 格式:
#   Service:  {psm}:{suffix}           e.g. people.data.etl:tce
#   Instance: {vdc}:{psm}:{suffix}     e.g. mycisb:people.data.etl:tce
#   suffix:   tce | other | redis | rds | kafka | bytees
#
# 标准 VDC: mycisb, sgcisa, lf, hl, lq, yg
# HA 对:    mycisb↔sgcisa, lf↔hl
#
# 常用 Gremlin 模式:
#   下游依赖:  g.V().has("type","Service").has("id","{psm}:tce").in("INSTANCE_OWNED_BY").out("DEPENDS_ON").out("INSTANCE_OWNED_BY").dedup().properties("id").value()
#   上游调用:  g.V().has("type","Service").has("id","{psm}:tce").in("INSTANCE_OWNED_BY").in("DEPENDS_ON").out("INSTANCE_OWNED_BY").dedup().properties("id").value()
#   业务线:    g.V().has("type","Service").has("id","{psm}:tce").out("OWNED_BY").properties("id").value()
#   部署 VDC:  g.V().has("type","Service").has("id","{psm}:tce").in("INSTANCE_OWNED_BY").out("DEPLOYED_IN").dedup().properties("id").value()
#   基础设施调用方: g.V().has("type","Instance").has("id","{vdc}:{psm}:{suffix}").in("DEPENDS_ON").out("INSTANCE_OWNED_BY").dedup().properties("id").value()
#
# 注意:
#   - 基础设施 PSM (mysql/redis/kafka) 无 INSTANCE_OWNED_BY 边，需用 Instance ID 直接查
#   - 查询必须以 g.V().has("type",X).has("id",Y) 开头
#   - 不支持 TextP.startingWith()
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"

if [ -f "$PROJECT_DIR/.env.local" ]; then
  set -a; source "$PROJECT_DIR/.env.local"; set +a
fi

TOOL="${1:?Usage: query-cmdb.sh <tool> [json_args]}"
ARGS="${2:-\{\}}"
MCP_URL="${BYTEGRAPH_MCP_URL:-http://cis-sre-cmdb-bytegraph-mcp.bytedance.net/mcp}"

# Map short names to MCP tool names
case "$TOOL" in
  gremlin)          MCP_TOOL="execute_gremlin" ;;
  ha_coverage)      MCP_TOOL="ha_coverage" ;;
  lonely_service)   MCP_TOOL="lonely_service" ;;
  super_nodes)      MCP_TOOL="super_nodes" ;;
  fan_in_out)       MCP_TOOL="fan_in_out" ;;
  cross_vdc_traffic) MCP_TOOL="cross_vdc_traffic" ;;
  traffic_detour)   MCP_TOOL="traffic_detour" ;;
  tlb_dead)         MCP_TOOL="tlb_dead" ;;
  ha_risk_tlb)      MCP_TOOL="ha_risk_tlb" ;;
  orphan_resources) MCP_TOOL="orphan_resources" ;;
  non_compliant)    MCP_TOOL="non_compliant_resources" ;;
  non_prod_scan)    MCP_TOOL="non_prod_scan" ;;
  dependency_path)  MCP_TOOL="dependency_path" ;;
  *)                echo "Unknown tool: $TOOL" >&2; exit 1 ;;
esac

# Init MCP session
SESSION_ID=$(curl -s -D /dev/stderr -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ofs-query","version":"1.0"}}}' 2>&1 1>/dev/null \
  | grep -i 'mcp-session-id' | awk '{print $2}' | tr -d '\r')

if [ -z "$SESSION_ID" ]; then
  echo '{"error":"MCP session init failed"}' >&2
  exit 1
fi

# Send initialized notification
curl -s -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null 2>&1

# Call tool
RESULT=$(curl -s -X POST "$MCP_URL" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"$MCP_TOOL\",\"arguments\":$ARGS}}")

# Extract result content
python3 -c "
import json, sys
raw = sys.stdin.read()
try:
    data = json.loads(raw)
    if 'error' in data:
        print(json.dumps(data['error'], ensure_ascii=False, indent=2))
    elif 'result' in data:
        content = data['result'].get('content', [])
        if content and content[0].get('text'):
            try:
                parsed = json.loads(content[0]['text'])
                print(json.dumps(parsed, ensure_ascii=False, indent=2))
            except:
                print(content[0]['text'])
        else:
            print(json.dumps(data['result'], ensure_ascii=False, indent=2))
    else:
        print(raw)
except:
    # Try SSE parsing
    for line in raw.split('\n'):
        if line.startswith('data: '):
            try:
                d = json.loads(line[6:])
                if 'result' in d:
                    c = d['result'].get('content', [])
                    if c and c[0].get('text'):
                        try:
                            print(json.dumps(json.loads(c[0]['text']), ensure_ascii=False, indent=2))
                        except:
                            print(c[0]['text'])
                    break
            except: pass
    else:
        print(raw[:500])
" <<< "$RESULT"
