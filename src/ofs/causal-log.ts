/**
 * OFS v2 Causal Log — Causal Event Tracing
 *
 * Extends EventLog with causality tracking:
 * - caused_by[] links to parent events
 * - intent_ref captures the goal at emission time
 * - evidence[] and decision_rationale for explainability
 * - traceBack/traceForward/attribute queries
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CausalEvent, CausalChain, Attribution, OfsStorage } from "./types.js";

export class CausalLog {
  private logDir: string;
  // In-memory index for fast causal graph traversal
  private eventIndex: Map<string, CausalEvent> = new Map();
  // child_id -> parent_ids
  private childToParents: Map<string, string[]> = new Map();
  // parent_id -> child_ids
  private parentToChildren: Map<string, string[]> = new Map();

  constructor(
    private storage: OfsStorage,
    basePath: string,
  ) {
    this.logDir = path.join(basePath, "causal-events");
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  async append(event: Omit<CausalEvent, "_event_id" | "_timestamp">): Promise<CausalEvent> {
    const full: CausalEvent = {
      ...event,
      _event_id: crypto.randomUUID(),
      _timestamp: new Date().toISOString(),
    };

    // Write to JSONL
    const day = full._timestamp.slice(0, 10);
    const localFile = path.join(this.logDir, `${day}.jsonl`);
    await fs.promises.appendFile(localFile, JSON.stringify(full) + "\n");

    // Update in-memory index
    this.indexEvent(full);

    // Async backup
    this.storage
      .put(`causal-events/${day}.jsonl`, await fs.promises.readFile(localFile, "utf-8"))
      .catch(() => {});

    return full;
  }

  /**
   * Trace backwards from an event to find all ancestors (causes).
   */
  traceBack(eventId: string, maxDepth = 10): CausalChain {
    const events: CausalEvent[] = [];
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: eventId, depth: 0 }];
    let maxReached = 0;

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);
      maxReached = Math.max(maxReached, depth);

      const event = this.eventIndex.get(id);
      if (!event) continue;
      events.push(event);

      const parents = this.childToParents.get(id) ?? [];
      for (const parentId of parents) {
        queue.push({ id: parentId, depth: depth + 1 });
      }
    }

    return {
      events,
      root_event_id: eventId,
      depth: maxReached,
    };
  }

  /**
   * Trace forward from an event to find all effects (consequences).
   */
  traceForward(eventId: string, maxDepth = 10): CausalChain {
    const events: CausalEvent[] = [];
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: eventId, depth: 0 }];
    let maxReached = 0;

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);
      maxReached = Math.max(maxReached, depth);

      const event = this.eventIndex.get(id);
      if (!event) continue;
      events.push(event);

      const children = this.parentToChildren.get(id) ?? [];
      for (const childId of children) {
        queue.push({ id: childId, depth: depth + 1 });
      }
    }

    return {
      events,
      root_event_id: eventId,
      depth: maxReached,
    };
  }

  /**
   * Attribute: given an object, find the causal chain that created/modified it.
   */
  attribute(objectId: string, objectType: string): Attribution {
    // Find all events related to this object
    const relatedEvents: CausalEvent[] = [];
    for (const event of this.eventIndex.values()) {
      if (event._object_id === objectId && event._object_type === objectType) {
        relatedEvents.push(event);
      }
    }

    if (relatedEvents.length === 0) {
      return {
        object_id: objectId,
        object_type: objectType,
        causal_chain: { events: [], root_event_id: "", depth: 0 },
        confidence: 0,
      };
    }

    // Find the earliest event and trace back from it
    relatedEvents.sort((a, b) => a._timestamp.localeCompare(b._timestamp));
    const earliest = relatedEvents[0];
    const chain = this.traceBack(earliest._event_id);

    // Average confidence across chain events
    const avgConfidence =
      chain.events.length > 0
        ? chain.events.reduce((sum, e) => sum + (e.confidence ?? 1), 0) / chain.events.length
        : 0;

    return {
      object_id: objectId,
      object_type: objectType,
      causal_chain: chain,
      confidence: avgConfidence,
    };
  }

  /**
   * Load events from disk into in-memory index.
   * Call this on startup to rebuild the causal graph.
   */
  async loadIndex(): Promise<number> {
    if (!fs.existsSync(this.logDir)) return 0;

    const files = (await fs.promises.readdir(this.logDir))
      .filter((f) => f.endsWith(".jsonl"))
      .sort();

    let count = 0;
    for (const file of files) {
      const content = await fs.promises.readFile(path.join(this.logDir, file), "utf-8");
      for (const line of content.trim().split("\n").filter(Boolean)) {
        try {
          const event = JSON.parse(line) as CausalEvent;
          this.indexEvent(event);
          count++;
        } catch {
          // skip malformed
        }
      }
    }

    return count;
  }

  /**
   * Query causal events with filters.
   */
  async query(opts: {
    objectType?: string;
    objectId?: string;
    intentRef?: string;
    minConfidence?: number;
    limit?: number;
  }): Promise<CausalEvent[]> {
    const results: CausalEvent[] = [];
    const limit = opts.limit ?? 100;

    for (const event of this.eventIndex.values()) {
      if (results.length >= limit) break;
      if (opts.objectType && event._object_type !== opts.objectType) continue;
      if (opts.objectId && event._object_id !== opts.objectId) continue;
      if (opts.intentRef && !event.intent_ref.includes(opts.intentRef)) continue;
      if (opts.minConfidence !== undefined && event.confidence < opts.minConfidence) continue;
      results.push(event);
    }

    return results;
  }

  /**
   * Get stats about the causal graph.
   */
  getStats(): { total_events: number; root_events: number; max_depth: number } {
    let rootCount = 0;
    let maxDepth = 0;

    for (const event of this.eventIndex.values()) {
      if (event.caused_by.length === 0) {
        rootCount++;
        const chain = this.traceForward(event._event_id, 20);
        maxDepth = Math.max(maxDepth, chain.depth);
      }
    }

    return {
      total_events: this.eventIndex.size,
      root_events: rootCount,
      max_depth: maxDepth,
    };
  }

  // --- Private ---

  private indexEvent(event: CausalEvent): void {
    this.eventIndex.set(event._event_id, event);
    this.childToParents.set(event._event_id, event.caused_by);

    for (const parentId of event.caused_by) {
      const children = this.parentToChildren.get(parentId) ?? [];
      children.push(event._event_id);
      this.parentToChildren.set(parentId, children);
    }
  }
}
