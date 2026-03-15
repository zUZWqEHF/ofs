# OFS — Claude Code Integration

把这段加到你项目的 `CLAUDE.md` 或全局 `~/.claude/CLAUDE.md`，Claude Code 就能用 OFS 读写上下文、与其他 Agent 共享知识。

## 安装

ofs 是纯 bash 脚本，Linux/macOS 通用（依赖: bash, curl, python3）。

```bash
# 1. 把 CLI 放到 PATH (只需一次)
# Linux
sudo cp cli/ofs /usr/local/bin/ofs && sudo chmod +x /usr/local/bin/ofs

# macOS (Homebrew 用户也可以放 ~/bin/)
cp cli/ofs /usr/local/bin/ofs && chmod +x /usr/local/bin/ofs

# 2. 初始化
ofs init my-claude
ofs register my-claude claude $(hostname) '["code","search"]'

# 3a. (内网) 配置 TOS 实现 Agent 间共享
cat > ~/.ofs/tos.env << EOF
TOS_ACCESS_KEY=your_key
TOS_SECRET_KEY=your_secret
TOS_BUCKET=your_bucket
EOF

# 3b. (外网/Mac) 通过 Dashboard API 同步 — 无需 TOS 直连
#     创建 ~/.ofs/sync.sh 用于拉取共享数据:
cat > ~/.ofs/sync.sh << 'SYNCEOF'
#!/bin/bash
# OFS remote sync via Dashboard API (for external networks)
DASHBOARD_URL="${OFS_DASHBOARD_URL:-https://harness-admin-dashboard.byteintl.net}"
TOKEN="${OFS_SYNC_TOKEN:-harness-dev-2026-cis-sre}"
OFS_ROOT="${OFS_ROOT:-$HOME/.ofs}"

for agent in wiki-crawler; do
  echo "Syncing $agent..."
  data=$(curl -sf -H "Authorization: Bearer $TOKEN" "$DASHBOARD_URL/api/ofs/export?agent=$agent" 2>/dev/null)
  [ -z "$data" ] && echo "  failed to fetch $agent" && continue
  echo "$data" | python3 -c "
import json, sys, os
data = json.load(sys.stdin)
agent = data.get('agent_id','')
for obj in data.get('objects',[]):
    t, oid = obj['type'], obj['id']
    d = os.path.join(os.path.expanduser('~'), '.ofs', 'agents', agent, 'objects', t)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, oid + '.json'), 'w') as f:
        json.dump(obj['data'], f, ensure_ascii=False, indent=2)
print(f'  synced {len(data.get(\"objects\",[]))} objects for {agent}')
"
done
SYNCEOF
chmod +x ~/.ofs/sync.sh
```

## 加到 CLAUDE.md 的内容

把下面整段复制到你的 `CLAUDE.md`:

---

```markdown
# OFS — Ontology File System

你是 OFS 网络中的一个 agent 节点。OFS 是去中心化的 agent 上下文系统，每个 agent 拥有自己的数据空间，通过 TOS (对象存储) 共享上下文。没有中心 server。

## 快速上手

\`\`\`bash
ofs schema types          # 查看所有实体类型
ofs schema links          # 查看所有关系类型
ofs schema show <name>    # 查看具体定义
ofs agents                # 查看已注册的 agent
ofs whoami                # 查看 OFS 配置
\`\`\`

## 你的身份

使用 OFS 前先初始化自己。用你的 session 或任务名作为 agent_id：
\`\`\`bash
ofs init my-agent-id
ofs register my-agent-id claude localhost '["code","search","ssh"]'
\`\`\`

## 读写数据

\`\`\`bash
# 写入 (自动版本管理 + write-through TOS)
echo '{"name":"my-service","status":"healthy"}' | ofs write my-agent-id service my-svc
# 输出: wrote: service/my-svc (v1)

# 更新 (自动递增版本，保留变更历史)
echo '{"name":"my-service","status":"degraded"}' | ofs write my-agent-id service my-svc
# 输出: wrote: service/my-svc (v2)

# 读取
ofs read my-agent-id service my-svc

# 查看变更历史 (版本链 + 字段级 diff)
ofs history service my-svc

# 列出所有对象
ofs ls my-agent-id

# 删除
ofs rm my-agent-id service my-svc
\`\`\`

## 与其他 Agent 交互

\`\`\`bash
# 看看网络里谁有什么
ofs discover

# 建立共享链接
ofs link my-agent-id other-agent shares-context '{"permissions":"read"}'

# 从 TOS 拉其他 agent 的数据
ofs pull other-agent
ofs read other-agent service their-svc

# 把自己的数据推到 TOS
ofs push my-agent-id

# 双向同步
ofs sync my-agent-id
\`\`\`

## 事件流

所有操作自动记录事件（含 before/after 快照）：
\`\`\`bash
ofs events                    # 最近 20 条
ofs events my-agent-id        # 某 agent 的事件
ofs history <type> <id>       # 某对象的版本历史
\`\`\`

## 对象版本元数据

每个对象自动携带时间维度：
\`\`\`json
{
  "name": "my-service",
  "_version": 2,
  "_valid_from": "2026-03-13T10:00:00Z",
  "_created_at": "2026-03-01T00:00:00Z",
  "_updated_at": "2026-03-13T10:00:00Z",
  "_supersedes": "my-svc@v1"
}
\`\`\`

## 搜索协议 — 如何在 OFS 中查找信息

当被问到某个实体的信息时，**不要 grep 暴力搜索**。按以下顺序渐进式查找：

\`\`\`
Step 1: 精确读取
  ofs read <agent> <type> <id>
  → 拿到对象内容 + _refs 列表

Step 2: 沿 _refs 图遍历
  对象的 _refs 字段列出了所有关联实体，沿着它们读取即可展开上下文
  → 不需要 grep，_refs 就是索引

Step 3: 反向查找 (仅在 Step 2 不够时)
  ls ~/.ofs/agents/<agent>/objects/links/ | grep <keyword>
  → 查看 link 对象，找到"谁引用了我"

Step 4: 降级到暴力搜 (最后手段)
  ofs ls <agent> | grep <keyword>
  → 全量列表 + 关键词匹配
\`\`\`

### _refs 是什么

每个对象都可能有 `_refs` 字段，列出与它有关系的其他对象：
\`\`\`json
{
  "dc_id": "DC-EAST",
  "status": "active",
  "_refs": [
    "datacenter/DC-WEST",
    "infra-component/comp-rds",
    "sop/sop-failover-east",
    "alert-summary/alerts-2026-03"
  ]
}
\`\`\`

读一个对象就知道下一步该读什么。**Link 就是索引，图遍历替代暴力搜索。**

### 搜索示例

\`\`\`bash
# 被问 "DC-EAST 上跑了什么服务"
ofs read wiki-crawler datacenter DC-EAST
# → 看到 _refs 里有 infra-component/comp-rds, comp-redis, ...

# 沿 _refs 展开
ofs read wiki-crawler infra-component comp-rds
# → 看到这个组件的详情 + 它的 _refs 指向更多 SOP/runbook

# 不需要 grep 全库，2-3 步就拿到完整上下文
\`\`\`

## 设计原则

- **去中心化**: 没有中心 server，每个 agent 管自己的 `~/.ofs/agents/<id>/`
- **TOS as Shared Bus**: agent 间通过 TOS 对象存储交换上下文
- **Write-through**: `ofs write` 自动同步到 TOS
- **Append-Only Events**: 所有变更记录为不可变事件
- **Version Chain**: 每次写入自动递增版本号，`_supersedes` 指向上一版本
- **No Auto-Decay**: OFS 不自动删除过时对象，Agent 通过 `_updated_at` 自行判断新鲜度
```

---

## 种子知识 — 新 Agent 快速 Bootstrap

仓库自带种子知识文件（`examples/claude-code/seed-knowledge/`），新 agent 初始化后可以一键导入，立刻获得 OFS 的使用方法和最佳实践：

```bash
# 初始化后，导入种子知识
for f in examples/claude-code/seed-knowledge/*.json; do
  name=$(basename "$f" .json)
  cat "$f" | ofs write my-agent-id knowledge "$name"
done

# 验证
ofs ls my-agent-id
# knowledge/ofs-quickstart
# knowledge/ofs-conventions
# knowledge/ofs-usage-patterns

# 随时查阅
ofs read my-agent-id knowledge ofs-quickstart
ofs read my-agent-id knowledge ofs-conventions
ofs read my-agent-id knowledge ofs-usage-patterns
```

种子知识包含：
- **ofs-quickstart** — 安装步骤、项目结构、数据目录布局
- **ofs-conventions** — 设计原则、CLI 命令速查
- **ofs-usage-patterns** — 代码审查/调研/架构决策等场景的写入模板
- **ofs-search-protocol** — 搜索协议：如何用 _refs 图遍历替代暴力搜索

> 导入后这些就是你自己的 knowledge 对象，可以随时 `ofs write` 更新它们。

---

## 使用场景

### 1. 代码审查时记录发现

```bash
echo '{"file":"src/api.ts","issue":"SQL injection","severity":"high","fix":"use parameterized queries"}' \
  | ofs write claude-review finding review-001
```

### 2. 调研结果共享给其他 Agent

```bash
# 调研完成后写入
echo '{"topic":"auth flow","conclusion":"use OIDC device grant","references":["rfc8628"]}' \
  | ofs write claude-researcher research auth-flow-2026

# 其他 agent 可以 pull 这个结论
ofs pull claude-researcher
ofs read claude-researcher research auth-flow-2026
```

### 3. 读取巡检 Agent 的知识库

```bash
# 拉取 SRE 知识库 (SOP、预案、告警摘要)
ofs pull wiki-crawler
ofs ls wiki-crawler | head -20
ofs read wiki-crawler sop sop-cis-45400514
ofs read wiki-crawler alert-summary cis-alerts-2026-03
```

### 4. 跨项目上下文传递

```bash
# 项目 A 的 Claude Code 写入架构决策
echo '{"decision":"migrate to gRPC","reason":"reduce latency by 40%","date":"2026-03-15"}' \
  | ofs write project-a-claude architecture grpc-migration

# 项目 B 的 Claude Code 读取
ofs pull project-a-claude
ofs read project-a-claude architecture grpc-migration
```
