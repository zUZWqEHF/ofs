#!/bin/bash
# OFS remote sync via Dashboard API (for external networks)
DASHBOARD_URL="${OFS_DASHBOARD_URL:-https://harness-admin-dashboard.byteintl.net}"
TOKEN="${OFS_SYNC_TOKEN:-harness-dev-2026-cis-sre}"
OFS_ROOT="${OFS_ROOT:-$HOME/.ofs}"

for agent in wiki-crawler authn-crawler authn-test; do
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
