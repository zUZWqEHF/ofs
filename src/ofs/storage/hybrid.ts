/**
 * OFS Hybrid Storage — Local + TOS with KV Cache
 *
 * Write: local first, async sync to TOS with retry
 * Read: KV cache → local → TOS (backfill on miss)
 * Includes comprehensive metrics collection for monitoring
 */
import type { OfsStorage, OfsKvCache } from "../types.js";
import { OfsMetricsCollector } from "./metrics.js";

export interface HybridStorageOptions {
  cacheTtlMs?: number;
  /** Max retries for TOS writes (default: 3) */
  tosMaxRetries?: number;
  /** Enable metrics collection (default: true) */
  enableMetrics?: boolean;
  /** Callback for metrics snapshots (called periodically) */
  onMetricsSnapshot?: (snapshot: any) => void;
  /** Metrics snapshot interval in ms (default: 60000 = 1min) */
  metricsSnapshotIntervalMs?: number;
}

export class HybridStorage implements OfsStorage {
  private metrics: OfsMetricsCollector;
  private metricsInterval?: NodeJS.Timeout;
  private tosMaxRetries: number;

  constructor(
    private local: OfsStorage,
    private remote: OfsStorage | null,
    private cache: OfsKvCache,
    private opts?: HybridStorageOptions,
  ) {
    this.metrics = new OfsMetricsCollector();
    this.tosMaxRetries = opts?.tosMaxRetries ?? 3;

    // Start periodic metrics snapshot
    if (opts?.enableMetrics !== false && opts?.onMetricsSnapshot) {
      const interval = opts.metricsSnapshotIntervalMs ?? 60_000;
      this.metricsInterval = setInterval(() => {
        opts.onMetricsSnapshot!(this.metrics.getSnapshot());
      }, interval);
    }
  }

  async get(key: string): Promise<string | null> {
    // 1. Check KV cache
    const cached = await this.cache.get(`ofs:${key}`);
    if (cached !== null) {
      this.metrics.recordRead("cache", 0);
      return cached;
    }

    // 2. Check local
    const localStart = Date.now();
    const localVal = await this.local.get(key);
    const localLatency = Date.now() - localStart;

    if (localVal !== null) {
      this.metrics.recordRead("local", localLatency);
      await this.cache.set(`ofs:${key}`, localVal, this.opts?.cacheTtlMs ?? 300_000);
      return localVal;
    }

    // 3. Check remote (TOS) — network errors are non-fatal
    if (this.remote) {
      try {
        const tosStart = Date.now();
        const remoteVal = await this.remote.get(key);
        const tosLatency = Date.now() - tosStart;

        if (remoteVal !== null) {
          this.metrics.recordRead("tos", tosLatency);
          // Backfill local + cache
          await this.local.put(key, remoteVal);
          await this.cache.set(`ofs:${key}`, remoteVal, this.opts?.cacheTtlMs ?? 300_000);
          return remoteVal;
        }
      } catch {
        this.metrics.recordReadFailure();
        // TOS unreachable — continue with local-only
      }
    }

    return null;
  }

  private pendingRemoteWrites: Promise<void>[] = [];

  async put(key: string, value: string): Promise<void> {
    this.metrics.recordWrite(true);

    // Write local + cache synchronously
    const localStart = Date.now();
    try {
      await this.local.put(key, value);
      const localLatency = Date.now() - localStart;
      this.metrics.recordLocalWriteSuccess(localLatency);
      await this.cache.set(`ofs:${key}`, value, this.opts?.cacheTtlMs ?? 300_000);
    } catch (err) {
      this.metrics.recordLocalWriteFailure();
      throw err;
    }

    // Async sync to TOS with retry logic
    if (this.remote) {
      const p = this.writeTosWithRetry(key, value);
      this.pendingRemoteWrites.push(p);
    }
  }

  /**
   * Write to TOS with exponential backoff retry
   */
  private async writeTosWithRetry(key: string, value: string): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.tosMaxRetries; attempt++) {
      if (attempt > 0) {
        this.metrics.recordTosWriteRetry();
        // Exponential backoff: 100ms, 200ms, 400ms
        const backoff = 100 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }

      try {
        const tosStart = Date.now();
        await this.remote!.put(key, value);
        const tosLatency = Date.now() - tosStart;
        this.metrics.recordTosWriteSuccess(tosLatency);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.metrics.recordTosWriteFailure();
      }
    }

    console.error(
      `[OFS] TOS write failed for ${key} after ${this.tosMaxRetries} attempts:`,
      lastError?.message ?? "unknown error",
    );
  }

  /**
   * Wait for all pending TOS writes to complete.
   * Call before process exit to ensure data reaches TOS.
   */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pendingRemoteWrites);
    this.pendingRemoteWrites = [];
  }

  async delete(key: string): Promise<void> {
    await this.local.delete(key);
    await this.cache.del(`ofs:${key}`);
    if (this.remote) {
      this.remote.delete(key).catch(() => {});
    }
  }

  async list(prefix: string): Promise<string[]> {
    // Prefer local listing (fast); merge with remote if available
    const localKeys = await this.local.list(prefix);
    if (!this.remote) return localKeys;

    try {
      const remoteKeys = await this.remote.list(prefix);
      const merged = new Set<string>();
      localKeys.forEach((k) => merged.add(k));
      remoteKeys.forEach((k) => merged.add(k));
      const result: string[] = [];
      merged.forEach((k) => result.push(k));
      return result.sort();
    } catch {
      return localKeys;
    }
  }

  async exists(key: string): Promise<boolean> {
    const cached = await this.cache.get(`ofs:${key}`);
    if (cached !== null) return true;

    if (await this.local.exists(key)) return true;
    if (this.remote) {
      try {
        return await this.remote.exists(key);
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics() {
    return this.metrics.getSnapshot();
  }

  /**
   * Get raw metrics data
   */
  getRawMetrics() {
    return this.metrics.getRawMetrics();
  }

  /**
   * Reset metrics counters
   */
  resetMetrics(): void {
    this.metrics.reset();
  }

  /**
   * Export metrics in Prometheus format
   */
  exportMetrics(prefix?: string): string {
    return this.metrics.toPrometheusFormat(prefix);
  }

  /**
   * Cleanup resources (stop metrics interval timer)
   */
  destroy(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = undefined;
    }
  }
}
