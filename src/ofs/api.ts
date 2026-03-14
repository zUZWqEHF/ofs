/**
 * OFS Semantic API — HTTP REST server for OFS operations
 *
 * Provides a REST interface for agents to interact with the Ontology File System.
 * Agents can query objects, create links, execute actions, and share context.
 *
 * Endpoints:
 *   GET  /ofs/objects/:type              List objects by type
 *   GET  /ofs/objects/:type/:id          Get object by ID
 *   POST /ofs/objects/:type              Create object
 *   PUT  /ofs/objects/:type/:id          Update object
 *   DELETE /ofs/objects/:type/:id        Delete object
 *   GET  /ofs/links                      List links (query params: linkType, sourceType, sourceId, ...)
 *   POST /ofs/links                      Create link
 *   DELETE /ofs/links/:linkType/:srcType/:srcId/:tgtType/:tgtId  Delete link
 *   POST /ofs/actions/:name             Execute action
 *   GET  /ofs/events                     Query events
 *   GET  /ofs/events/tail/:n            Tail events
 *   GET  /ofs/schema                     List all schemas
 *   GET  /ofs/schema/:type              Get schema by type
 *   POST /ofs/shares                    Create share link
 *   GET  /ofs/shares                     List share links
 *   GET  /ofs/shares/:id/context        Read shared context
 *   GET  /ofs/agents                     List agents
 *   POST /ofs/agents                    Register agent
 *   GET  /ofs/manifest                  Get manifest
 *   POST /ofs/snapshot                  Create snapshot
 *   GET  /ofs/search?q=pattern&type=X   Search objects
 */
import * as http from "node:http";
import * as path from "node:path";
import type { OfsEngine } from "./engine.js";
import { createOfsFromEnv } from "./index.js";
import { SchemaRegistry } from "./schema-registry.js";

export function createOfsApiServer(ofs: OfsEngine, projectDir: string): http.Server {
  const schema = new SchemaRegistry(path.join(projectDir, "ontology"));
  schema.load();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    const parts = url.pathname
      .replace(/^\/ofs\/?/, "")
      .split("/")
      .filter(Boolean);

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Agent-ID");

    if (method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    try {
      const body = method === "POST" || method === "PUT" ? await readBody(req) : null;
      const result = await route(ofs, schema, method, parts, url.searchParams, body);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.data, null, 2));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: msg }));
    }
  });
}

interface RouteResult {
  status: number;
  data: unknown;
}

async function route(
  ofs: OfsEngine,
  schema: SchemaRegistry,
  method: string,
  parts: string[],
  params: URLSearchParams,
  body: Record<string, unknown> | null,
): Promise<RouteResult> {
  const resource = parts[0];

  // Objects
  if (resource === "objects") {
    const type = parts[1];
    const id = parts[2];

    if (method === "GET" && type && id) {
      const obj = await ofs.getObject(type, id);
      return obj ? { status: 200, data: obj } : { status: 404, data: { error: "Not found" } };
    }
    if (method === "GET" && type) {
      return { status: 200, data: await ofs.listObjects(type) };
    }
    if (method === "POST" && type && body) {
      return { status: 201, data: await ofs.createObject(type, body) };
    }
    if (method === "PUT" && type && id && body) {
      return { status: 200, data: await ofs.updateObject(type, id, body) };
    }
    if (method === "DELETE" && type && id) {
      await ofs.deleteObject(type, id);
      return { status: 200, data: { deleted: true } };
    }
    return { status: 400, data: { error: "Invalid objects request" } };
  }

  // Links
  if (resource === "links") {
    if (method === "GET") {
      return {
        status: 200,
        data: await ofs.getLinks({
          linkType: params.get("linkType") ?? undefined,
          sourceType: params.get("sourceType") ?? undefined,
          sourceId: params.get("sourceId") ?? undefined,
          targetType: params.get("targetType") ?? undefined,
          targetId: params.get("targetId") ?? undefined,
        }),
      };
    }
    if (method === "POST" && body) {
      const link = await ofs.createLink(
        body.linkType as string,
        body.sourceType as string,
        body.sourceId as string,
        body.targetType as string,
        body.targetId as string,
        body.properties as Record<string, unknown>,
      );
      return { status: 201, data: link };
    }
    if (method === "DELETE" && parts.length >= 6) {
      await ofs.deleteLink(parts[1], parts[2], parts[3], parts[4], parts[5]);
      return { status: 200, data: { deleted: true } };
    }
    return { status: 400, data: { error: "Invalid links request" } };
  }

  // Actions
  if (resource === "actions") {
    if (method === "POST" && parts[1]) {
      const args = Array.isArray(body?.args) ? (body.args as string[]) : [];
      return { status: 200, data: await ofs.executeAction(parts[1], args) };
    }
    return { status: 400, data: { error: "Invalid actions request" } };
  }

  // Events
  if (resource === "events") {
    if (parts[1] === "tail") {
      const n = parseInt(parts[2] ?? "20", 10);
      return { status: 200, data: await ofs.tailEvents(n) };
    }
    return {
      status: 200,
      data: await ofs.queryEvents({
        objectType: params.get("objectType") ?? undefined,
        objectId: params.get("objectId") ?? undefined,
        agentId: params.get("agentId") ?? undefined,
        since: params.get("since") ?? undefined,
        limit: params.has("limit") ? parseInt(params.get("limit")!, 10) : undefined,
      }),
    };
  }

  // Schema
  if (resource === "schema") {
    if (parts[1]) {
      const typeDef = schema.getObjectType(parts[1]) ?? schema.getLinkType(parts[1]);
      return typeDef
        ? { status: 200, data: typeDef }
        : { status: 404, data: { error: "Unknown type" } };
    }
    return {
      status: 200,
      data: {
        objectTypes: schema.listObjectTypes(),
        linkTypes: schema.listLinkTypes(),
        actions: schema.listActions(),
      },
    };
  }

  // Shares
  if (resource === "shares") {
    if (method === "GET" && parts[1] && parts[2] === "context") {
      return { status: 200, data: await ofs.readSharedContext(parts[1]) };
    }
    if (method === "GET" && parts[1]) {
      const link = await ofs.getShareLink(parts[1]);
      return link ? { status: 200, data: link } : { status: 404, data: { error: "Not found" } };
    }
    if (method === "GET") {
      return { status: 200, data: await ofs.listShareLinks() };
    }
    if (method === "POST" && body) {
      return {
        status: 201,
        data: await ofs.createShareLink({
          targetAgentId: body.targetAgentId as string | undefined,
          pathPrefix: body.pathPrefix as string | undefined,
          permissions: body.permissions as "read" | "read-write" | undefined,
          expiresInMs: body.expiresInMs as number | undefined,
        }),
      };
    }
    return { status: 400, data: { error: "Invalid shares request" } };
  }

  // Agents
  if (resource === "agents") {
    if (method === "GET") {
      return { status: 200, data: await ofs.listAgents() };
    }
    if (method === "POST" && body) {
      await ofs.registerAgent(body as import("./types.js").AgentIdentity);
      return { status: 201, data: { registered: true } };
    }
    return { status: 400, data: { error: "Invalid agents request" } };
  }

  // Manifest
  if (resource === "manifest") {
    return { status: 200, data: await ofs.updateManifest() };
  }

  // Snapshot
  if (resource === "snapshot") {
    if (method === "POST") {
      return { status: 201, data: { key: await ofs.exportSnapshot() } };
    }
    return { status: 400, data: { error: "POST only" } };
  }

  // Search
  if (resource === "search") {
    const q = params.get("q") ?? "";
    const type = params.get("type") ?? undefined;
    return { status: 200, data: await ofs.grep(q, type) };
  }

  // Graph queries
  if (resource === "graph") {
    const { OfsGraph } = await import("./graph.js");
    const graph = new OfsGraph(ofs);
    const sub = parts[1]; // traverse | neighbors | impact | path

    if (sub === "traverse" && parts[2] && parts[3]) {
      const nodes = await graph.traverse(parts[2], parts[3], {
        maxDepth: params.has("depth") ? parseInt(params.get("depth")!, 10) : 3,
        linkTypes: params.has("linkType") ? [params.get("linkType")!] : undefined,
        direction: (params.get("direction") as "outgoing" | "incoming" | "both") ?? "both",
      });
      return { status: 200, data: nodes };
    }

    if (sub === "neighbors" && parts[2] && parts[3]) {
      const neighbors = await graph.neighbors(
        parts[2],
        parts[3],
        params.get("linkType") ?? undefined,
      );
      return { status: 200, data: neighbors };
    }

    if (sub === "impact" && parts[2] && parts[3]) {
      const depth = params.has("depth") ? parseInt(params.get("depth")!, 10) : 3;
      const nodes = await graph.impactRadius(parts[2], parts[3], depth);
      return { status: 200, data: nodes };
    }

    if (sub === "path" && parts[2] && parts[3] && parts[4] && parts[5]) {
      const path = await graph.findPath(parts[2], parts[3], parts[4], parts[5]);
      return path ? { status: 200, data: path } : { status: 404, data: { error: "No path found" } };
    }

    return {
      status: 400,
      data: { error: "Usage: /ofs/graph/<traverse|neighbors|impact|path>/<type>/<id>" },
    };
  }

  return { status: 404, data: { error: "Not found", path: `/${parts.join("/")}` } };
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

// Standalone server entry point
if (process.argv[1]?.endsWith("api.ts") || process.argv[1]?.endsWith("api.js")) {
  const port = parseInt(process.env.OFS_API_PORT ?? "3100", 10);
  const projectDir = process.env.OFS_PROJECT_DIR ?? process.cwd();
  const agentId = process.env.OFS_AGENT_ID ?? "api-server";

  createOfsFromEnv(projectDir, agentId).then((ofs) => {
    const server = createOfsApiServer(ofs, projectDir);
    server.listen(port, () => {
      console.log(`OFS Semantic API listening on http://0.0.0.0:${port}/ofs/`);
    });
  });
}
