import { env } from "../src/env.js";
import { resourceMetadataHandler } from "../src/http.js";

// Served at /.well-known/oauth-protected-resource[/mcp] (see vercel.json).
const handler = resourceMetadataHandler(env());

export const GET = handler;
export const OPTIONS = handler;
