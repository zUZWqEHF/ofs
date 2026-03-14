/**
 * Minimal pi-mono agent with OFS integration
 *
 * This is the simplest possible agent that demonstrates:
 * - pi-mono Agent creation with tools
 * - OFS read/write for context sharing
 * - Metrics push to VictoriaMetrics
 *
 * Usage:
 *   OPENAI_API_KEY=... npx tsx runner.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";

import { helloTool } from "./skills/hello.js";
import { ofsReadTool } from "./skills/ofs-read.js";
import { ofsWriteTool } from "./skills/ofs-write.js";

// --- Config ---
const AGENT_ID = process.env.AGENT_ID || "my-agent";

const model: Model<"openai-completions"> = {
  id: process.env.MODEL_ID || "gpt-4o-mini",
  name: "LLM",
  api: "openai-completions",
  provider: "openai",
  baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

const systemPrompt = `You are ${AGENT_ID}, a minimal OFS-integrated agent.
You can read and write OFS objects to share context with other agents.
Available tools: hello (test), ofs_read (read shared context), ofs_write (write context).`;

// --- Agent ---
const tools: AgentTool[] = [helloTool, ofsReadTool, ofsWriteTool];

const agent = new Agent({
  initialState: {
    systemPrompt,
    model,
    tools,
    thinkingLevel: "off",
  },
  getApiKey: async () => process.env.OPENAI_API_KEY!,
});

agent.subscribe((event) => {
  if (event.type === "tool_execution_end") {
    console.log(`[${AGENT_ID}] tool: ${event.toolName} (error=${event.isError})`);
  }
});

// --- Run ---
const userPrompt = process.argv[2] || "Say hello, then write a test object to OFS.";
console.log(`[${AGENT_ID}] prompt: ${userPrompt}`);
await agent.prompt(userPrompt);
console.log(`[${AGENT_ID}] done`);
