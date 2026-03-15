import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import type { OfsStorage } from "./types.js";
import { CausalLog } from "./causal-log.js";

// In-memory storage for testing
function createMemStorage(): OfsStorage {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(prefix: string) {
      return [...store.keys()].filter((k) => k.startsWith(prefix));
    },
    async exists(key: string) {
      return store.has(key);
    },
  };
}

describe("CausalLog", () => {
  let log: CausalLog;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ofs-causal-test-"));
    log = new CausalLog(createMemStorage(), tmpDir);
  });

  it("appends and indexes causal events", async () => {
    const e1 = await log.append({
      _type: "create",
      _object_type: "service",
      _object_id: "svc-1",
      _agent_id: "agent-1",
      _data: { name: "nginx" },
      caused_by: [],
      intent_ref: "deploy services",
      evidence: [],
      decision_rationale: "user requested",
      confidence: 0.9,
    });

    expect(e1._event_id).toBeDefined();
    expect(e1._timestamp).toBeDefined();
    expect(e1.confidence).toBe(0.9);
  });

  it("traces back through causal chain", async () => {
    const root = await log.append({
      _type: "create",
      _object_type: "service",
      _object_id: "svc-1",
      _agent_id: "agent-1",
      _data: {},
      caused_by: [],
      intent_ref: "deploy",
      evidence: [],
      decision_rationale: "initial",
      confidence: 1.0,
    });

    const child = await log.append({
      _type: "update",
      _object_type: "service",
      _object_id: "svc-1",
      _agent_id: "agent-1",
      _data: { status: "running" },
      caused_by: [root._event_id],
      intent_ref: "deploy",
      evidence: ["svc-1"],
      decision_rationale: "service started",
      confidence: 0.95,
    });

    const grandchild = await log.append({
      _type: "create",
      _object_type: "log",
      _object_id: "log-1",
      _agent_id: "agent-1",
      _data: { message: "healthy" },
      caused_by: [child._event_id],
      intent_ref: "monitor",
      evidence: ["svc-1"],
      decision_rationale: "health check passed",
      confidence: 0.8,
    });

    const chain = log.traceBack(grandchild._event_id);
    expect(chain.events).toHaveLength(3);
    expect(chain.depth).toBe(2);
    expect(chain.events.map((e) => e._event_id)).toContain(root._event_id);
  });

  it("traces forward from root event", async () => {
    const root = await log.append({
      _type: "create",
      _object_type: "service",
      _object_id: "svc-1",
      _agent_id: "agent-1",
      _data: {},
      caused_by: [],
      intent_ref: "deploy",
      evidence: [],
      decision_rationale: "initial",
      confidence: 1.0,
    });

    await log.append({
      _type: "update",
      _object_type: "service",
      _object_id: "svc-1",
      _agent_id: "agent-1",
      _data: {},
      caused_by: [root._event_id],
      intent_ref: "deploy",
      evidence: [],
      decision_rationale: "follow-up",
      confidence: 0.9,
    });

    const chain = log.traceForward(root._event_id);
    expect(chain.events).toHaveLength(2);
  });

  it("attributes object to causal chain", async () => {
    const e1 = await log.append({
      _type: "create",
      _object_type: "service",
      _object_id: "svc-1",
      _agent_id: "agent-1",
      _data: {},
      caused_by: [],
      intent_ref: "deploy",
      evidence: [],
      decision_rationale: "user request",
      confidence: 0.9,
    });

    await log.append({
      _type: "update",
      _object_type: "service",
      _object_id: "svc-1",
      _agent_id: "agent-1",
      _data: { status: "active" },
      caused_by: [e1._event_id],
      intent_ref: "deploy",
      evidence: [],
      decision_rationale: "activated",
      confidence: 0.85,
    });

    const attr = log.attribute("svc-1", "service");
    expect(attr.object_id).toBe("svc-1");
    expect(attr.causal_chain.events.length).toBeGreaterThan(0);
    expect(attr.confidence).toBeGreaterThan(0);
  });

  it("returns empty attribution for unknown object", () => {
    const attr = log.attribute("unknown", "service");
    expect(attr.confidence).toBe(0);
    expect(attr.causal_chain.events).toHaveLength(0);
  });

  it("queries events with filters", async () => {
    await log.append({
      _type: "create",
      _object_type: "service",
      _object_id: "svc-1",
      _agent_id: "agent-1",
      _data: {},
      caused_by: [],
      intent_ref: "deploy",
      evidence: [],
      decision_rationale: "test",
      confidence: 0.9,
    });

    await log.append({
      _type: "create",
      _object_type: "host",
      _object_id: "h-1",
      _agent_id: "agent-1",
      _data: {},
      caused_by: [],
      intent_ref: "provision",
      evidence: [],
      decision_rationale: "test",
      confidence: 0.5,
    });

    const services = await log.query({ objectType: "service" });
    expect(services).toHaveLength(1);

    const highConf = await log.query({ minConfidence: 0.8 });
    expect(highConf).toHaveLength(1);
  });

  it("persists and reloads index", async () => {
    const storage = createMemStorage();
    const log1 = new CausalLog(storage, tmpDir);

    await log1.append({
      _type: "create",
      _object_type: "service",
      _object_id: "svc-1",
      _agent_id: "agent-1",
      _data: {},
      caused_by: [],
      intent_ref: "test",
      evidence: [],
      decision_rationale: "persist test",
      confidence: 1.0,
    });

    // Create new instance and reload
    const log2 = new CausalLog(storage, tmpDir);
    const count = await log2.loadIndex();
    expect(count).toBe(1);

    const stats = log2.getStats();
    expect(stats.total_events).toBe(1);
  });
});
