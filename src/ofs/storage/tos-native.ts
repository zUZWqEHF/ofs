/**
 * Lightweight ByteDance TOS Native Client
 *
 * Direct HTTP client for internal TOS API (toutiao.tos.tosapi).
 * No Consul dependency — uses hardcoded SD-resolved addresses.
 * Uses sign_plain authentication (x-tos-access header).
 *
 * Wire protocol: HTTP to /{bucket}/{objectKey} on port 8789.
 */
import * as http from "node:http";
import type { OfsStorage } from "../types.js";

// SD-resolved TOS API addresses (toutiao.tos.tosapi.service.mycisb)
const TOS_ENDPOINTS = [
  "10.122.102.180",
  "10.122.102.182",
  "10.122.102.183",
  "10.122.102.184",
  "10.122.102.185",
  "10.122.102.186",
  "10.122.102.187",
  "10.122.102.188",
  "10.122.102.209",
  "10.122.102.210",
  "10.122.102.211",
  "10.122.102.212",
  "10.122.102.213",
  "10.122.102.214",
  "10.122.102.216",
  "10.122.102.217",
  "10.122.102.218",
  "10.122.102.219",
  "10.122.102.220",
];
const TOS_PORT = 8789;

export interface TosNativeConfig {
  accessKey: string;
  secretKey: string;
  bucket: string;
  prefix?: string;
  /** Override SD-resolved endpoints */
  endpoints?: string[];
  port?: number;
  /** Request timeout in ms (default: 10000) */
  timeout?: number;
  /** Unused — kept for interface compat with env loading */
  signatureName?: string;
  /** Max retry attempts (default: 3) */
  maxRetries?: number;
  /** Retry backoff multiplier in ms (default: 100) */
  retryBackoffMs?: number;
}

/**
 * Round-robin endpoint selector
 */
class EndpointRotator {
  private currentIndex = 0;
  private readonly endpoints: string[];

  constructor(endpoints: string[]) {
    this.endpoints = [...endpoints];
  }

  next(): string {
    const endpoint = this.endpoints[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
    return endpoint;
  }

  getAll(): string[] {
    return [...this.endpoints];
  }

  size(): number {
    return this.endpoints.length;
  }
}

function tosRequest(
  config: TosNativeConfig,
  method: string,
  objectPath: string,
  body?: Buffer | string,
  query?: string,
  targetHost?: string,
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const port = config.port ?? TOS_PORT;
    const host = targetHost ?? (config.endpoints ?? TOS_ENDPOINTS)[0];

    // Direct mode: path is /{bucket}/{objectKey}
    const pathWithBucket = objectPath ? `/${config.bucket}/${objectPath}` : `/${config.bucket}`;
    let fullPath = pathWithBucket;
    if (query) fullPath += `?${query}`;

    const headers: Record<string, string> = {
      "x-tos-access": config.accessKey,
    };

    if (body) {
      const buf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
      headers["content-length"] = String(buf.length);
      headers["content-type"] = "application/octet-stream";
    }

    const timeout = config.timeout ?? 10000;

    const req = http.request({ host, port, path: fullPath, method, headers, timeout }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`TOS request timeout (${timeout}ms)`));
    });

    if (body) {
      req.write(typeof body === "string" ? Buffer.from(body, "utf-8") : body);
    }
    req.end();
  });
}

/**
 * OFS Storage backend using native TOS protocol.
 * Direct HTTP to internal TOS API with sign_plain auth.
 * Supports round-robin endpoint rotation and automatic retries.
 */
export class TosNativeStorage implements OfsStorage {
  private config: TosNativeConfig;
  private prefix: string;
  private rotator: EndpointRotator;
  private maxRetries: number;
  private retryBackoffMs: number;

  constructor(config: TosNativeConfig) {
    this.config = config;
    this.prefix = config.prefix ?? "ofs/";
    this.rotator = new EndpointRotator(config.endpoints ?? TOS_ENDPOINTS);
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBackoffMs = config.retryBackoffMs ?? 100;
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  /**
   * Execute a TOS request with automatic retry and endpoint rotation.
   */
  private async executeWithRetry<T>(
    operation: string,
    fn: (host: string) => Promise<T>,
  ): Promise<T> {
    let lastError: Error | undefined;
    const maxAttempts = this.maxRetries + 1; // initial attempt + retries

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const endpoint = this.rotator.next();
      try {
        return await fn(endpoint);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxAttempts - 1) {
          // Exponential backoff: 100ms, 200ms, 400ms, etc.
          const backoff = this.retryBackoffMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    }

    throw new Error(
      `${operation} failed after ${maxAttempts} attempts: ${lastError?.message ?? "unknown error"}`,
    );
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.executeWithRetry("GET", async (host) => {
        const res = await tosRequest(
          this.config,
          "GET",
          this.fullKey(key),
          undefined,
          undefined,
          host,
        );
        if (res.statusCode === 404 || res.statusCode === 204) return null;
        if (res.statusCode >= 400) {
          const msg = res.body.toString("utf-8").slice(0, 200);
          if (msg.includes("not found") || msg.includes("4008")) return null;
          throw new Error(`TOS GET ${key}: ${res.statusCode} ${msg}`);
        }
        return res.body.toString("utf-8");
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("not found")) return null;
      throw err;
    }
  }

  async put(key: string, value: string): Promise<void> {
    await this.executeWithRetry("PUT", async (host) => {
      const res = await tosRequest(this.config, "PUT", this.fullKey(key), value, undefined, host);
      if (res.statusCode >= 400) {
        const msg = res.body.toString("utf-8").slice(0, 200);
        throw new Error(`TOS PUT ${key}: ${res.statusCode} ${msg}`);
      }
    });
  }

  async delete(key: string): Promise<void> {
    try {
      await this.executeWithRetry("DELETE", async (host) => {
        await tosRequest(this.config, "DELETE", this.fullKey(key), undefined, undefined, host);
      });
    } catch {
      // ignore
    }
  }

  async list(prefix: string): Promise<string[]> {
    const fullPrefix = this.fullKey(prefix);
    const keys: string[] = [];

    // TOS uses "/" as default delimiter. We need to recursively list
    // by first getting common prefixes, then listing objects in each.
    await this.listRecursive(fullPrefix, keys);
    return keys;
  }

  private async listRecursive(prefix: string, keys: string[]): Promise<void> {
    let startAfter = "";
    let truncated = true;

    while (truncated) {
      const query = `prefix=${encodeURIComponent(prefix)}&max-keys=1000${startAfter ? `&start-after=${encodeURIComponent(startAfter)}` : ""}`;
      const res = await this.executeWithRetry("LIST", async (host) => {
        return tosRequest(this.config, "GET", "", undefined, query, host);
      });

      if (res.statusCode >= 400) {
        const msg = res.body.toString("utf-8").slice(0, 200);
        throw new Error(`TOS LIST ${prefix}: ${res.statusCode} ${msg}`);
      }

      const body = res.body.toString("utf-8");

      try {
        const data = JSON.parse(body);
        const payload = data.payload ?? data;

        // Collect objects at this level
        const objects = payload.objects ?? [];
        for (const obj of objects) {
          const k = obj.key ?? obj.Key;
          if (k) keys.push(k.slice(this.prefix.length));
        }

        // Recurse into common prefixes (subdirectories)
        const commonPrefixes = payload.commonPrefix ?? [];
        for (const cp of commonPrefixes) {
          await this.listRecursive(cp, keys);
        }

        truncated = payload.isTruncated ?? false;
        if (truncated) {
          startAfter = payload.startAfter ?? "";
          if (!startAfter && objects.length > 0) {
            startAfter = objects[objects.length - 1].key ?? "";
          }
        }
      } catch {
        truncated = false;
      }
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return await this.executeWithRetry("HEAD", async (host) => {
        const res = await tosRequest(
          this.config,
          "HEAD",
          this.fullKey(key),
          undefined,
          undefined,
          host,
        );
        return res.statusCode >= 200 && res.statusCode < 300;
      });
    } catch {
      return false;
    }
  }

  /**
   * Get current endpoint rotation stats
   */
  getEndpointStats(): { total: number; endpoints: string[] } {
    return {
      total: this.rotator.size(),
      endpoints: this.rotator.getAll(),
    };
  }
}
