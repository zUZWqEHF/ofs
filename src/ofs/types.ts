/**
 * Ontology File System (OFS) — Core Types
 *
 * Five primitives: Object, Property, Link, Action, Event
 * Three-layer view: Ground Truth → Context → Action
 */

// --- Schema / Type definitions ---

export interface PropertyDef {
  type: "string" | "integer" | "float" | "boolean" | "datetime" | "json";
  required?: boolean;
  description?: string;
  enum?: string[];
  default?: unknown;
}

export interface ObjectTypeDef {
  type: string;
  description: string;
  primary_key: string;
  properties: Record<string, PropertyDef>;
  version?: number;
}

export interface LinkTypeDef {
  link: string;
  description: string;
  source_type: string;
  target_type: string;
  properties?: Record<string, PropertyDef>;
}

export interface ActionDef {
  action: string;
  description: string;
  input_types?: string[];
  output_type?: string;
  script: string; // path to bash script relative to ontology root
}

// --- Runtime instances ---

export interface OfsObject {
  _type: string;
  _id: string;
  _version: number;
  _created_at: string;
  _updated_at: string;
  _valid_from: string; // v3 temporal: when this version became the current truth
  _agent_id: string;
  _supersedes?: string; // v3 temporal: "<id>@v<N>" — which version this replaces
  [key: string]: unknown;
}

export interface OfsLink {
  _link: string;
  _source_type: string;
  _source_id: string;
  _target_type: string;
  _target_id: string;
  _created_at: string;
  _agent_id: string;
  properties?: Record<string, unknown>;
}

export interface OfsEvent {
  _event_id: string;
  _type: "create" | "update" | "delete" | "link" | "unlink" | "action";
  _object_type: string;
  _object_id: string;
  _agent_id: string;
  _timestamp: string;
  _data: Record<string, unknown>;
  // v3 temporal fields
  _before?: Record<string, unknown> | null; // full snapshot before mutation
  _after?: Record<string, unknown> | null; // full snapshot after mutation
  _reason?: string; // decision trace — why this change was made
  _object_version?: number; // object version after this event
}

// --- Agent identity ---

export interface AgentIdentity {
  agent_id: string;
  agent_type: string; // "inspection" | "diagnosis" | "bot" | ...
  host: string;
  capabilities: string[];
  created_at: string;
}

// --- Context manifest ---

export interface ContextManifest {
  agent_id: string;
  agent_type: string;
  version: number;
  created_at: string;
  updated_at: string;
  schema_version: string;
  storage_backend: "local" | "tos" | "hybrid";
  objects_count: number;
  links_count: number;
  events_count: number;
}

// --- Share link ---

export interface ShareLink {
  link_id: string;
  agent_id: string;
  target_agent_id?: string; // null = public read
  path_prefix: string; // what to share (e.g., "objects/service/" or "" for all)
  permissions: "read" | "read-write";
  created_at: string;
  expires_at?: string;
}

// --- Storage interface ---

export interface OfsStorage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  exists(key: string): Promise<boolean>;
}

// --- KV Cache interface ---

export interface OfsKvCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
  flush(): Promise<void>;
}

// ============================================================
// OFS v2 — Three-Layer Context, Causal Tracing, Shared Ontology
// ============================================================

// --- L1 Intent ---

export interface Intent {
  goal: string;
  constraints: string[];
  focus_types: string[]; // object types currently relevant
  updated_at: string;
}

// --- L2/L3 Context Layers ---

export type ContextLayer = "L1" | "L2" | "L3";

export interface SummaryStub {
  _type: string;
  _id: string;
  summary: string; // one-line digest of the archived object
  archived_at: string;
  access_count: number;
  last_accessed: string;
}

export interface CompactionResult {
  archived: SummaryStub[];
  kept: string[]; // ids that stayed in L2
  timestamp: string;
}

export interface RecallResult {
  objects: OfsObject[];
  stubs_promoted: string[]; // ids recalled from L3 → L2
  query: string;
}

// --- Causal Event Tracing ---

export interface CausalEvent extends OfsEvent {
  caused_by: string[]; // parent event ids
  intent_ref: string; // snapshot of Intent.goal when emitted
  evidence: string[]; // supporting object ids
  decision_rationale: string; // why this action was taken
  confidence: number; // 0-1
}

export interface CausalChain {
  events: CausalEvent[];
  root_event_id: string;
  depth: number;
}

export interface Attribution {
  object_id: string;
  object_type: string;
  causal_chain: CausalChain;
  confidence: number;
}

// --- Shared Ontology ---

export interface TermEntry {
  term: string;
  canonical: string; // canonical form
  aliases: string[];
  description: string;
  source_agent?: string;
}

export interface TermProposal {
  term: string;
  proposed_canonical: string;
  aliases: string[];
  description: string;
  proposer_agent: string;
  proposed_at: string;
  status: "pending" | "accepted" | "rejected";
}

// --- Context Manager Interface ---

export interface OfsContextManager {
  // L1 Intent
  getIntent(): Intent;
  setIntent(goal: string, constraints?: string[], focus_types?: string[]): void;

  // L2 Working Memory
  getWorkingMemory(): OfsObject[];
  addToWorkingMemory(obj: OfsObject): void;
  removeFromWorkingMemory(id: string): void;
  touchObject(id: string): void; // bump access_count

  // L3 Episodic Store
  getStubs(): SummaryStub[];
  recall(query: string, topK?: number): Promise<RecallResult>;

  // Auto-compaction
  compact(): CompactionResult;
  getStats(): ContextStats;

  // Serialization
  toPromptHeader(): string; // ≤512 tokens for LLM window
  serialize(): ContextSnapshot;
  restore(snapshot: ContextSnapshot): void;
}

export interface ContextStats {
  l1_tokens: number;
  l2_object_count: number;
  l2_total_size: number;
  l3_stub_count: number;
  last_compaction: string | null;
}

export interface ContextSnapshot {
  intent: Intent;
  working_memory: OfsObject[];
  stubs: SummaryStub[];
  stats: ContextStats;
  saved_at: string;
}
