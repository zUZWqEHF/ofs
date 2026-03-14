import { Type } from "@sinclair/typebox";
import { execSync } from "node:child_process";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const AGENT_ID = process.env.AGENT_ID || "my-agent";

export const ofsReadTool: AgentTool = {
  name: "ofs_read",
  label: "OFS Read",
  description: "Read an object from OFS (local or shared from other agents).",
  parameters: Type.Object({
    agent_id: Type.Optional(Type.String({ description: "Agent ID to read from (default: own)" })),
    type: Type.String({ description: "Object type (e.g. service, alert, runbook)" }),
    id: Type.String({ description: "Object ID" }),
  }),
  execute: async (_toolCallId, params): Promise<AgentToolResult<any>> => {
    const agent = params.agent_id || AGENT_ID;
    try {
      const result = execSync(`ofs read ${agent} ${params.type} ${params.id}`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      return {
        content: [{ type: "text", text: result }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `OFS read failed: ${err.message}` }],
        isError: true,
      };
    }
  },
};
