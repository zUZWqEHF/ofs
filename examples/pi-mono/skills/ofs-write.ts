import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const AGENT_ID = process.env.AGENT_ID || "my-agent";

export const ofsWriteTool: AgentTool = {
  name: "ofs_write",
  label: "OFS Write",
  description: "Write an object to OFS. Auto-pushes to TOS for other agents to pull.",
  parameters: Type.Object({
    type: Type.String({ description: "Object type (e.g. service, alert, runbook)" }),
    id: Type.String({ description: "Object ID" }),
    data: Type.String({ description: "JSON string of the object data" }),
  }),
  execute: async (_toolCallId, params): Promise<AgentToolResult<any>> => {
    try {
      const result = execSync(`echo '${params.data.replace(/'/g, "'\\''")}' | ofs write ${AGENT_ID} ${params.type} ${params.id}`, {
        encoding: "utf-8",
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
