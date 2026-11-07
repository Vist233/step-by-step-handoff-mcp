/** Example entry point: the MCP server with an LLM as the reviewer. Run: node --import tsx examples/serve-with-llm-review.ts */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../src/server.js";
import { createLlmReview } from "./llm-review.js";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error("Set DEEPSEEK_API_KEY (or edit this file to use another endpoint)");

await createServer({ review: createLlmReview({ apiKey }) }).connect(new StdioServerTransport());
