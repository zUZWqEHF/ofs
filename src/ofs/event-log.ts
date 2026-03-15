import * as crypto from "node:crypto";
/**
 * OFS Event Log — append-only event sourcing
 *
 * All mutations are recorded as events. Supports replay and tail.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { OfsEvent, OfsStorage } from "./types.js";

export class EventLog {
  private logDir: string;

  constructor(
    private storage: OfsStorage,
    basePath: string,
  ) {
    this.logDir = path.join(basePath, "events");
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  async append(event: Omit<OfsEvent, "_event_id" | "_timestamp">): Promise<OfsEvent> {
    const full: OfsEvent = {
      _event_id: crypto.randomUUID(),
      _timestamp: new Date().toISOString(),
      _type: event._type,
      _object_type: event._object_type,
      _object_id: event._object_id,
      _agent_id: event._agent_id,
      _data: event._data,
      // v3 temporal fields — only include if present
      ...(event._before !== undefined && { _before: event._before }),
      ...(event._after !== undefined && { _after: event._after }),
      ...(event._reason && { _reason: event._reason }),
      ...(event._object_version !== undefined && { _object_version: event._object_version }),
    };

    // Append to local JSONL (primary event store)
    const day = full._timestamp.slice(0, 10);
    const localFile = path.join(this.logDir, `${day}.jsonl`);
    await fs.promises.appendFile(localFile, JSON.stringify(full) + "\n");

    // Async sync to remote storage (backup)
    const logFile = `events/${day}.jsonl`;
    this.storage.put(logFile, await fs.promises.readFile(localFile, "utf-8")).catch(() => {});

    return full;
  }

  async tail(n: number): Promise<OfsEvent[]> {
    // Read from most recent local log files
    const files = fs.existsSync(this.logDir)
      ? (await fs.promises.readdir(this.logDir))
          .filter((f) => f.endsWith(".jsonl"))
          .sort()
          .reverse()
      : [];

    const events: OfsEvent[] = [];
    for (const file of files) {
      if (events.length >= n) break;
      const content = await fs.promises.readFile(path.join(this.logDir, file), "utf-8");
      const lines = content.trim().split("\n").filter(Boolean).reverse();
      for (const line of lines) {
        if (events.length >= n) break;
        try {
          events.push(JSON.parse(line) as OfsEvent);
        } catch {
          // skip malformed
        }
      }
    }

    return events.reverse();
  }

  async query(opts: {
    objectType?: string;
    objectId?: string;
    agentId?: string;
    eventType?: OfsEvent["_type"];
    since?: string;
    limit?: number;
  }): Promise<OfsEvent[]> {
    const files = fs.existsSync(this.logDir)
      ? (await fs.promises.readdir(this.logDir)).filter((f) => f.endsWith(".jsonl")).sort()
      : [];

    const results: OfsEvent[] = [];
    const limit = opts.limit ?? 100;

    for (const file of files) {
      if (opts.since && file < `${opts.since.slice(0, 10)}.jsonl`) continue;
      if (results.length >= limit) break;

      const content = await fs.promises.readFile(path.join(this.logDir, file), "utf-8");
      for (const line of content.trim().split("\n").filter(Boolean)) {
        if (results.length >= limit) break;
        try {
          const event = JSON.parse(line) as OfsEvent;
          if (opts.objectType && event._object_type !== opts.objectType) continue;
          if (opts.objectId && event._object_id !== opts.objectId) continue;
          if (opts.agentId && event._agent_id !== opts.agentId) continue;
          if (opts.eventType && event._type !== opts.eventType) continue;
          if (opts.since && event._timestamp < opts.since) continue;
          results.push(event);
        } catch {
          // skip
        }
      }
    }

    return results;
  }
}
