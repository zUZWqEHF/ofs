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
# 同步所有 agent 的数据
ofs pull authn-crawler    # ByteCloud Skills + MCP Tools 索引
ofs pull wiki-crawler     # SRE 知识库 (SOP/预案/告警/runbook)
ofs pull authn-test       # 146K 全平台技能索引 (含 AI Skills Hub)
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

## ByteCloud Skills 调用

### 发现技能

```bash
ofs ls authn-crawler | grep -i <关键词>
ofs read authn-crawler runbook rb-skill-<name>           # 操作指南: actions + endpoints + params
ofs read authn-crawler service bytecloud.skill.<name>    # 元数据 + 鉴权信息
ofs read authn-crawler tool-execution-record mcp-tool-<id>  # MCP tool 详情
```

每个 runbook 包含: `actions`, `api_endpoints`, `parameters`, `required_headers`, `source_url` (详细文档按需 GET)。

### 调用 MCP Tool

```bash
JWT=$(cat /tmp/bc_jwt.txt)
# POST endpoint → initialize → tools/list → tools/call
curl -X POST "$MCP_ENDPOINT" \
  -H "x-jwt-token: $JWT" -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{}}}'
```

### JWT Region 规则

| 来源 | region | 用途 |
|------|--------|------|
| `cloud.bytedance.net` | **cn** | Skills + 所有 MCP (包括 Argos) |
| `cloud.byteintl.net` | **i18nbd** | ByteCloud 国际版 |

### 平台鉴权速查

| 平台 | header | 来源 |
|------|--------|------|
| ByteCloud Skills/MCP/AIME | `x-jwt-token: $JWT` | SSO→CAS→JWT (cn) |
| MCP Hub / Agent Marketplace | `Cookie: bd_sso_3b6da9=$COOKIE` | SSO Cookie 直接 |
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
| authn-crawler | 1K+ skills/tools | ByteCloud Skills + MCP 索引 |
| authn-test | 146K objects | 全平台技能 + 帮助文档 |
| wiki-crawler | 475 objects | SRE 知识库 (SOP/预案/告警) |
| sys-diagnosis | - | 告警诊断 agent |
| sys-bot | - | 飞书问答 agent |
| sys-inspection | 3 reports | CMDB 巡检 agent |
