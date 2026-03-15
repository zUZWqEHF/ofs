#!/usr/bin/env python3
"""
OFS Link Builder — scan objects, infer relationships, build bidirectional _refs + link objects

Usage:
  python3 link-builder.py <agent_id>
  python3 link-builder.py wiki-crawler
  python3 link-builder.py wiki-crawler --dry-run   # preview only, no writes
"""

import json, os, sys, glob, re
from collections import defaultdict


def load_objects(base):
    """Load all OFS objects, skip links and manifest."""
    objects = {}
    for type_dir in glob.glob(f"{base}/*/"):
        obj_type = os.path.basename(type_dir.rstrip("/"))
        if obj_type in ("links", "manifest.json"):
            continue
        for f in glob.glob(f"{type_dir}/*.json"):
            obj_id = os.path.basename(f).replace(".json", "")
            try:
                objects[f"{obj_type}/{obj_id}"] = json.load(open(f))
            except Exception:
                pass
    return objects


def build_index(objects, obj_type, fields):
    """Build name→key index for a given type. Lowercased, min 2 chars."""
    index = {}
    for key, obj in objects.items():
        if not key.startswith(f"{obj_type}/"):
            continue
        # Always index the object ID itself
        obj_id = key.split("/", 1)[1]
        if len(obj_id) > 1:
            index[obj_id.lower()] = key
        for field in fields:
            val = obj.get(field, "")
            if isinstance(val, str) and len(val) > 1:
                index[val.lower()] = key
    return index


def text_of(obj):
    """Flatten an object to searchable text, excluding _ meta fields."""
    parts = []
    for k, v in obj.items():
        if k.startswith("_"):
            continue
        if isinstance(v, str):
            parts.append(v)
        elif isinstance(v, list):
            for item in v:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict):
                    parts.append(json.dumps(item, ensure_ascii=False))
        elif isinstance(v, dict):
            parts.append(json.dumps(v, ensure_ascii=False))
    return " ".join(parts).lower()


def find_mentions(text, index, self_key, min_len=3):
    """Find which index entries are mentioned in text. Returns matched keys."""
    matches = set()
    for name, target_key in index.items():
        if target_key == self_key:
            continue
        if len(name) < min_len:
            continue
        # Word boundary match to reduce false positives
        if re.search(r'(?<![a-zA-Z0-9_-])' + re.escape(name) + r'(?![a-zA-Z0-9_-])', text):
            matches.add(target_key)
    return matches


def main():
    agent_id = sys.argv[1] if len(sys.argv) > 1 else "wiki-crawler"
    dry_run = "--dry-run" in sys.argv

    ofs_root = os.environ.get("OFS_ROOT", os.path.expanduser("~/.ofs"))
    base = os.path.join(ofs_root, "agents", agent_id, "objects")

    if not os.path.isdir(base):
        print(f"error: {base} not found. Run: ofs init {agent_id}")
        sys.exit(1)

    objects = load_objects(base)
    print(f"Loaded {len(objects)} objects for {agent_id}")

    # Build type-specific indexes
    dc_index = build_index(objects, "datacenter", ["dc_id", "name", "vregion"])
    infra_index = build_index(objects, "infra-component", ["name", "type", "component_id"])
    svc_index = build_index(objects, "service", ["name", "service_name", "service_name"])

    # All entity indexes merged (for broad matching)
    all_index = {}
    all_index.update(dc_index)
    all_index.update(infra_index)
    all_index.update(svc_index)

    links = []  # (src, tgt, link_type, properties)

    # --- Rule 1: datacenter --depends-on--> datacenter (DR pair) ---
    for key, obj in objects.items():
        if not key.startswith("datacenter/"):
            continue
        dr = obj.get("dr_pair", "")
        if dr:
            target = dc_index.get(dr.lower())
            if target and target != key:
                links.append((key, target, "depends-on", {"relation": "dr-pair"}))

    # --- Rule 2: any type mentioning a datacenter --deployed-in / knows-about--> datacenter ---
    type_to_dc_link = {
        "infra-component": "deployed-in",
        "service":         "deployed-in",
        "sop":             "knows-about",
        "runbook":         "knows-about",
        "drill-report":    "deployed-in",
        "alert-summary":   "knows-about",
        "chat-digest":     "knows-about",
    }
    for key, obj in objects.items():
        obj_type = key.split("/")[0]
        link_type = type_to_dc_link.get(obj_type)
        if not link_type:
            continue
        text = text_of(obj)
        for dc_key in find_mentions(text, dc_index, key, min_len=2):
            links.append((key, dc_key, link_type, {"inferred": True}))

    # --- Rule 3: sop/runbook mentioning infra-component ---
    for key, obj in objects.items():
        obj_type = key.split("/")[0]
        if obj_type == "sop":
            ltype = "triggered-by"
            props = {"relation": "mitigation-for"}
        elif obj_type == "runbook":
            ltype = "knows-about"
            props = {"relation": "documents"}
        else:
            continue
        text = text_of(obj)
        for inf_key in find_mentions(text, infra_index, key):
            links.append((key, inf_key, ltype, props))

    # --- Rule 4: sop/runbook mentioning services ---
    for key, obj in objects.items():
        obj_type = key.split("/")[0]
        if obj_type not in ("sop", "runbook", "drill-report"):
            continue
        text = text_of(obj)
        for svc_key in find_mentions(text, svc_index, key):
            links.append((key, svc_key, "knows-about", {"relation": "references"}))

    # --- Rule 5: alert-summary --triggered-by--> infra/service ---
    for key, obj in objects.items():
        if not key.startswith("alert-summary/"):
            continue
        for p in obj.get("top_alert_patterns", []):
            if not isinstance(p, dict):
                continue
            svc = p.get("service", "").lower()
            if not svc:
                continue
            for name, target in {**infra_index, **svc_index}.items():
                if len(name) > 3 and name in svc:
                    links.append((key, target, "triggered-by",
                                  {"alert_count": p.get("count", 0)}))
                    break

    # --- Rule 6: datacenter mentioning lists of services/components ---
    for key, obj in objects.items():
        if not key.startswith("datacenter/"):
            continue
        # Check vdc_list, affected_services, etc.
        for field in ("vdc_list", "affected_services", "components"):
            items = obj.get(field, [])
            if not isinstance(items, list):
                continue
            for item in items:
                if not isinstance(item, str):
                    continue
                item_l = item.lower()
                for name, target in {**infra_index, **svc_index}.items():
                    if len(name) > 3 and name in item_l:
                        links.append((target, key, "deployed-in",
                                      {"source_field": field}))

    # --- Deduplicate ---
    seen = set()
    unique = []
    for src, tgt, ltype, props in links:
        k = f"{src}|{tgt}|{ltype}"
        if k not in seen:
            seen.add(k)
            unique.append((src, tgt, ltype, props))

    print(f"Built {len(unique)} links (from {len(links)} raw)")

    if dry_run:
        for src, tgt, ltype, _ in unique:
            print(f"  {src} --[{ltype}]--> {tgt}")
        print(f"\n(dry run — no files written)")
        return

    # --- Write link objects ---
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

    # --- Bidirectional _refs: both source and target get references ---
    refs_map = defaultdict(set)
    for src, tgt, ltype, props in unique:
        refs_map[src].add(tgt)
        refs_map[tgt].add(src)

    updated = 0
    for obj_key, refs in refs_map.items():
        obj_type, obj_id = obj_key.split("/", 1)
        fpath = os.path.join(base, obj_type, f"{obj_id}.json")
        if not os.path.exists(fpath):
            continue
        obj = json.load(open(fpath))
        existing = set(obj.get("_refs", []))
        merged = sorted(existing | refs)
        if merged != obj.get("_refs"):
            obj["_refs"] = merged
            with open(fpath, "w") as f:
                json.dump(obj, f, ensure_ascii=False, indent=2)
            updated += 1

    # --- Stats ---
    link_types = defaultdict(int)
    for _, _, ltype, _ in unique:
        link_types[ltype] += 1

    print(f"\nUpdated {updated} objects with bidirectional _refs")
    print(f"Created {len(unique)} link objects in {link_dir}")
    print(f"\nLink type breakdown:")
    for lt, count in sorted(link_types.items(), key=lambda x: -x[1]):
        print(f"  {lt:20s} {count}")
    print(f"\nDone. Run: ofs push {agent_id}")


if __name__ == "__main__":
    main()
