/**
 * OFS Graph Query — traverse ontology links across objects
 *
 * Supports:
 * - BFS/DFS traversal from a starting object
 * - Path queries (A -[link]-> B -[link]-> C)
 * - Neighborhood queries (all objects within N hops)
 */
import type { OfsEngine } from "./engine.js";
import type { OfsObject, OfsLink } from "./types.js";

export interface GraphNode {
  object: OfsObject;
  depth: number;
  path: OfsLink[];
}

export class OfsGraph {
  constructor(private ofs: OfsEngine) {}

  /**
   * BFS traversal from a starting object, following links up to maxDepth.
   */
  async traverse(
    startType: string,
    startId: string,
    opts?: {
      maxDepth?: number;
      linkTypes?: string[];
      direction?: "outgoing" | "incoming" | "both";
    },
  ): Promise<GraphNode[]> {
    const maxDepth = opts?.maxDepth ?? 3;
    const direction = opts?.direction ?? "both";
    const visited = new Set<string>();
    const results: GraphNode[] = [];
    const queue: GraphNode[] = [];

    const startObj = await this.ofs.getObject(startType, startId);
    if (!startObj) return [];

    const startNode: GraphNode = { object: startObj, depth: 0, path: [] };
    queue.push(startNode);
    visited.add(`${startType}:${startId}`);

    while (queue.length > 0) {
      const node = queue.shift()!;
      results.push(node);

      if (node.depth >= maxDepth) continue;

      // Get outgoing links
      if (direction === "outgoing" || direction === "both") {
        const outLinks = await this.ofs.getLinks({
          sourceType: node.object._type,
          sourceId: node.object._id,
          linkType: opts?.linkTypes?.[0],
        });

        for (const link of outLinks) {
          if (opts?.linkTypes && !opts.linkTypes.includes(link._link)) continue;
          const key = `${link._target_type}:${link._target_id}`;
          if (visited.has(key)) continue;

          const targetObj = await this.ofs.getObject(link._target_type, link._target_id);
          if (!targetObj) continue;

          visited.add(key);
          queue.push({
            object: targetObj,
            depth: node.depth + 1,
            path: [...node.path, link],
          });
        }
      }

      // Get incoming links
      if (direction === "incoming" || direction === "both") {
        const inLinks = await this.ofs.getLinks({
          targetType: node.object._type,
          targetId: node.object._id,
          linkType: opts?.linkTypes?.[0],
        });

        for (const link of inLinks) {
          if (opts?.linkTypes && !opts.linkTypes.includes(link._link)) continue;
          const key = `${link._source_type}:${link._source_id}`;
          if (visited.has(key)) continue;

          const sourceObj = await this.ofs.getObject(link._source_type, link._source_id);
          if (!sourceObj) continue;

          visited.add(key);
          queue.push({
            object: sourceObj,
            depth: node.depth + 1,
            path: [...node.path, link],
          });
        }
      }
    }

    return results;
  }

  /**
   * Find shortest path between two objects.
   */
  async findPath(
    fromType: string,
    fromId: string,
    toType: string,
    toId: string,
    maxDepth?: number,
  ): Promise<GraphNode | null> {
    const nodes = await this.traverse(fromType, fromId, { maxDepth: maxDepth ?? 5 });
    return nodes.find((n) => n.object._type === toType && n.object._id === toId) ?? null;
  }

  /**
   * Get all objects connected to a given object (1-hop neighborhood).
   */
  async neighbors(typeName: string, id: string, linkType?: string): Promise<OfsObject[]> {
    const nodes = await this.traverse(typeName, id, {
      maxDepth: 1,
      linkTypes: linkType ? [linkType] : undefined,
    });
    return nodes.filter((n) => n.depth === 1).map((n) => n.object);
  }

  /**
   * Get the impact radius of an object (all objects affected by changes to it).
   * Follows incoming depends-on links (reverse dependency).
   */
  async impactRadius(typeName: string, id: string, maxDepth?: number): Promise<GraphNode[]> {
    return this.traverse(typeName, id, {
      maxDepth: maxDepth ?? 3,
      linkTypes: ["depends-on"],
      direction: "incoming",
    });
  }
}
