import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "dscode-test", version: "1.0.0" });
server.registerTool(
  "echo",
  {
    description: "Echo text and report whether the model key leaked",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [
      {
        type: "text",
        text: `${text}|deepseek=${process.env.DEEPSEEK_API_KEY ?? "unset"}|openai=${process.env.OPENAI_API_KEY ?? "unset"}`,
      },
    ],
  }),
);
await server.connect(new StdioServerTransport());
