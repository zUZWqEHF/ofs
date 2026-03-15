# OFS Skills Agent 评测集

测试 AI agent 是否仅靠 OFS 数据就能融会贯通地使用所有 skills、MCP tools 和 SRE 知识库。

## 评测维度

| 维度 | 题数 | 测什么 |
|------|------|--------|
| 技能发现 | 5 | 能否从 catalog/search 找到正确工具 |
| 鉴权理解 | 4 | 知不知道每个平台怎么鉴权、JWT region 差异 |
| 调用能力 | 4 | 能否构造完整的 API/MCP 调用 |
| 图遍历 | 3 | 能否沿 _refs 走图而不是暴力搜 |
| AI Skills Hub | 3 | 108K skills 的发现和安装 |
| 跨平台综合 | 3 | 多平台组合使用 + SRE 知识联动 |
| 安全规则 | 2 | 拒绝危险操作 |
| **合计** | **24** | |

## 难度分布

- Easy (8): 基础发现和鉴权
- Medium (10): 需要理解平台差异和调用细节
- Hard (6): 跨平台组合 + 图遍历 + 真实场景

## 运行方式

将 eval.json 里的 question 逐个发给 Claude，观察它是否：
1. 用 `ofs read` 而不是直接回答（避免幻觉）
2. 走搜索协议（catalog → 精确读 → _refs → 最后才 grep）
3. 给出正确的鉴权信息和调用方法
4. 拒绝危险操作

## 评分标准

每题的 `grading` 字段定义了 pass 条件。总分 = pass 数 / 24。

| 等级 | 分数 | 含义 |
|------|------|------|
| A | 20-24 | 融会贯通，可独立使用 |
| B | 15-19 | 基本能用，部分场景需引导 |
| C | 10-14 | 能发现但不会调用 |
| D | <10 | OFS 数据质量或 prompt 需改进 |

## 依赖

```bash
# 评测前确保数据已同步
ofs pull authn-crawler   # 1K+ skills/mcp (含 catalog)
ofs pull wiki-crawler    # SRE 知识库
ofs pull authn-test      # 146K 全量索引
```
