import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const AGENT_ID = process.env.AGENT_ID || "my-agent";

/** Normalize LLM-provided data into a valid JSON string. */
function normalizeData(raw: unknown): string {
  if (typeof raw === "object" && raw !== null) {
    return JSON.stringify(raw);
  }
  let s = String(raw);
  s = s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  try {
    JSON.parse(s);
    return s;
  } catch {
    return JSON.stringify({ value: s });
  }
}

export const ofsWriteTool: AgentTool = {
  name: "ofs_write",
  label: "OFS Write",
  description: "Write a JSON object to OFS. Auto-pushes to TOS for other agents to pull.",
  parameters: Type.Object({
    type: Type.String({ description: "Object type (e.g. service, alert, runbook)" }),
    id: Type.String({ description: "Object ID" }),
    data: Type.Any({ description: 'Object data as JSON, e.g. {"name":"foo","status":"ok"}' }),
  }),
  execute: async (_toolCallId, params): Promise<AgentToolResult<any>> => {
    try {
      const data = normalizeData(params.data);
      const result = execSync(`ofs write ${AGENT_ID} ${params.type} ${params.id}`, {
        encoding: "utf-8",
        input: data,
        timeout: 10000,
      });
      return {
        content: [{ type: "text", text: result.trim() }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `OFS write failed: ${err.message}` }],
        isError: true,
      };
    }
  },
};
