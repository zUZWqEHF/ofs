import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

export const helloTool: AgentTool = {
  name: "hello",
  label: "Hello World",
  description: "A test tool that returns a greeting.",
  parameters: Type.Object({
    name: Type.Optional(Type.String({ description: "Name to greet" })),
  }),
  execute: async (_toolCallId, params): Promise<AgentToolResult<any>> => {
    const name = params.name || "World";
    return {
      content: [{ type: "text", text: `Hello, ${name}! OFS agent is working.` }],
    };
  },
};
