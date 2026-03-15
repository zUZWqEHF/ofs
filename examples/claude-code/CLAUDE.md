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

# 3. (可选) 配置 TOS 实现 Agent 间共享
cat > ~/.ofs/tos.env << EOF
TOS_ACCESS_KEY=your_key
TOS_SECRET_KEY=your_secret
TOS_BUCKET=your_bucket
EOF
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
