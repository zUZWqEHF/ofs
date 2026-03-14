/**
 * OFS Local File Storage — Ground truth on local filesystem
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { OfsStorage } from "../types.js";

export class LocalStorage implements OfsStorage {
  constructor(private rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  private resolve(key: string): string {
    return path.join(this.rootDir, key);
  }

  async get(key: string): Promise<string | null> {
    const p = this.resolve(key);
    try {
      return await fs.promises.readFile(p, "utf-8");
    } catch {
      return null;
    }
  }

  async put(key: string, value: string): Promise<void> {
    const p = this.resolve(key);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, value);
  }

  async delete(key: string): Promise<void> {
    const p = this.resolve(key);
    try {
      await fs.promises.unlink(p);
    } catch {
      // ignore missing
    }
  }

  async list(prefix: string): Promise<string[]> {
    const dir = this.resolve(prefix);
    if (!fs.existsSync(dir)) return [];

    const stat = await fs.promises.stat(dir);
    if (!stat.isDirectory()) return [prefix];

    const result: string[] = [];
    const walk = async (current: string, rel: string) => {
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(path.join(current, entry.name), entryRel);
        } else {
          result.push(prefix ? `${prefix}/${entryRel}` : entryRel);
        }
      }
    };
    await walk(dir, "");
    return result;
  }

  async exists(key: string): Promise<boolean> {
    return fs.existsSync(this.resolve(key));
  }
}
