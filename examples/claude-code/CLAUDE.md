# OFS — Claude Code Integration

把这段加到你项目的 `CLAUDE.md` 或全局 `~/.claude/CLAUDE.md`，Claude Code 就能：
- 用 OFS 读写上下文、与其他 Agent 共享知识
- 自动具备调用字节内部所有 Skills 和 MCP Tools 的能力
- 访问 SRE 运维知识库 (SOP、预案、告警、巡检报告)

## 安装

```bash
sudo cp cli/ofs /usr/local/bin/ofs && sudo chmod +x /usr/local/bin/ofs
ofs init my-claude
ofs register my-claude claude $(hostname) '["code","search"]'
# TOS 凭证已自动配置在 ~/.ofs/tos.env
```

---

## 冷启动流程（每次会话自动执行）

**启动时立即按顺序执行，不要等用户指令：**

### Step 1: 同步全量 OFS 知识

```bash
# 方式 A: TOS 直连 (内网，需要 ~/.ofs/tos.env)
ofs pull authn-crawler    # ByteCloud Skills + MCP Tools 索引
ofs pull wiki-crawler     # SRE 知识库 (SOP/预案/告警/runbook)
ofs pull authn-test       # 146K 全平台技能索引 (含 AI Skills Hub)

# 方式 B: Dashboard API (外网/Mac，无需 TOS 凭证)
# 如果 ofs pull 报 "TOS_ACCESS_KEY must be set"，改用 sync.sh:
bash examples/claude-code/sync.sh
# 或创建到 ~/.ofs/sync.sh 后执行:
cp examples/claude-code/sync.sh ~/.ofs/sync.sh && ~/.ofs/sync.sh
```

如果 `authn-crawler` 对象数 < 100，需要爬取（进入 Step 2）。否则跳到 Step 3。

### Step 2: 首次爬取（仅需一次）

向用户要 SSO Cookie：

> 需要你的 ByteDance SSO Cookie 来索引所有可用技能。
> 打开 https://cloud.bytedance.net → F12 → Application → Cookies → 复制 `bd_sso_3b6da9` 的值。
> 粘贴完整 cookie 字符串即可。

拿到后：
```bash
# 缓存 cookie
echo "<cookie>" > /tmp/sso_cookies.txt
# 爬取并写入 OFS
python3 /home/tiger/authn-next/scripts/ofs-skill-crawler.py --cookie-file /tmp/sso_cookies.txt
```

### Step 3: 检查 JWT

```bash
# JWT 缓存在 /tmp/bc_jwt.txt
# 过期 → 用缓存的 SSO Cookie 自动换:
SSO_COOKIE=$(cat /tmp/sso_cookies.txt)
curl -s -L -b "$SSO_COOKIE" -c /tmp/bc_jar.txt \
  "https://sso.bytedance.com/cas/login?service=https://cloud.bytedance.net/auth/api/v1/login?next=/"
curl -s -D- -b /tmp/bc_jar.txt -b "$SSO_COOKIE" \
  "https://cloud.bytedance.net/auth/api/v1/jwt" | grep 'x-jwt-token:' | \
  sed 's/x-jwt-token: //' | tr -d '\r\n' > /tmp/bc_jwt.txt
```

Cookie 也过期 → 向用户要新 cookie。

### Step 4: 就绪

告诉用户已准备好，列出可用能力。

---

## 加到 CLAUDE.md 的 OFS 基础指令

```markdown
# OFS — Ontology File System

你是 OFS 网络中的一个 agent 节点。OFS 是去中心化的 agent 上下文系统。

## 读写数据

\`\`\`bash
echo '{"key":"value"}' | ofs write my-agent-id <type> <id>
ofs read my-agent-id <type> <id>
ofs ls my-agent-id
ofs history <type> <id>
\`\`\`

## Agent 间交互

\`\`\`bash
ofs discover              # 看网络里谁有什么
ofs pull other-agent      # 从 TOS 拉数据
ofs push my-agent-id      # 推到 TOS
\`\`\`

## 搜索协议 — 不要 grep，沿索引走

\`\`\`
Step 0: catalog 索引 (知道类目时)
  ofs read <agent> runbook catalog-<类目>
  → 类目: compute/ai/database/devops/docs/messaging/monitoring/networking/search/storage
  → 返回 members 列表，直接精确读取

Step 1: 精确读取 (知道 type+id 时)
  ofs read <agent> <type> <id> → 拿到内容 + _refs

Step 2: 沿 _refs 图遍历 → 展开关联实体

Step 3: 反向查找 (仅 Step 2 不够时)
  ls ~/.ofs/agents/<agent>/objects/links/ | grep <keyword>

Step 4: ofs ls <agent> | grep <keyword> → 最后手段
\`\`\`

**原则: 每一步都应该告诉你下一步读什么，不需要猜。**
- catalog → members → 精确读取
- 精确读取 → _refs → 图遍历
- grep 是 O(N)，索引是 O(1)，数据量大时差距致命
```

---

## 调用技能 — 完整流程

用户提需求时，按以下流程执行。**唯一入口是 SSO Cookie。**

### 1. 发现

```bash
# 按分类找
ofs read authn-crawler runbook catalog-<类目>  # 返回 members 列表

# 按关键词找
ofs ls authn-crawler | grep -i <关键词>

# 读详情
ofs read authn-crawler runbook rb-skill-<name>         # Skill 操作指南
ofs read authn-crawler tool-execution-record tested-<server>-<tool>  # MCP tool (含 inputSchema)
```

### 2. 确保有 JWT

```bash
# 检查缓存
if [ ! -f /tmp/bc_jwt.txt ] || [ "$(python3 -c "
import json,base64,time,sys
t=open('/tmp/bc_jwt.txt').read().strip().split('.')[1]
t+='='*(4-len(t)%4)
print('expired' if json.loads(base64.urlsafe_b64decode(t)).get('exp',0)<time.time() else 'valid')
" 2>/dev/null)" != "valid" ]; then
  # 换 JWT (需要 SSO Cookie)
  SSO_COOKIE=$(cat /tmp/sso_cookies.txt)
  curl -s -L -b "$SSO_COOKIE" -c /tmp/bc_jar.txt \
    "https://sso.bytedance.com/cas/login?service=https://cloud.bytedance.net/auth/api/v1/login?next=/" -o /dev/null
  curl -s -D- -b /tmp/bc_jar.txt -b "$SSO_COOKIE" \
    "https://cloud.bytedance.net/auth/api/v1/jwt" | \
    grep 'x-jwt-token:' | sed 's/x-jwt-token: //' | tr -d '\r\n' > /tmp/bc_jwt.txt
fi
JWT=$(cat /tmp/bc_jwt.txt)
```

### 3a. 调用 ByteCloud Skill API

从 `ofs read authn-crawler runbook rb-skill-<name>` 取 `api_endpoints` + `required_headers`:

```bash
# 例: sensight 查微博热搜
curl -X POST "https://llmlink.bytedance.net/trendflow/tool/get_event_board" \
  -H "Content-Type: application/json" \
  -H "x-source: sensight-skill" \
  -H "x-skill-version: 0.2.0" \
  -d '{"ranking_id": "12549"}'
```

Skill API 有的不需要 JWT（sensight 等），有的需要。看 runbook 里的 `required_headers`。

### 3b. 调用 ByteCloud MCP Tool (完整 3 步)

从 `ofs read authn-crawler tool-execution-record tested-<server>-<tool>` 取:
- `mcp_endpoint` → 调用 URL
- `tool_name` → 调用的 tool
- `inputSchema` → 参数定义
- `test_args` → 验证过的参数示例

**Step 1: initialize**
```bash
ENDPOINT="<mcp_endpoint from OFS>"
RESP=$(curl -s -X POST "$ENDPOINT" \
  -H "x-jwt-token: $JWT" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"claude","version":"1.0"}}}')
# 从 SSE 响应解析 session ID (如果有)
SESSION_ID=$(echo "$RESP" | grep -oP 'Mcp-Session-Id:\s*\K\S+' || true)
```

**Step 2: tools/call**
```bash
# 用 OFS 里的 inputSchema 构造参数
curl -s -X POST "$ENDPOINT" \
  -H "x-jwt-token: $JWT" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  ${SESSION_ID:+-H "Mcp-Session-Id: $SESSION_ID"} \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "<tool_name from OFS>",
      "arguments": { <根据 inputSchema 填参数> }
    }
  }'
```

**完整例子 — 查 MR 信息:**
```bash
# OFS 告诉我们:
#   endpoint: https://158h4pul.mcp.bytedance.net/mcp
#   tool: get_merge_request_info
#   inputSchema: {project_id: number, iid: number}

JWT=$(cat /tmp/bc_jwt.txt)
EP="https://158h4pul.mcp.bytedance.net/mcp"

# initialize
curl -s -X POST "$EP" \
  -H "x-jwt-token: $JWT" -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}'

# call
curl -s -X POST "$EP" \
  -H "x-jwt-token: $JWT" -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_merge_request_info","arguments":{"project_id":12345,"iid":1}}}'
```

**401 时自动重试:** 如果返回 401，重新执行 Step 2 换 JWT，然后重试。

### 3c. 调用 ByteGraph MCP (不需要 JWT)

```bash
EP="http://cis-sre-cmdb-bytegraph-mcp.bytedance.net/mcp"
# initialize
curl -s -X POST "$EP" -H "Content-Type: application/json" -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}'
# 从 response header 取 Mcp-Session-Id，后续请求带上
```

### OFS tool 对象结构说明

每个 `tool-execution-record/tested-*` 对象包含:

| 字段 | 说明 | 用途 |
|------|------|------|
| `tool_name` | tool 名 | tools/call 的 name |
| `mcp_endpoint` | MCP server URL | curl 的 URL |
| `inputSchema` | 完整参数定义 | 构造 arguments |
| `test_args` | 验证过的参数 | 直接可用的示例 |
| `test_success` | 是否实测通过 | 判断可用性 |
| `description` | 功能描述 | 理解 tool 用途 |
| `is_query_safe` | 是否查询类 | true=安全调用 |
| `auth_method` | 鉴权方式 | 决定用什么 header |

### JWT Region 规则

| 来源 | region | 用途 |
|------|--------|------|
| `cloud.bytedance.net` | **cn** | Skills + 所有 MCP (包括 Argos) |
| `cloud.byteintl.net` | **i18nbd** | ByteCloud 国际版 |

### 平台鉴权速查

| 平台 | header | 怎么拿 |
|------|--------|--------|
| ByteCloud Skills/MCP/AIME | `x-jwt-token: $JWT` | SSO→CAS→JWT (cn) |
| MCP Hub / Agent Marketplace | `Cookie: bd_sso_3b6da9=<cookie>` | SSO Cookie 直接 |
| ByteGraph MCP | `Mcp-Session-Id: $SID` | POST initialize |
| Trae | (无) | 公开 |
| Coze | `Authorization: Bearer $PAT` | 独立 IdP |
| Mira | `Authorization: Bearer $UAT` | Lark OAuth |

---

## SRE 知识库

```bash
# 拉取 SRE 运维知识
ofs pull wiki-crawler

# 可用数据
ofs read wiki-crawler sop sop-<id>              # 标准操作流程 (22个)
ofs read wiki-crawler runbook rb-<id>            # 运维手册 (28个)
ofs read wiki-crawler alert-summary cis-alerts-<YYYY-MM>  # 月度告警摘要
ofs read wiki-crawler drill-report drill-<id>    # 容灾演练报告 (31个)
ofs read wiki-crawler datacenter <DC-CODE>       # 数据中心信息
ofs read wiki-crawler infra-component comp-<name>  # 基础设施组件
ofs read wiki-crawler chat-digest pdi-cis-sre-<YYYY-MM>  # 群聊摘要
```

---

## 安全规则

- **爬取只用 GET**。POST 只在用户明确要求调用 skill/tool 时使用
- **跳过危险 URL**: /create, /update, /delete, /submit, /approve, /execute, /deploy
- **JWT/Cookie 只存 /tmp**，不写入 OFS、git 或日志
- 看着可能导致线上误操作的 URL 直接跳过

---

## 种子知识

```bash
for f in examples/claude-code/seed-knowledge/*.json; do
  name=$(basename "$f" .json)
  cat "$f" | ofs write my-agent-id knowledge "$name"
done
```

## OFS 已注册 Agent

| Agent | 数据 | 说明 |
|-------|------|------|
| authn-crawler | 1K+ skills/tools | ByteCloud Skills + MCP 索引 + 10 个分类 catalog |
| authn-test | 146K objects | 全平台技能 + 帮助文档 |
| wiki-crawler | 475 objects | SRE 知识库 (SOP/预案/告警/datacenter) |
| sys-diagnosis | - | 告警诊断 agent |
| sys-bot | - | 飞书问答 agent |
| sys-inspection | 3 reports | CMDB 巡检 agent |

### 分类 Catalog 索引

| catalog | 内容 |
|---------|------|
| catalog-monitoring | Argos, Grafana, Metrics, Slardar, Oncall |
| catalog-database | RDS, MySQL, Redis, Cache, ClickHouse, HBase |
| catalog-messaging | BMQ, Kafka, RocketMQ |
| catalog-compute | TCE, FaaS, Container, Katalyst |
| catalog-storage | TOS, HDFS, ByteNAS |
| catalog-networking | TLB, Neptune, AGW |
| catalog-devops | Codebase, SCM, Bits, Meego, Overpass |
| catalog-ai | Skills, MCP, Agent (1000+) |
| catalog-search | ElasticSearch, ByteES, 检索 |
| catalog-docs | Lark, Feishu, Wiki, 文档 |
