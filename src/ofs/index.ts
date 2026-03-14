/**
 * OFS — Ontology File System
 *
 * Entry point. Creates an OfsEngine with the appropriate storage backend.
 */
import * as path from "node:path";
import { OfsEngine } from "./engine.js";
import { SchemaRegistry } from "./schema-registry.js";
import { HybridStorage } from "./storage/hybrid.js";
import { FileKvCache } from "./storage/kv.js";
import { LocalStorage } from "./storage/local.js";
import { TosNativeStorage, type TosNativeConfig } from "./storage/tos-native.js";
import type { TosConfig } from "./storage/tos.js";

export { OfsEngine } from "./engine.js";
export type { OfsEngineV2Options } from "./engine.js";
export { SchemaRegistry } from "./schema-registry.js";
export { LocalStorage } from "./storage/local.js";
export type { TosConfig } from "./storage/tos.js";
export { TosNativeStorage } from "./storage/tos-native.js";
export type { TosNativeConfig } from "./storage/tos-native.js";
export { FileKvCache } from "./storage/kv.js";
export { HybridStorage } from "./storage/hybrid.js";
export { EventLog } from "./event-log.js";
export { ContextManager } from "./context-manager.js";
export { CausalLog } from "./causal-log.js";
export { SharedOntology } from "./shared-ontology.js";
export type * from "./types.js";

export interface OfsCreateOptions {
  /** Project root directory */
  projectDir: string;
  /** Agent ID for this OFS instance */
  agentId: string;
  /** TOS config (optional — if absent, local-only mode) */
  tos?: TosConfig;
  /** Native TOS config (preferred over S3-compatible tos) */
  tosNative?: TosNativeConfig;
  /** Path to ontology schema definitions (default: <projectDir>/ontology) */
  ontologyDir?: string;
  /** Path to context data store (default: <projectDir>/context/ofs) */
  dataDir?: string;
  /** KV cache directory (default: <projectDir>/.ofs-cache) */
  cacheDir?: string;
  /** v2: enable three-layer context manager */
  enableContext?: boolean;
  /** v2: enable causal event tracing */
  enableCausalLog?: boolean;
  /** v2: shared ontology directory path */
  sharedOntologyPath?: string;
}

export async function createOfs(opts: OfsCreateOptions): Promise<OfsEngine> {
  const ontologyDir = opts.ontologyDir ?? path.join(opts.projectDir, "ontology");
  const dataDir = opts.dataDir ?? path.join(opts.projectDir, "context", "ofs");
  const cacheDir = opts.cacheDir ?? path.join(opts.projectDir, ".ofs-cache");

  // Load schema
  const schema = new SchemaRegistry(ontologyDir);
  await schema.load();

  // Setup storage
  const local = new LocalStorage(dataDir);
  const cache = new FileKvCache(cacheDir);

  let storage;
  if (opts.tosNative) {
    const remote = new TosNativeStorage(opts.tosNative);
    storage = new HybridStorage(local, remote, cache);
  } else if (opts.tos) {
    const { TosStorage } = await import("./storage/tos.js");
    const remote = new TosStorage(opts.tos);
    storage = new HybridStorage(local, remote, cache);
  } else {
    storage = new HybridStorage(local, null, cache);
  }

  const engine = new OfsEngine(storage, cache, schema, opts.agentId, dataDir, {
    enableContext: opts.enableContext,
    enableCausalLog: opts.enableCausalLog,
    sharedOntologyPath: opts.sharedOntologyPath,
  });

  // Initialize v2 modules if enabled
  if (opts.enableContext || opts.enableCausalLog) {
    await engine.initV2();
  }

  return engine;
}

/**
 * Create OFS from environment variables.
 *
 * Native TOS (preferred): TOS_ACCESS_KEY, TOS_SECRET_KEY, TOS_BUCKET
 * S3-compat fallback: OFS_TOS_AK, OFS_TOS_SK, OFS_TOS_ENDPOINT, OFS_TOS_BUCKET
 */
export async function createOfsFromEnv(
  projectDir: string,
  agentId: string,
  v2?: { enableContext?: boolean; enableCausalLog?: boolean; sharedOntologyPath?: string },
): Promise<OfsEngine> {
  const enableContext = v2?.enableContext ?? process.env.OFS_V2_CONTEXT === "1";
  const enableCausalLog = v2?.enableCausalLog ?? process.env.OFS_V2_CAUSAL === "1";
  const sharedOntologyPath = v2?.sharedOntologyPath ?? process.env.OFS_SHARED_ONTOLOGY_PATH;
  // Prefer native TOS (direct HTTP to internal API)
  const nativeAk = process.env.TOS_ACCESS_KEY ?? process.env.OFS_TOS_AK;
  const nativeSk = process.env.TOS_SECRET_KEY ?? process.env.OFS_TOS_SK;
  const nativeBucket = process.env.TOS_BUCKET ?? process.env.OFS_TOS_BUCKET;

  if (nativeAk && nativeSk && nativeBucket) {
    const tosNative: TosNativeConfig = {
      accessKey: nativeAk,
      secretKey: nativeSk,
      bucket: nativeBucket,
      prefix: process.env.OFS_TOS_PREFIX ?? `ofs/${agentId}/`,
      signatureName: process.env.TOS_SIGNATURE_NAME ?? "",
    };
    return createOfs({
      projectDir,
      agentId,
      tosNative,
      enableContext,
      enableCausalLog,
      sharedOntologyPath,
    });
  }

  // S3-compatible fallback
  const tos: TosConfig | undefined =
    process.env.OFS_TOS_AK && process.env.OFS_TOS_SK && process.env.OFS_TOS_ENDPOINT
      ? {
          accessKeyId: process.env.OFS_TOS_AK,
          secretAccessKey: process.env.OFS_TOS_SK,
          endpoint: process.env.OFS_TOS_ENDPOINT,
          bucket: process.env.OFS_TOS_BUCKET ?? "ofs",
          prefix: process.env.OFS_TOS_PREFIX ?? `ofs/${agentId}/`,
        }
      : undefined;

  return createOfs({
    projectDir,
    agentId,
    tos,
    enableContext,
    enableCausalLog,
    sharedOntologyPath,
  });
}
