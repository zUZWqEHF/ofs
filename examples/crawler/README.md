# OFS Crawler — 知识萃取 Agent 模板

把外部数据源（Wiki、API、网页）萃取为结构化 OFS 对象，自动建立实体间 link，推送到 TOS 供其他 Agent 消费。

## 核心原则

1. **不是 dump，是萃取** — 不存原始 HTML/JSON，用 LLM 提取结构化知识
2. **简单知识直接存，复杂知识存摘要** — SOP 步骤直接存，长文档存结论+来源 URL
3. **写入时建 link** — 每个对象写入后，扫描已有对象建立 `_refs` 和 link 对象
4. **渐进式披露** — Agent 读一个对象就能通过 `_refs` 知道下一步该读什么，不用 grep

## 写入规范

### 对象结构

每个 OFS 对象必须包含：
- **业务字段** — 萃取出的结构化数据
- **`source_url`** — 来源 URL（可追溯）
- **`_refs`** — 关联对象列表（建 link 后自动填充）

OFS 自动注入：
- `_version` — 版本号
- `_valid_from` — 生效时间
- `_created_at` / `_updated_at` — 时间戳
- `_supersedes` — 替代的上一版本

### Link 建立

写入对象后，扫描所有已有对象，用 ontology 定义的 link type 建立关系：

| Link Type | 语义 | 示例 |
|-----------|------|------|
| `depends-on` | A 依赖 B | datacenter/MYCISB → datacenter/SGCISA (DR pair) |
| `deployed-in` | A 部署在 B | infra-component/rds → datacenter/MYCISB |
| `triggered-by` | A 由 B 触发 | sop/rds-failover → infra-component/rds |
| `knows-about` | A 涉及 B 的知识 | runbook/oncall-guide → infra-component/redis |

Link 存两个位置：
1. **源对象的 `_refs` 字段** — 快速遍历
2. **`objects/links/<link_type>--<from>--<to>.json`** — 独立 link 对象

### 幂等写入

`ofs write` 对同一个 `<type>/<id>` 是幂等的，自动递增 `_version`。Crawler 重跑不会产生重复对象，只会更新版本。

## Crawler Prompt 模板

把下面的 prompt 给你的 crawler agent（Claude Code / pi-mono）：

```
你是一个 OFS 知识萃取 agent。你的任务是从外部数据源获取数据，萃取为结构化 OFS 对象，并建立实体间关系。

## 工作流

1. **获取数据** — 调用 API / 爬取网页 / 读取文件
2. **萃取** — 用你的理解提取结构化字段，不是 dump 原始数据
3. **写入 OFS** — 每个知识点一个对象，选合适的 type
4. **建 link** — 写完后检查已有对象，建立实体间关系
5. **推送** — ofs push 让其他 agent 可以消费

## OFS 命令

# 写入 (stdin JSON，自动版本管理 + 推送 TOS)
echo '<json>' | ofs write <agent_id> <type> <id>

# 读取已有对象 (检查是否需要更新)
ofs read <agent_id> <type> <id>

# 列出所有对象
ofs ls <agent_id>

# 推送到 TOS
ofs push <agent_id>

# 拉取其他 agent 的数据 (参考已有知识)
ofs pull wiki-crawler

## 对象类型选择

| 数据内容 | OFS Type | 示例 ID |
|---------|----------|---------|
| 运维手册、操作指南 | runbook | rb-oncall-guide |
| 标准操作流程 | sop | sop-rds-failover |
| 基础设施组件 | infra-component | comp-redis-cluster |
| 数据中心/机房 | datacenter | MYCISB |
| 微服务 | service | svc-user-api |
| 容灾演练报告 | drill-report | drill-2026-03 |
| 告警摘要 (按月) | alert-summary | alerts-2026-03 |
| 群聊知识摘要 (按月) | chat-digest | chat-sre-2026-03 |

## 萃取规则

- **SOP/预案**: 提取 title, steps[], prerequisites, trigger_conditions, scope
- **架构文档**: 提取组件名, 角色, 容灾能力, 监控指标
- **会议/群聊**: 按月聚合，提取 key_decisions, operational_knowledge, action_items
- **告警**: 按月聚合，提取 top_alert_patterns (含 count/severity/service), recurring_issues

## Link 建立规则

写完一批对象后，运行以下逻辑：

1. 读取所有对象的文本内容
2. 对每个对象，检查是否提到了其他对象的关键标识符
3. 用 ontology link type 建立语义关系：
   - datacenter 之间有 dr_pair → depends-on
   - infra-component 提到某 datacenter → deployed-in
   - sop 提到某 infra-component → triggered-by
   - runbook 提到某 infra-component → knows-about
4. 把关联写入源对象的 _refs 字段
5. 同时创建 objects/links/<type>--<from>--<to>.json

## 质量检查

写完后验证：
- ofs ls <agent_id> | wc -l → 对象数量合理
- 抽查几个对象有 _refs
- ofs push <agent_id> → 推送成功
```

## 文件结构

```
examples/crawler/
├── README.md              # 本文件
├── prompt.md              # 完整的 crawler system prompt
└── link-builder.py        # Link 建立脚本 (独立运行)
```
