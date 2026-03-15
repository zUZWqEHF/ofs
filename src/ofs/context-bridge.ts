/**
 * OFS Context Bridge — integrates OFS with existing ContextManager
 *
 * Maps OFS objects/links/events to ContextManager's layer model:
 *   global layer → ontology schema (types, links, actions)
 *   bot layer    → agent-specific objects and state
 *   task layer   → task evidence/reports written via OFS
 */
import * as path from "node:path";
import type { ContextFile, LoadedContext } from "../context/types.js";
import type { OfsEngine } from "./engine.js";

export class OfsContextBridge {
  constructor(
    private ofs: OfsEngine,
    private projectDir: string,
  ) {}

  /**
   * Load OFS context as ContextFiles for an agent.
   * Returns the agent's objects, links, and recent events as context files.
   */
  async loadAgentContext(agentId: string): Promise<LoadedContext> {
    const files: ContextFile[] = [];

    // Load manifest
    const manifest = await this.ofs.getManifest();
    if (manifest) {
      files.push({
        path: "ofs/manifest.json",
        content: JSON.stringify(manifest, null, 2),
        layer: "bot",
        tokens: estimateTokens(JSON.stringify(manifest)),
      });
    }

    // Load agent identity
    const agent = await this.ofs.getAgent(agentId);
    if (agent) {
      files.push({
        path: `ofs/agents/${agentId}.json`,
        content: JSON.stringify(agent, null, 2),
        layer: "bot",
        tokens: estimateTokens(JSON.stringify(agent)),
      });
    }

    // Load recent events as context (last 50)
    const events = await this.ofs.tailEvents(50);
    if (events.length > 0) {
      const eventsContent = events.map((e) => JSON.stringify(e)).join("\n");
      files.push({
        path: "ofs/recent-events.jsonl",
        content: eventsContent,
        layer: "bot",
        tokens: estimateTokens(eventsContent),
      });
    }

    // Load share links
    const shares = await this.ofs.listShareLinks();
    if (shares.length > 0) {
      files.push({
        path: "ofs/shares.json",
        content: JSON.stringify(shares, null, 2),
        layer: "bot",
        tokens: estimateTokens(JSON.stringify(shares)),
      });
    }

    return {
      files,
      totalTokens: files.reduce((s, f) => s + f.tokens, 0),
    };
  }

  /**
   * Export an agent's full context as a shareable bundle.
   * "Share agent = share context link" — always latest version.
   */
  async exportShareBundle(shareId: string): Promise<LoadedContext> {
    const objects = await this.ofs.readSharedContext(shareId);
    const files: ContextFile[] = objects.map((obj) => ({
      path: `ofs/objects/${obj._type}/${obj._id}.json`,
      content: JSON.stringify(obj, null, 2),
      layer: "bot",
      tokens: estimateTokens(JSON.stringify(obj)),
    }));

    return {
      files,
      totalTokens: files.reduce((s, f) => s + f.tokens, 0),
    };
  }
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for JSON
  return Math.ceil(text.length / 4);
}
