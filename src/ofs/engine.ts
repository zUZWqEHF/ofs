import { execFile } from "node:child_process";
/**
 * OFS Engine — the core Ontology File System
 *
 * Manages objects, links, events, and actions following three principles:
 * 1. Context as Files — all persistence via files
 * 2. Bash Bootstrap — actions are bash scripts
 * 3. Single Select, No Merge — no complex merges
 */
import * as crypto from "node:crypto";
import type {
  OfsObject,
  OfsLink,
  OfsEvent,
  OfsStorage,
  OfsKvCache,
  AgentIdentity,
  ContextManifest,
  ShareLink,
  CausalEvent,
  Intent,
  RecallResult,
  CompactionResult,
  ContextSnapshot,
  ContextStats,
} from "./types.js";
import { CausalLog } from "./causal-log.js";
import { ContextManager } from "./context-manager.js";
import { EventLog } from "./event-log.js";
import { SchemaRegistry } from "./schema-registry.js";

export interface OfsEngineV2Options {
  enableContext?: boolean;
  enableCausalLog?: boolean;
  sharedOntologyPath?: string;
}

export class OfsEngine {
  private eventLog: EventLog;
  // v2: optional context manager and causal log
  private contextManager: ContextManager | null = null;
  private causalLog: CausalLog | null = null;

  constructor(
    private storage: OfsStorage,
    private cache: OfsKvCache,
    private schema: SchemaRegistry,
    private agentId: string,
    private basePath: string,
    private v2Options?: OfsEngineV2Options,
  ) {
    this.eventLog = new EventLog(storage, basePath);

    if (v2Options?.enableContext) {
      this.contextManager = new ContextManager();
    }
    if (v2Options?.enableCausalLog) {
      this.causalLog = new CausalLog(storage, basePath);
    }
  }

  // --- v2: Context Manager accessors ---

  getContextManager(): ContextManager | null {
    return this.contextManager;
  }

  getCausalLog(): CausalLog | null {
    return this.causalLog;
  }

  // --- Raw storage access (for Shared Ontology, Context Snapshots, etc.) ---

  /**
   * Write arbitrary data to storage (local FS + TOS).
   * Use for data that doesn't fit the object/link/event model,
   * e.g. shared-ontology/term-registry.json, context-snapshot.json.
   */
  async putRaw(key: string, data: string): Promise<void> {
    await this.storage.put(key, data);
  }

  /**
   * Read arbitrary data from storage.
   */
  async getRaw(key: string): Promise<string | null> {
    return this.storage.get(key);
  }

  /**
   * Flush all pending TOS writes. Call before process exit.
   */
  async flush(): Promise<void> {
    if ("flush" in this.storage && typeof (this.storage as any).flush === "function") {
      await (this.storage as any).flush();
    }
  }

  // --- Object CRUD ---

  async createObject(
    typeName: string,
    data: Record<string, unknown>,
    reason?: string,
  ): Promise<OfsObject> {
    const errors = this.schema.validateObject(typeName, data);
    if (errors.length > 0) throw new Error(`Validation failed: ${errors.join(", ")}`);

    const typeDef = this.schema.getObjectType(typeName)!;
    const id = (data[typeDef.primary_key] as string) ?? crypto.randomUUID();
    const now = new Date().toISOString();

    // v3 temporal: check if object already exists (idempotent create → update)
    const existingKey = `objects/${typeName}/${id}.json`;
    const existingRaw = await this.storage.get(existingKey);
    if (existingRaw) {
      // Object exists — delegate to updateObject for proper versioning
      return this.updateObject(typeName, id, data, reason);
    }

    const obj: OfsObject = {
      _type: typeName,
      _id: id,
      _version: 1,
      _created_at: now,
      _updated_at: now,
      _valid_from: now,
      _agent_id: this.agentId,
      ...data,
    };

    const key = `objects/${typeName}/${id}.json`;
    await this.storage.put(key, JSON.stringify(obj, null, 2));
    await this.cache.set(`ofs:obj:${typeName}:${id}`, JSON.stringify(obj));

    // v3 temporal: event carries full after snapshot + reason
    await this.eventLog.append({
      _type: "create",
      _object_type: typeName,
      _object_id: id,
      _agent_id: this.agentId,
      _data: data,
      _before: null,
      _after: obj as unknown as Record<string, unknown>,
      _reason: reason,
      _object_version: 1,
    });

    // v2: auto-add to working memory
    if (this.contextManager) {
      this.contextManager.addToWorkingMemory(obj);
    }

    return obj;
  }

  async getObject(typeName: string, id: string): Promise<OfsObject | null> {
    // Check cache first
    const cached = await this.cache.get(`ofs:obj:${typeName}:${id}`);
    if (cached) return JSON.parse(cached) as OfsObject;

    const key = `objects/${typeName}/${id}.json`;
    const raw = await this.storage.get(key);
    if (!raw) return null;

    const obj = JSON.parse(raw) as OfsObject;
    await this.cache.set(`ofs:obj:${typeName}:${id}`, raw);

    // v2: touch in working memory
    if (this.contextManager) {
      this.contextManager.touchObject(id);
    }

    return obj;
  }

  async updateObject(
    typeName: string,
    id: string,
    updates: Record<string, unknown>,
    reason?: string,
  ): Promise<OfsObject> {
    const existing = await this.getObject(typeName, id);
    if (!existing) throw new Error(`Object not found: ${typeName}/${id}`);

    const now = new Date().toISOString();
    const newVersion = existing._version + 1;

    // v3 temporal: capture before snapshot
    const before = { ...existing } as unknown as Record<string, unknown>;

    const updated: OfsObject = {
      ...existing,
      ...updates,
      _type: typeName,
      _id: id,
      _version: newVersion,
      _created_at: existing._created_at,
      _updated_at: now,
      _valid_from: now,
      _supersedes: `${id}@v${existing._version}`,
      _agent_id: this.agentId,
    };

    const key = `objects/${typeName}/${id}.json`;
    await this.storage.put(key, JSON.stringify(updated, null, 2));
    await this.cache.set(`ofs:obj:${typeName}:${id}`, JSON.stringify(updated));

    // v3 temporal: event carries before/after + reason
    await this.eventLog.append({
      _type: "update",
      _object_type: typeName,
      _object_id: id,
      _agent_id: this.agentId,
      _data: updates,
      _before: before,
      _after: updated as unknown as Record<string, unknown>,
      _reason: reason,
      _object_version: newVersion,
    });

    return updated;
  }

  async deleteObject(typeName: string, id: string, reason?: string): Promise<void> {
    // v3 temporal: capture before snapshot
    const existing = await this.getObject(typeName, id);
    const before = existing
      ? ({ ...existing } as unknown as Record<string, unknown>)
      : null;

    const key = `objects/${typeName}/${id}.json`;
    await this.storage.delete(key);
    await this.cache.del(`ofs:obj:${typeName}:${id}`);

    // v3 temporal: event carries before snapshot + reason
    await this.eventLog.append({
      _type: "delete",
      _object_type: typeName,
      _object_id: id,
      _agent_id: this.agentId,
      _data: {},
      _before: before,
      _after: null,
      _reason: reason,
      _object_version: existing ? existing._version : undefined,
    });
  }

  async listObjects(typeName: string): Promise<OfsObject[]> {
    const prefix = `objects/${typeName}/`;
    const keys = await this.storage.list(prefix);
    const objects: OfsObject[] = [];

    for (const key of keys) {
      if (!key.endsWith(".json")) continue;
      const raw = await this.storage.get(key);
      if (raw) objects.push(JSON.parse(raw) as OfsObject);
    }

    return objects;
  }

  // --- v3 temporal: history & time-travel queries ---

  /**
   * Get version history for an object — reconstructed from event log.
   * Returns events newest-first with before/after snapshots.
   */
  async getObjectHistory(
    typeName: string,
    id: string,
  ): Promise<OfsEvent[]> {
    const events = await this.eventLog.query({
      objectType: typeName,
      objectId: id,
      limit: 1000,
    });
    return events.reverse(); // newest first
  }

  /**
   * Get an object's state at a specific point in time.
   * Walks the event log to find the last event before `asOf`.
   */
  async getObjectAtTime(
    typeName: string,
    id: string,
    asOf: string,
  ): Promise<Record<string, unknown> | null> {
    const events = await this.eventLog.query({
      objectType: typeName,
      objectId: id,
      limit: 1000,
    });
    // Find the last event at or before asOf
    let snapshot: Record<string, unknown> | null = null;
    for (const evt of events) {
      if (evt._timestamp > asOf) break;
      if (evt._after) snapshot = evt._after;
      if (evt._type === "delete") snapshot = null;
    }
    return snapshot;
  }

  // --- Link management ---

  async createLink(
    linkType: string,
    sourceType: string,
    sourceId: string,
    targetType: string,
    targetId: string,
    properties?: Record<string, unknown>,
  ): Promise<OfsLink> {
    const linkDef = this.schema.getLinkType(linkType);
    if (!linkDef) throw new Error(`Unknown link type: ${linkType}`);

    const link: OfsLink = {
      _link: linkType,
      _source_type: sourceType,
      _source_id: sourceId,
      _target_type: targetType,
      _target_id: targetId,
      _created_at: new Date().toISOString(),
      _agent_id: this.agentId,
      properties,
    };

    const key = `links/${linkType}/${sourceType}_${sourceId}__${targetType}_${targetId}.json`;
    await this.storage.put(key, JSON.stringify(link, null, 2));

    await this.eventLog.append({
      _type: "link",
      _object_type: sourceType,
      _object_id: sourceId,
      _agent_id: this.agentId,
      _data: { link_type: linkType, target_type: targetType, target_id: targetId },
    });

    return link;
  }

  async getLinks(opts: {
    linkType?: string;
    sourceType?: string;
    sourceId?: string;
    targetType?: string;
    targetId?: string;
  }): Promise<OfsLink[]> {
    const prefix = opts.linkType ? `links/${opts.linkType}/` : "links/";
    const keys = await this.storage.list(prefix);
    const links: OfsLink[] = [];

    for (const key of keys) {
      if (!key.endsWith(".json")) continue;
      const raw = await this.storage.get(key);
      if (!raw) continue;
      const link = JSON.parse(raw) as OfsLink;
      if (opts.sourceType && link._source_type !== opts.sourceType) continue;
      if (opts.sourceId && link._source_id !== opts.sourceId) continue;
      if (opts.targetType && link._target_type !== opts.targetType) continue;
      if (opts.targetId && link._target_id !== opts.targetId) continue;
      links.push(link);
    }

    return links;
  }

  async deleteLink(
    linkType: string,
    sourceType: string,
    sourceId: string,
    targetType: string,
    targetId: string,
  ): Promise<void> {
    const key = `links/${linkType}/${sourceType}_${sourceId}__${targetType}_${targetId}.json`;
    await this.storage.delete(key);

    await this.eventLog.append({
      _type: "unlink",
      _object_type: sourceType,
      _object_id: sourceId,
      _agent_id: this.agentId,
      _data: { link_type: linkType, target_type: targetType, target_id: targetId },
    });
  }

  // --- Action execution ---

  async executeAction(
    actionName: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const actionDef = this.schema.getAction(actionName);
    if (!actionDef) throw new Error(`Unknown action: ${actionName}`);

    return new Promise((resolve) => {
      execFile(
        "bash",
        [actionDef.script, ...args],
        { timeout: 60_000, env: { ...process.env, OFS_AGENT_ID: this.agentId } },
        (error, stdout, stderr) => {
          resolve({
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            exitCode: error?.code ? Number(error.code) : error ? 1 : 0,
          });
        },
      );
    });
  }

  // --- Event queries ---

  async tailEvents(n: number): Promise<OfsEvent[]> {
    return this.eventLog.tail(n);
  }

  async queryEvents(opts: Parameters<EventLog["query"]>[0]): Promise<OfsEvent[]> {
    return this.eventLog.query(opts);
  }

  // --- Agent identity ---

  async registerAgent(identity: AgentIdentity): Promise<void> {
    const key = `agents/${identity.agent_id}.json`;
    await this.storage.put(key, JSON.stringify(identity, null, 2));
  }

  async getAgent(agentId: string): Promise<AgentIdentity | null> {
    const raw = await this.storage.get(`agents/${agentId}.json`);
    return raw ? (JSON.parse(raw) as AgentIdentity) : null;
  }

  async listAgents(): Promise<AgentIdentity[]> {
    const keys = await this.storage.list("agents/");
    const agents: AgentIdentity[] = [];
    for (const key of keys) {
      if (!key.endsWith(".json")) continue;
      const raw = await this.storage.get(key);
      if (raw) agents.push(JSON.parse(raw) as AgentIdentity);
    }
    return agents;
  }

  // --- Context manifest ---

  async getManifest(): Promise<ContextManifest | null> {
    const raw = await this.storage.get("manifest.json");
    return raw ? (JSON.parse(raw) as ContextManifest) : null;
  }

  async updateManifest(): Promise<ContextManifest> {
    const objectKeys = await this.storage.list("objects/");
    const linkKeys = await this.storage.list("links/");
    const eventKeys = await this.storage.list("events/");

    const manifest: ContextManifest = {
      agent_id: this.agentId,
      agent_type: "unknown",
      version: ((await this.getManifest())?.version ?? 0) + 1,
      created_at: (await this.getManifest())?.created_at ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
      schema_version: "1.0.0",
      storage_backend: "hybrid",
      objects_count: objectKeys.filter((k) => k.endsWith(".json")).length,
      links_count: linkKeys.filter((k) => k.endsWith(".json")).length,
      events_count: eventKeys.length,
    };

    await this.storage.put("manifest.json", JSON.stringify(manifest, null, 2));
    return manifest;
  }

  // --- Share links (context sharing) ---

  async createShareLink(opts: {
    targetAgentId?: string;
    pathPrefix?: string;
    permissions?: "read" | "read-write";
    expiresInMs?: number;
  }): Promise<ShareLink> {
    const link: ShareLink = {
      link_id: crypto.randomUUID(),
      agent_id: this.agentId,
      target_agent_id: opts.targetAgentId,
      path_prefix: opts.pathPrefix ?? "",
      permissions: opts.permissions ?? "read",
      created_at: new Date().toISOString(),
      expires_at: opts.expiresInMs
        ? new Date(Date.now() + opts.expiresInMs).toISOString()
        : undefined,
    };

    await this.storage.put(`shares/${link.link_id}.json`, JSON.stringify(link, null, 2));
    return link;
  }

  async getShareLink(linkId: string): Promise<ShareLink | null> {
    const raw = await this.storage.get(`shares/${linkId}.json`);
    if (!raw) return null;
    const link = JSON.parse(raw) as ShareLink;
    if (link.expires_at && new Date(link.expires_at) < new Date()) return null;
    return link;
  }

  async listShareLinks(): Promise<ShareLink[]> {
    const keys = await this.storage.list("shares/");
    const links: ShareLink[] = [];
    const now = new Date();
    for (const key of keys) {
      if (!key.endsWith(".json")) continue;
      const raw = await this.storage.get(key);
      if (!raw) continue;
      const link = JSON.parse(raw) as ShareLink;
      if (link.expires_at && new Date(link.expires_at) < now) continue;
      links.push(link);
    }
    return links;
  }

  /**
   * Read shared context from another agent via share link.
   * Share agent = share context link: always points to the latest version.
   */
  async readSharedContext(linkId: string): Promise<OfsObject[]> {
    const shareLink = await this.getShareLink(linkId);
    if (!shareLink) throw new Error(`Share link not found or expired: ${linkId}`);

    const prefix = shareLink.path_prefix ? `objects/${shareLink.path_prefix}` : "objects/";

    const keys = await this.storage.list(prefix);
    const objects: OfsObject[] = [];
    for (const key of keys) {
      if (!key.endsWith(".json")) continue;
      const raw = await this.storage.get(key);
      if (raw) objects.push(JSON.parse(raw) as OfsObject);
    }
    return objects;
  }

  // --- Search ---

  async grep(pattern: string, typeName?: string): Promise<OfsObject[]> {
    const prefix = typeName ? `objects/${typeName}/` : "objects/";
    const keys = await this.storage.list(prefix);
    const regex = new RegExp(pattern, "i");
    const results: OfsObject[] = [];

    for (const key of keys) {
      if (!key.endsWith(".json")) continue;
      const raw = await this.storage.get(key);
      if (!raw) continue;
      if (regex.test(raw)) {
        results.push(JSON.parse(raw) as OfsObject);
      }
    }

    return results;
  }

  // --- Snapshot support (qcow2 context snapshot) ---

  async exportSnapshot(): Promise<string> {
    const manifest = await this.updateManifest();
    const snapshot = {
      manifest,
      exported_at: new Date().toISOString(),
      agent_id: this.agentId,
    };
    const key = `snapshots/${manifest.version}.json`;
    await this.storage.put(key, JSON.stringify(snapshot, null, 2));
    return key;
  }

  // ============================================================
  // v2: Causal Event, Context Management, Recall
  // ============================================================

  /**
   * Emit a causal event — extends standard event with causality data.
   * Falls back to standard event log if causal log not enabled.
   */
  async emitCausalEvent(opts: {
    type: OfsEvent["_type"];
    objectType: string;
    objectId: string;
    data: Record<string, unknown>;
    causedBy?: string[];
    evidence?: string[];
    decisionRationale?: string;
    confidence?: number;
  }): Promise<CausalEvent | OfsEvent> {
    if (this.causalLog) {
      return this.causalLog.append({
        _type: opts.type,
        _object_type: opts.objectType,
        _object_id: opts.objectId,
        _agent_id: this.agentId,
        _data: opts.data,
        caused_by: opts.causedBy ?? [],
        intent_ref: this.contextManager?.getIntent().goal ?? "",
        evidence: opts.evidence ?? [],
        decision_rationale: opts.decisionRationale ?? "",
        confidence: opts.confidence ?? 1.0,
      });
    }

    // Fallback to standard event log
    return this.eventLog.append({
      _type: opts.type,
      _object_type: opts.objectType,
      _object_id: opts.objectId,
      _agent_id: this.agentId,
      _data: opts.data,
    });
  }

  /**
   * Set the current intent (L1 context).
   */
  setIntent(goal: string, constraints?: string[], focusTypes?: string[]): void {
    if (!this.contextManager)
      throw new Error("Context manager not enabled (use v2Options.enableContext)");
    this.contextManager.setIntent(goal, constraints, focusTypes);
  }

  /**
   * Get intent (L1).
   */
  getIntent(): Intent | null {
    return this.contextManager?.getIntent() ?? null;
  }

  /**
   * Recall objects from L3 episodic store by query.
   */
  async recall(query: string, topK?: number): Promise<RecallResult | null> {
    if (!this.contextManager) return null;
    return this.contextManager.recall(query, topK);
  }

  /**
   * Force compaction of working memory.
   */
  compactWorkingMemory(): CompactionResult | null {
    if (!this.contextManager) return null;
    return this.contextManager.compact();
  }

  /**
   * Get context stats.
   */
  getContextStats(): ContextStats | null {
    return this.contextManager?.getStats() ?? null;
  }

  /**
   * Get prompt header for LLM (L1 + L2 summary, ≤512 tokens).
   */
  getPromptHeader(): string {
    return this.contextManager?.toPromptHeader() ?? "";
  }

  /**
   * Save/restore full context snapshot.
   */
  saveContextSnapshot(): ContextSnapshot | null {
    return this.contextManager?.serialize() ?? null;
  }

  restoreContextSnapshot(snapshot: ContextSnapshot): void {
    if (!this.contextManager) throw new Error("Context manager not enabled");
    this.contextManager.restore(snapshot);
  }

  /**
   * Initialize v2 modules (load causal index, etc). Call after construction.
   */
  async initV2(): Promise<void> {
    if (this.causalLog) {
      await this.causalLog.loadIndex();
    }
  }
}
