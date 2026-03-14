#!/usr/bin/env bash
# Action: diagnose
# 对一组告警执行规则引擎诊断
# 输入: 告警 JSON 文件路径 ($1)
# 输出: 诊断报告到 stdout，同时写入 instances/reports/
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ONTOLOGY_DIR="$(dirname "$SCRIPT_DIR")"
ALERTS_FILE="${1:?Usage: diagnose.sh <alerts.json>}"
TS=$(date '+%Y%m%d-%H%M%S')
REPORT_DIR="$ONTOLOGY_DIR/instances/reports"
mkdir -p "$REPORT_DIR"

python3 - "$ALERTS_FILE" "$REPORT_DIR/diagnosis-${TS}.yaml" << 'PYEOF'
import json, sys, yaml
from datetime import datetime

alerts_file = sys.argv[1]
output_file = sys.argv[2]

with open(alerts_file) as f:
    alerts = json.load(f)

def classify(alert):
    t = (alert.get("title","") + " " + alert.get("content","")).lower()
    if "panic" in t or "oom" in t: return "自身代码"
    if "mesh" in t: return "自身Mesh"
    if "cpu" in t or "内存" in t: return "资源瓶颈"
    if "sla" in t or "成功率" in t: return "SLA下降"
    if "redis" in t or "mysql" in t or "kafka" in t: return "下游依赖"
    if "tlb" in t or "http5xx" in t: return "基建-TLB"
    if "网络" in t or "丢包" in t: return "基建-网络"
    if "agw" in t: return "基建-AGW"
    if "dflow" in t: return "DFlow同步"
    return "其他"

categories = {}
psms = set()
for a in alerts:
    cat = classify(a)
    categories[cat] = categories.get(cat, 0) + 1
    for p in a.get("psm", []):
        psms.add(p)

top = max(categories.items(), key=lambda x: x[1])[0] if categories else "无"

report = {
    "type": "diagnosis-report",
    "report_id": f"diag-{datetime.now().strftime('%Y%m%d-%H%M%S')}",
    "timestamp": datetime.now().isoformat(),
    "source": "self-drive",
    "alert_count": len(alerts),
    "psm_count": len(psms),
    "top_category": top,
    "categories": categories,
    "conclusion": f"共 {len(alerts)} 条告警, {len(psms)} 个 PSM, 主要归因: {top}",
    "sent_to_group": False,
}

with open(output_file, "w") as f:
    # Write as YAML-like format
    for k, v in report.items():
        f.write(f"{k}: {json.dumps(v, ensure_ascii=False)}\n")

print(report["conclusion"])
PYEOF
