/**
 * OFS TOS (ByteCloud S3-compatible) Storage Backend
 *
 * Uses @aws-sdk/client-s3 with custom endpoint for ByteCloud TOS.
 * Falls back to local storage if TOS is unavailable.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import type { OfsStorage } from "../types.js";

export interface TosConfig {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
  region?: string;
  prefix?: string; // key prefix for all objects (e.g., "ofs/")
}

export class TosStorage implements OfsStorage {
  private client: S3Client;
  private bucket: string;
  private prefix: string;

  constructor(config: TosConfig) {
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? "ofs/";

    this.client = new S3Client({
      region: config.region ?? "cn-beijing",
      endpoint: config.endpoint.startsWith("http") ? config.endpoint : `https://${config.endpoint}`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<string | null> {
    try {
      const resp = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      return (await resp.Body?.transformToString("utf-8")) ?? null;
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async put(key: string, value: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.fullKey(key),
        Body: value,
        ContentType: "application/json",
      }),
    );
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
    } catch {
      // ignore
    }
  }

  async list(prefix: string): Promise<string[]> {
    const fullPrefix = this.fullKey(prefix);
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
      );

      for (const obj of resp.Contents ?? []) {
        if (obj.Key) {
          // Strip the global prefix to return relative keys
          keys.push(obj.Key.slice(this.prefix.length));
        }
      }

      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);

    return keys;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }),
      );
      return true;
    } catch {
      return false;
    }
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const code = (err as Record<string, unknown>).name ?? (err as Record<string, unknown>).Code;
    return code === "NoSuchKey" || code === "NotFound" || code === "404";
  }
  return false;
}
