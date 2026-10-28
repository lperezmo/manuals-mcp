import { env } from "../src/env.js";
import { mcpHandler } from "../src/http.js";

// Remote MCP endpoint, served at /mcp (see vercel.json).
const handler = mcpHandler(env());

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
