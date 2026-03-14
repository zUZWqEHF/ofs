/**
 * OFS Local KV Cache — file-backed key-value cache with TTL
 *
 * Self-hosted, no external dependencies (no Redis needed).
 * Uses a simple JSON file store with in-memory LRU and periodic flush.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { OfsKvCache } from "../types.js";

interface CacheEntry {
  value: string;
  expiresAt: number | null; // epoch ms, null = no expiry
}

/**
 * Simple in-memory KV cache (no persistence)
 * Useful for testing and ephemeral workloads
 */
export class InMemoryKvCache implements OfsKvCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxSize: number;

  constructor(opts?: { maxSize?: number }) {
    this.maxSize = opts?.maxSize ?? 50_000;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const entries = Array.from(this.cache.entries());
      if (entries.length > 0) {
        this.cache.delete(entries[0][0]);
      }
    }

    this.cache.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
    });
  }

  async del(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async keys(pattern: string): Promise<string[]> {
    const now = Date.now();
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    const result: string[] = [];
    const entries = Array.from(this.cache.entries());
    for (const [key, entry] of entries) {
      if (entry.expiresAt !== null && now > entry.expiresAt) continue;
      if (regex.test(key)) result.push(key);
    }
    return result;
  }

  async flush(): Promise<void> {
    // No-op for in-memory cache
  }

  async close(): Promise<void> {
    this.cache.clear();
  }
}

export class FileKvCache implements OfsKvCache {
  private cache: Map<string, CacheEntry> = new Map();
  private dbPath: string;
  private dirty = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private maxSize: number;

  constructor(dbDir: string, opts?: { maxSize?: number; flushIntervalMs?: number }) {
    fs.mkdirSync(dbDir, { recursive: true });
    this.dbPath = path.join(dbDir, "ofs-kv.json");
    this.maxSize = opts?.maxSize ?? 50_000;

    this.loadFromDisk();

    // Periodic flush every 30s
    const interval = opts?.flushIntervalMs ?? 30_000;
    this.flushTimer = setInterval(() => void this.flushToDisk(), interval);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  async get(key: string): Promise<string | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.dirty = true;
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
    });
    this.dirty = true;
  }

  async del(key: string): Promise<void> {
    this.cache.delete(key);
    this.dirty = true;
  }

  async keys(pattern: string): Promise<string[]> {
    const now = Date.now();
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    const result: string[] = [];
    const entries = Array.from(this.cache.entries());
    for (const [key, entry] of entries) {
      if (entry.expiresAt !== null && now > entry.expiresAt) continue;
      if (regex.test(key)) result.push(key);
    }
    return result;
  }

  async flush(): Promise<void> {
    await this.flushToDisk();
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flushToDisk();
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.dbPath)) return;
      const raw = fs.readFileSync(this.dbPath, "utf-8");
      const data = JSON.parse(raw) as Record<string, CacheEntry>;
      const now = Date.now();
      for (const [key, entry] of Object.entries(data)) {
        if (entry.expiresAt !== null && now > entry.expiresAt) continue;
        this.cache.set(key, entry);
      }
    } catch {
      // corrupt or missing, start fresh
    }
  }

  private async flushToDisk(): Promise<void> {
    if (!this.dirty) return;
    const now = Date.now();
    const data: Record<string, CacheEntry> = {};
    const entries = Array.from(this.cache.entries());
    for (const [key, entry] of entries) {
      if (entry.expiresAt !== null && now > entry.expiresAt) continue;
      data[key] = entry;
    }
    await fs.promises.writeFile(this.dbPath, JSON.stringify(data));
    this.dirty = false;
  }
}
