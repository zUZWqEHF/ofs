#!/usr/bin/env python3
"""
OFS Link Builder — 自动扫描对象间引用，建立 link 对象 + _refs

Usage:
  python3 link-builder.py <agent_id>
  python3 link-builder.py wiki-crawler
"""

import json, os, sys, glob
from collections import defaultdict

def main():
    agent_id = sys.argv[1] if len(sys.argv) > 1 else "wiki-crawler"
    ofs_root = os.environ.get("OFS_ROOT", os.path.expanduser("~/.ofs"))
    base = os.path.join(ofs_root, "agents", agent_id, "objects")

    if not os.path.isdir(base):
        print(f"error: {base} not found. Run: ofs init {agent_id}")
        sys.exit(1)

    # Load all objects
    objects = {}
    for type_dir in glob.glob(f"{base}/*/"):
        obj_type = os.path.basename(type_dir.rstrip("/"))
        if obj_type in ("links", "manifest.json"):
            continue
        for f in glob.glob(f"{type_dir}/*.json"):
            obj_id = os.path.basename(f).replace(".json", "")
            try:
                objects[f"{obj_type}/{obj_id}"] = json.load(open(f))
            except:
                pass

    print(f"Loaded {len(objects)} objects for {agent_id}")

    # Build indexes by type
    by_type = defaultdict(dict)
    for key, obj in objects.items():
        t = key.split("/")[0]
        by_type[t][key] = obj

    # Name → key indexes for matching
    dc_index = {}
    for key, obj in by_type.get("datacenter", {}).items():
        for field in ["dc_id", "name", "vregion"]:
            val = obj.get(field, "")
            if val and len(val) > 1:
                dc_index[val.lower()] = key

    infra_index = {}
    for key, obj in by_type.get("infra-component", {}).items():
        for field in ["name", "type", "component_id"]:
            val = obj.get(field, "")
            if val and len(val) > 2:
                infra_index[val.lower()] = key

    svc_index = {}
    for key, obj in by_type.get("service", {}).items():
        for field in ["name", "service_name", "psm"]:
            val = obj.get(field, "")
            if val and len(val) > 2:
                svc_index[val.lower()] = key

    # Build links
    links = []

    # datacenter --depends-on--> datacenter (DR pair)
    for key, obj in by_type.get("datacenter", {}).items():
        dr = obj.get("dr_pair", "")
        if dr:
            target = dc_index.get(dr.lower())
            if target and target != key:
                links.append((key, target, "depends-on", {"relation": "dr-pair"}))

    # infra-component --deployed-in--> datacenter
    for key, obj in by_type.get("infra-component", {}).items():
        text = json.dumps(obj, ensure_ascii=False).lower()
        for dc_name, dc_key in dc_index.items():
            if len(dc_name) > 2 and dc_name in text and dc_key != key:
                links.append((key, dc_key, "deployed-in", {"inferred": True}))

    # sop --triggered-by--> infra-component
    for key, obj in by_type.get("sop", {}).items():
        text = json.dumps(obj, ensure_ascii=False).lower()
        for inf_name, inf_key in infra_index.items():
            if len(inf_name) > 3 and inf_name in text:
                links.append((key, inf_key, "triggered-by", {"relation": "mitigation-for"}))

    # runbook --knows-about--> infra-component
    for key, obj in by_type.get("runbook", {}).items():
        text = json.dumps(obj, ensure_ascii=False).lower()
        for inf_name, inf_key in infra_index.items():
            if len(inf_name) > 3 and inf_name in text:
                links.append((key, inf_key, "knows-about", {"relation": "documents"}))

    # drill-report --deployed-in--> datacenter
    for key, obj in by_type.get("drill-report", {}).items():
        text = json.dumps(obj, ensure_ascii=False).lower()
        for dc_name, dc_key in dc_index.items():
            if len(dc_name) > 2 and dc_name in text:
                links.append((key, dc_key, "deployed-in", {"relation": "drill-target"}))

    # alert-summary --triggered-by--> infra-component
    for key, obj in by_type.get("alert-summary", {}).items():
        for p in obj.get("top_alert_patterns", []):
            if not isinstance(p, dict):
                continue
            svc = p.get("service", "").lower()
            for inf_name, inf_key in infra_index.items():
                if len(inf_name) > 3 and inf_name in svc:
                    links.append((key, inf_key, "triggered-by", {"alert_count": p.get("count", 0)}))
                    break

    # Deduplicate
    seen = set()
    unique = []
    for src, tgt, ltype, props in links:
        k = f"{src}|{tgt}|{ltype}"
        if k not in seen:
            seen.add(k)
            unique.append((src, tgt, ltype, props))

    print(f"Built {len(unique)} links")

    # Write link objects
    link_dir = os.path.join(base, "links")
    os.makedirs(link_dir, exist_ok=True)

    for src, tgt, ltype, props in unique:
        src_type, src_id = src.split("/", 1)
        tgt_type, tgt_id = tgt.split("/", 1)
        link_id = f"{ltype}--{src_id[:20]}--{tgt_id[:20]}"
        link_obj = {
            "from_type": src_type,
            "from_id": src_id,
            "to_type": tgt_type,
            "to_id": tgt_id,
            "link_type": ltype,
            "properties": props,
        }
        with open(os.path.join(link_dir, f"{link_id}.json"), "w") as f:
            json.dump(link_obj, f, ensure_ascii=False, indent=2)

    # Add _refs to source objects
    refs_by_source = defaultdict(list)
    for src, tgt, ltype, props in unique:
        refs_by_source[src].append(tgt)

    updated = 0
    for src, refs in refs_by_source.items():
        src_type, src_id = src.split("/", 1)
        fpath = os.path.join(base, src_type, f"{src_id}.json")
        if os.path.exists(fpath):
            obj = json.load(open(fpath))
            obj["_refs"] = sorted(set(refs))
            with open(fpath, "w") as f:
                json.dump(obj, f, ensure_ascii=False, indent=2)
            updated += 1

    print(f"Updated {updated} objects with _refs")
    print(f"Created {len(unique)} link objects in {link_dir}")
    print(f"\nDone. Run: ofs push {agent_id}")


if __name__ == "__main__":
    main()
