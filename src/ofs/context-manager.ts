/**
 * OFS v2 Context Manager — Three-Layer Context
 *
 * L1 Intent:        ≤512 tokens, always in LLM window
 * L2 Working Memory: active objects, auto-compaction when stale
 * L3 Episodic Store: archived objects as summary stubs, semantic recall
 */
import type {
  OfsObject,
  OfsContextManager,
  Intent,
  SummaryStub,
  CompactionResult,
  RecallResult,
  ContextStats,
  ContextSnapshot,
} from "./types.js";

// Compaction thresholds
const COMPACTION_MIN_ACCESS = 2;
const COMPACTION_AGE_MS = 3 * 60 * 1000; // 3 minutes
const MAX_L2_OBJECTS = 50;
const TOKEN_ESTIMATE_DIVISOR = 4; // ~4 chars per token

interface L2Entry {
  obj: OfsObject;
  access_count: number;
  added_at: number;
  last_accessed: number;
}

export class ContextManager implements OfsContextManager {
  private intent: Intent;
  private l2: Map<string, L2Entry> = new Map();
  private l3: Map<string, SummaryStub> = new Map();
  private lastCompaction: string | null = null;

  constructor(intent?: Partial<Intent>) {
    this.intent = {
      goal: intent?.goal ?? "",
      constraints: intent?.constraints ?? [],
      focus_types: intent?.focus_types ?? [],
      updated_at: intent?.updated_at ?? new Date().toISOString(),
    };
  }

  // --- L1 Intent ---

  getIntent(): Intent {
    return { ...this.intent };
  }

  setIntent(goal: string, constraints?: string[], focus_types?: string[]): void {
    this.intent = {
      goal,
      constraints: constraints ?? this.intent.constraints,
      focus_types: focus_types ?? this.intent.focus_types,
      updated_at: new Date().toISOString(),
    };
  }

  // --- L2 Working Memory ---

  getWorkingMemory(): OfsObject[] {
    return Array.from(this.l2.values()).map((e) => e.obj);
  }

  addToWorkingMemory(obj: OfsObject): void {
    const existing = this.l2.get(obj._id);
    const now = Date.now();
    if (existing) {
      existing.obj = obj;
      existing.access_count++;
      existing.last_accessed = now;
    } else {
      this.l2.set(obj._id, {
        obj,
        access_count: 1,
        added_at: now,
        last_accessed: now,
      });
    }
    // Remove from L3 if it was there (promoted back)
    this.l3.delete(obj._id);

    // Auto-compact if L2 is getting large
    if (this.l2.size > MAX_L2_OBJECTS) {
      this.compact();
    }
  }

  removeFromWorkingMemory(id: string): void {
    this.l2.delete(id);
  }

  touchObject(id: string): void {
    const entry = this.l2.get(id);
    if (entry) {
      entry.access_count++;
      entry.last_accessed = Date.now();
    }
  }

  // --- L3 Episodic Store ---

  getStubs(): SummaryStub[] {
    return Array.from(this.l3.values());
  }

  async recall(query: string, topK = 5): Promise<RecallResult> {
    const queryLower = query.toLowerCase();
    const scored: Array<{ stub: SummaryStub; score: number }> = [];

    for (const stub of this.l3.values()) {
      let score = 0;
      // Simple keyword matching for now; can be replaced with embedding similarity
      if (stub.summary.toLowerCase().includes(queryLower)) score += 3;
      if (stub._type.toLowerCase().includes(queryLower)) score += 2;
      if (stub._id.toLowerCase().includes(queryLower)) score += 2;
      if (score > 0) scored.push({ stub, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const topStubs = scored.slice(0, topK);

    // Promote recalled stubs back to L2 (need to reconstruct objects)
    // For now, we return the stubs info; actual object retrieval requires storage
    const promotedIds: string[] = [];
    const objects: OfsObject[] = [];

    for (const { stub } of topStubs) {
      // Create a minimal object from stub for the caller
      // Real implementation would fetch from storage
      const obj: OfsObject = {
        _type: stub._type,
        _id: stub._id,
        _version: 0,
        _created_at: stub.archived_at,
        _updated_at: stub.last_accessed,
        _agent_id: "",
        _summary: stub.summary,
        _recalled: true,
      };
      objects.push(obj);
      promotedIds.push(stub._id);
    }

    return {
      objects,
      stubs_promoted: promotedIds,
      query,
    };
  }

  // --- Auto-Compaction ---

  compact(): CompactionResult {
    const now = Date.now();
    const archived: SummaryStub[] = [];
    const kept: string[] = [];

    for (const [id, entry] of this.l2) {
      const age = now - entry.added_at;
      const isStale = entry.access_count < COMPACTION_MIN_ACCESS && age > COMPACTION_AGE_MS;
      const isNotFocused = !this.intent.focus_types.includes(entry.obj._type);

      if (isStale && isNotFocused) {
        const stub: SummaryStub = {
          _type: entry.obj._type,
          _id: id,
          summary: this.summarizeObject(entry.obj),
          archived_at: new Date().toISOString(),
          access_count: entry.access_count,
          last_accessed: new Date(entry.last_accessed).toISOString(),
        };
        this.l3.set(id, stub);
        this.l2.delete(id);
        archived.push(stub);
      } else {
        kept.push(id);
      }
    }

    const timestamp = new Date().toISOString();
    this.lastCompaction = timestamp;

    return { archived, kept, timestamp };
  }

  // --- Stats ---

  getStats(): ContextStats {
    const header = this.toPromptHeader();
    return {
      l1_tokens: Math.ceil(header.length / TOKEN_ESTIMATE_DIVISOR),
      l2_object_count: this.l2.size,
      l2_total_size: this.estimateL2Size(),
      l3_stub_count: this.l3.size,
      last_compaction: this.lastCompaction,
    };
  }

  // --- Serialization ---

  toPromptHeader(): string {
    const parts: string[] = [];

    // L1: Intent block
    parts.push(`[Intent] ${this.intent.goal}`);
    if (this.intent.constraints.length > 0) {
      parts.push(`[Constraints] ${this.intent.constraints.join("; ")}`);
    }
    if (this.intent.focus_types.length > 0) {
      parts.push(`[Focus] ${this.intent.focus_types.join(", ")}`);
    }

    // L2: Working memory summary
    const l2Types = new Map<string, number>();
    for (const entry of this.l2.values()) {
      l2Types.set(entry.obj._type, (l2Types.get(entry.obj._type) ?? 0) + 1);
    }
    if (l2Types.size > 0) {
      const typeSummary = Array.from(l2Types.entries())
        .map(([t, c]) => `${t}(${c})`)
        .join(", ");
      parts.push(`[Working Memory] ${this.l2.size} objects: ${typeSummary}`);
    }

    // L3: Archived count
    if (this.l3.size > 0) {
      parts.push(`[Archived] ${this.l3.size} objects in episodic store`);
    }

    return parts.join("\n");
  }

  serialize(): ContextSnapshot {
    return {
      intent: { ...this.intent },
      working_memory: this.getWorkingMemory(),
      stubs: this.getStubs(),
      stats: this.getStats(),
      saved_at: new Date().toISOString(),
    };
  }

  restore(snapshot: ContextSnapshot): void {
    this.intent = { ...snapshot.intent };
    this.l2.clear();
    this.l3.clear();

    for (const obj of snapshot.working_memory) {
      this.l2.set(obj._id, {
        obj,
        access_count: 1,
        added_at: Date.now(),
        last_accessed: Date.now(),
      });
    }

    for (const stub of snapshot.stubs) {
      this.l3.set(stub._id, stub);
    }

    this.lastCompaction = snapshot.stats.last_compaction;
  }

  // --- Private helpers ---

  private summarizeObject(obj: OfsObject): string {
    // Extract key fields for summary, skip internal fields
    const fields = Object.entries(obj)
      .filter(([k]) => !k.startsWith("_"))
      .slice(0, 5)
      .map(([k, v]) => {
        const val = typeof v === "string" ? v.slice(0, 50) : JSON.stringify(v);
        return `${k}=${val}`;
      });
    return `${obj._type}/${obj._id}: ${fields.join(", ") || "(no properties)"}`;
  }

  private estimateL2Size(): number {
    let size = 0;
    for (const entry of this.l2.values()) {
      size += JSON.stringify(entry.obj).length;
    }
    return size;
  }
}
