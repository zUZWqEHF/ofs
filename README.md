<p align="center">
  <h1 align="center">OFS — Ontology File System</h1>
  <p align="center">
    <strong>Decentralized context layer for multi-agent collaboration.</strong>
    <br/>
    Git-like versioned knowledge graph. No central server. S3 as shared bus.
  </p>
</p>

---

## What is OFS?

OFS is a **file-based context system** for AI agents that need to share knowledge.

Each agent owns its data. Agents exchange context through S3. A shared ontology keeps everyone speaking the same language.

```
Agent A writes a diagnosis    →  auto-pushed to S3
Agent B pulls the diagnosis   →  uses it for planning
Agent C reads the plan        →  executes remediation
Every step is versioned, traceable, and reversible.
```

## Why not a database?

| Approach | Problem |
|----------|---------|
| Shared DB | Single point of failure. Schema coupling. Agents can't work offline. |
| Message queue | Fire-and-forget. No persistent context. No versioning. |
| Vector DB / RAG | Temporal stagnation. Destructive updates. No decision traces. |
| **OFS** | Each agent owns its files. S3 syncs. Ontology aligns. Events trace everything. |

---

## Design: Two Rounds of Thinking

### Round 1 — Three Fundamental Problems of Decentralized Agents

#### 1. Concept Drift Has No Natural Convergence

Agent A says "SLA met." Agent B says "SLA breached." They define SLA differently. As agents evolve independently, **semantic drift is inevitable**.

**OFS solution: Shared Ontology** — 20 object types and 7 link types serve as semantic anchors. Agents propose new terms through a review process. `resolve(term)` normalizes aliases to canonical forms.

#### 2. Context Value Is Relative, Not Absolute

Agent A wrote "datacenter traffic: 20%" last week. Agent B reads it today — is it still valid? **No global expiration policy can answer this** because freshness depends on the consumer's intent.

**OFS solution: Temporal metadata + agent autonomy** — Every object carries `_version`, `_valid_from`, `_updated_at`. Agents decide freshness for themselves. OFS does **not** auto-expire data — team knowledge (SOPs, runbooks, architecture docs) should persist.

#### 3. No Global Credit Attribution

Alert fired by Service A → diagnosed by Agent B → fixed by Agent C → postmortem by Agent D. **Who did what? What caused what?** Without a causal graph, these questions are unanswerable.

**OFS solution: CausalLog** — Every action emits a `CausalEvent` with `caused_by[]`, `evidence[]`, `decision_rationale`, and `confidence`. Queries: `traceBack(eventId)` for root cause, `traceForward(eventId)` for blast radius.

---

### Round 2 — Five Criticisms of Traditional RAG (via HydraDB)

Inspired by [HydraDB](https://arxiv.org/abs/2501.16150) — *"Beyond Context Windows"*:

| # | Criticism | RAG symptom | OFS solution |
|---|-----------|-------------|--------------|
| 1 | **Temporal stagnation** | Vector DB treats memory as a timeless plane | `_version` + `_supersedes` version chain |
| 2 | **Destructive updates** | Overwrites erase decision history | Before/after snapshots in every event |
| 3 | **Lost decision traces** | No record of "why did we choose this?" | `event.reason` field + causal DAG |
| 4 | **Semantic fragmentation** | Chunking breaks temporal/relational links | `_supersedes` chains + `source_url` provenance |
| 5 | **No memory decay** | Stale memories pollute retrieval | **Intentionally rejected** — team knowledge is not chat memory |

---

## Architecture

```
               ┌─────────────────────────────────────────────┐
               │           Shared Ontology (Schema)          │
               │  types/*.yaml  links/*.yaml  actions/*.sh   │
               └────────────────────┬────────────────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
   ┌──────┴──────┐          ┌──────┴──────┐           ┌──────┴──────┐
   │  Agent A    │          │  Agent B    │           │  Agent C    │
   │  ~/.ofs/    │          │  ~/.ofs/    │           │  ~/.ofs/    │
   │  agents/A/  │          │  agents/B/  │           │  agents/C/  │
   └──────┬──────┘          └──────┬──────┘           └──────┬──────┘
          │   write-through        │                         │
          └────────────┬───────────┘─────────────────────────┘
                       │
                ┌──────┴──────┐
                │     S3      │  Any S3-compatible store
                │  Shared Bus │  (AWS, MinIO, LocalStack)
                └─────────────┘
```

**Data flow:** Agent writes local → auto-push S3 → other agents pull from S3 → local read

---

## Quick Start

### Install

```bash
# Put the CLI on your PATH
cp cli/ofs /usr/local/bin/ofs && chmod +x /usr/local/bin/ofs

# Initialize an agent
ofs init my-agent
ofs register my-agent inspector localhost '["inspect","report"]'
```

### Configure S3 (optional — enables multi-agent sharing)

```bash
# AWS
aws configure

# Or MinIO / LocalStack
cat > ~/.ofs/s3.env << EOF
S3_BUCKET=my-ofs-bucket
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
EOF
```

### Read & Write

```bash
# Write (auto-versions + auto-pushes to S3)
echo '{"name":"user-service","region":"us-east-1"}' | ofs write my-agent service user-svc
# Output: wrote: service/user-svc (v1)

# Update (version auto-increments, before/after snapshot saved)
echo '{"name":"user-service","region":"eu-west-1"}' | ofs write my-agent service user-svc
# Output: wrote: service/user-svc (v2)

# Read
ofs read my-agent service user-svc

# Version history with field-level diffs
ofs history service user-svc
```

### Share Between Agents

```bash
# Agent B: link to Agent A and pull its context
ofs link agent-b agent-a shares-context '{"permissions":"read"}'
ofs pull agent-a
ofs read agent-a service user-svc   # read shared data

# Discover all agents on the network
ofs discover
```

---

## Ontology: Four Primitives + Event

Based on [Palantir's Ontology](https://www.palantir.com/platforms/ontology/):

| Primitive | Mapping | Examples |
|-----------|---------|---------|
| **Object Type** | `ontology/types/<name>.yaml` | service, alert, runbook, datacenter |
| **Property** | `properties:` in type YAML | name, region, severity, status |
| **Link** | `ontology/links/<name>.yaml` | depends-on, shares-context, delegates-to |
| **Action** | `ontology/actions/<name>.sh` | diagnose, query-metrics |
| **Event** | `~/.ofs/events/events.jsonl` | Append-only mutation log |

### Included Types (20)

`agent` `alert` `service` `host` `datacenter` `instance` `infra-component` `inspection-report` `diagnosis-report` `drill-report` `runbook` `sop` `metrics-query` `graph-query` `container-query` `tool-execution-record` `person-profile` `workspace-file` `vdc` `event`

### Included Links (7)

`depends-on` `deployed-in` `triggered-by` `shares-context` `delegates-to` `knows-about` `reviews`

---

## v3 Temporal Versioning

Every `ofs write` automatically injects version metadata:

```json
{
  "name": "user-service",
  "_version": 3,
  "_valid_from": "2025-03-13T10:00:00Z",
  "_created_at": "2025-01-01T00:00:00Z",
  "_updated_at": "2025-03-13T10:00:00Z",
  "_supersedes": "user-svc@v2"
}
```

Every mutation emits an immutable event with full before/after:

```json
{
  "event_type": "update",
  "object_type": "service",
  "object_id": "user-svc",
  "before": {"name":"user-service","region":"us-east-1","_version":2},
  "after":  {"name":"user-service","region":"eu-west-1","_version":3},
  "reason": "migrate to EU for GDPR compliance"
}
```

Time-travel query (TypeScript engine):

```typescript
const snapshot = await engine.getObjectAtTime("service", "user-svc", "2025-02-01");
// Returns the object as it existed on Feb 1st
```

---

## Context Manager: Three Layers

The TypeScript engine provides structured context management:

| Layer | Purpose | Implementation |
|-------|---------|---------------|
| **L1 Intent** | Current goal, constraints, focus types | `engine.setIntent(goal, constraints, focusTypes)` |
| **L2 Working Memory** | Active objects (recently accessed) | Auto-tracked, compacted by staleness |
| **L3 Episodic Store** | Full event history (append-only) | `engine.getObjectHistory()`, `getObjectAtTime()` |

---

## pi-mono Agent Example

`examples/pi-mono/` contains a minimal agent (~60 lines) demonstrating OFS integration:

```bash
cd examples/pi-mono && npm install
ofs init my-agent
AGENT_ID=my-agent OPENAI_API_KEY=sk-xxx npx tsx runner.ts "Write a test object to OFS"
```

The agent has three tools: `hello` (test), `ofs_read`, `ofs_write`. See `examples/pi-mono/runner.ts`.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `ofs init <agent>` | Initialize agent context |
| `ofs write <agent> <type> <id>` | Write object (stdin, auto-versions, auto-pushes S3) |
| `ofs read <agent> <type> <id>` | Read object |
| `ofs rm <agent> <type> <id>` | Delete object |
| `ofs ls <agent>` | List all objects |
| `ofs history <type> <id>` | Version history with diffs |
| `ofs link <from> <to> <type>` | Create relationship |
| `ofs links <agent>` | List relationships |
| `ofs push <agent>` | Push all objects to S3 |
| `ofs pull <agent>` | Pull all objects from S3 |
| `ofs s3-ls [agent]` | List objects in S3 |
| `ofs sync <agent>` | Bidirectional sync |
| `ofs discover` | Find all agents on the network |
| `ofs schema types` | List ontology object types |
| `ofs schema links` | List ontology link types |
| `ofs events [agent]` | View event log |

---

## Project Structure

```
ofs/
├── cli/ofs                      # Bash CLI (zero dependencies beyond aws-cli)
├── ontology/
│   ├── types/                   # 20 object type schemas (YAML)
│   ├── links/                   # 7 link type schemas (YAML)
│   └── actions/                 # Executable action scripts
├── src/ofs/                     # TypeScript engine
│   ├── engine.ts                # Core CRUD + v3 temporal
│   ├── event-log.ts             # Append-only event sourcing
│   ├── causal-log.ts            # Causal DAG (traceBack/traceForward)
│   ├── context-manager.ts       # L1 Intent / L2 Working Memory / L3 Episodic
│   ├── shared-ontology.ts       # Term registry + proposal workflow
│   ├── graph.ts                 # BFS/DFS traversal
│   └── storage/                 # S3, local, hybrid backends
├── examples/pi-mono/            # Minimal agent example
└── docs/
```

---

## Design Principles

1. **Context as Files** — JSON files, no databases
2. **Bash Bootstrap** — CLI is pure bash; actions are shell scripts
3. **Write-Through** — `ofs write` pushes to S3 automatically
4. **Append-Only Events** — Mutation log is immutable; objects are mutable snapshots
5. **Version Chain** — `_version` + `_supersedes` form a linked list of history
6. **Decision Traces** — Every change records *why*, not just *what*
7. **Time-Travel via Events** — Reconstruct any historical state from the event log
8. **No Auto-Decay** — Team knowledge persists; agents judge freshness themselves
9. **Single Select, No Merge** — Task delegation picks one result, no complex merging
10. **Manifest Discovery** — Each agent publishes a manifest; `ofs discover` shows the network

---

## Inspired By

- [Palantir Ontology](https://www.palantir.com/platforms/ontology/) — Four-primitive data model
- [HydraDB](https://arxiv.org/abs/2501.16150) — Temporal knowledge graph critique of RAG
- [Git](https://git-scm.com/) — Append-only history, version chains, distributed architecture
- [Event Sourcing](https://martinfowler.com/eaaDev/EventSourcing.html) — Immutable event log as source of truth

## License

MIT
