import { describe, it, expect, beforeEach } from "vitest";
import type { OfsObject } from "./types.js";
import { ContextManager } from "./context-manager.js";

function makeObj(type: string, id: string, props: Record<string, unknown> = {}): OfsObject {
  return {
    _type: type,
    _id: id,
    _version: 1,
    _created_at: new Date().toISOString(),
    _updated_at: new Date().toISOString(),
    _agent_id: "test-agent",
    ...props,
  };
}

describe("ContextManager", () => {
  let ctx: ContextManager;

  beforeEach(() => {
    ctx = new ContextManager({ goal: "test goal" });
  });

  describe("L1 Intent", () => {
    it("returns initial intent", () => {
      const intent = ctx.getIntent();
      expect(intent.goal).toBe("test goal");
      expect(intent.constraints).toEqual([]);
      expect(intent.focus_types).toEqual([]);
    });

    it("updates intent", () => {
      ctx.setIntent("new goal", ["no-delete"], ["service"]);
      const intent = ctx.getIntent();
      expect(intent.goal).toBe("new goal");
      expect(intent.constraints).toEqual(["no-delete"]);
      expect(intent.focus_types).toEqual(["service"]);
    });
  });

  describe("L2 Working Memory", () => {
    it("adds and retrieves objects", () => {
      const obj = makeObj("service", "svc-1", { name: "nginx" });
      ctx.addToWorkingMemory(obj);
      const wm = ctx.getWorkingMemory();
      expect(wm).toHaveLength(1);
      expect(wm[0]._id).toBe("svc-1");
    });

    it("updates existing object on re-add", () => {
      const obj1 = makeObj("service", "svc-1", { name: "nginx" });
      ctx.addToWorkingMemory(obj1);
      const obj2 = makeObj("service", "svc-1", { name: "nginx-updated" });
      ctx.addToWorkingMemory(obj2);
      const wm = ctx.getWorkingMemory();
      expect(wm).toHaveLength(1);
      expect(wm[0].name).toBe("nginx-updated");
    });

    it("removes object from working memory", () => {
      ctx.addToWorkingMemory(makeObj("service", "svc-1"));
      ctx.addToWorkingMemory(makeObj("service", "svc-2"));
      ctx.removeFromWorkingMemory("svc-1");
      expect(ctx.getWorkingMemory()).toHaveLength(1);
      expect(ctx.getWorkingMemory()[0]._id).toBe("svc-2");
    });

    it("touchObject bumps access count", () => {
      ctx.addToWorkingMemory(makeObj("service", "svc-1"));
      ctx.touchObject("svc-1");
      ctx.touchObject("svc-1");
      // After add (1) + 2 touches = 3, should survive compaction
      const result = ctx.compact();
      expect(result.kept).toContain("svc-1");
    });
  });

  describe("Auto-Compaction", () => {
    it("archives stale objects with low access count", () => {
      // Manually create a context manager and inject a stale entry
      const obj = makeObj("host", "h-1", { name: "server1" });
      ctx.addToWorkingMemory(obj);

      // Hack the internal state to make it stale (added 5 minutes ago, access_count=1)
      const l2 = (ctx as any).l2 as Map<string, any>;
      const entry = l2.get("h-1")!;
      entry.added_at = Date.now() - 5 * 60 * 1000; // 5 min ago
      entry.access_count = 1; // below threshold of 2

      const result = ctx.compact();
      expect(result.archived).toHaveLength(1);
      expect(result.archived[0]._id).toBe("h-1");
      expect(ctx.getWorkingMemory()).toHaveLength(0);
      expect(ctx.getStubs()).toHaveLength(1);
    });

    it("keeps objects in focus_types even if stale", () => {
      ctx.setIntent("test", [], ["host"]);
      const obj = makeObj("host", "h-1");
      ctx.addToWorkingMemory(obj);

      const l2 = (ctx as any).l2 as Map<string, any>;
      const entry = l2.get("h-1")!;
      entry.added_at = Date.now() - 5 * 60 * 1000;
      entry.access_count = 1;

      const result = ctx.compact();
      expect(result.archived).toHaveLength(0);
      expect(result.kept).toContain("h-1");
    });

    it("keeps frequently accessed objects", () => {
      const obj = makeObj("service", "svc-1");
      ctx.addToWorkingMemory(obj);

      const l2 = (ctx as any).l2 as Map<string, any>;
      const entry = l2.get("svc-1")!;
      entry.added_at = Date.now() - 5 * 60 * 1000;
      entry.access_count = 5; // above threshold

      const result = ctx.compact();
      expect(result.archived).toHaveLength(0);
      expect(result.kept).toContain("svc-1");
    });
  });

  describe("L3 Recall", () => {
    it("recalls objects by keyword match", async () => {
      const obj = makeObj("service", "svc-nginx", { name: "nginx-proxy" });
      ctx.addToWorkingMemory(obj);

      // Force archive it
      const l2 = (ctx as any).l2 as Map<string, any>;
      const entry = l2.get("svc-nginx")!;
      entry.added_at = Date.now() - 5 * 60 * 1000;
      entry.access_count = 1;
      ctx.compact();

      expect(ctx.getStubs()).toHaveLength(1);

      const result = await ctx.recall("nginx");
      expect(result.objects.length).toBeGreaterThan(0);
      expect(result.stubs_promoted).toContain("svc-nginx");
    });

    it("returns empty for no matches", async () => {
      const result = await ctx.recall("nonexistent");
      expect(result.objects).toHaveLength(0);
    });
  });

  describe("Serialization", () => {
    it("serialize and restore round-trip", () => {
      ctx.setIntent("deploy services", ["no-downtime"], ["service"]);
      ctx.addToWorkingMemory(makeObj("service", "svc-1", { name: "api" }));
      ctx.addToWorkingMemory(makeObj("host", "h-1", { name: "server1" }));

      const snapshot = ctx.serialize();
      expect(snapshot.intent.goal).toBe("deploy services");
      expect(snapshot.working_memory).toHaveLength(2);

      // Restore into a fresh manager
      const ctx2 = new ContextManager();
      ctx2.restore(snapshot);
      expect(ctx2.getIntent().goal).toBe("deploy services");
      expect(ctx2.getWorkingMemory()).toHaveLength(2);
    });
  });

  describe("Prompt Header", () => {
    it("generates compact prompt header", () => {
      ctx.setIntent("investigate outage", ["read-only"], ["service", "host"]);
      ctx.addToWorkingMemory(makeObj("service", "svc-1"));
      ctx.addToWorkingMemory(makeObj("service", "svc-2"));
      ctx.addToWorkingMemory(makeObj("host", "h-1"));

      const header = ctx.toPromptHeader();
      expect(header).toContain("[Intent] investigate outage");
      expect(header).toContain("[Constraints] read-only");
      expect(header).toContain("[Focus] service, host");
      expect(header).toContain("[Working Memory] 3 objects");
      expect(header).toContain("service(2)");
      expect(header).toContain("host(1)");
    });
  });

  describe("Stats", () => {
    it("reports correct stats", () => {
      ctx.addToWorkingMemory(makeObj("service", "svc-1"));
      const stats = ctx.getStats();
      expect(stats.l2_object_count).toBe(1);
      expect(stats.l3_stub_count).toBe(0);
      expect(stats.last_compaction).toBeNull();
    });
  });
});
