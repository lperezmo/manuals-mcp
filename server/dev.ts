// Local dev server: the same handlers as the Vercel functions, on one port.
//   cp .env.example .env && bun run dev
import { env } from "./src/env.js";
import {
  chatHandler,
  ingestHandler,
  mcpHandler,
  publicConfigHandler,
  reportHandler,
  resourceMetadataHandler,
  snapHandler,
  toolHandler,
} from "./src/http.js";

const config = env();
const mcp = mcpHandler(config);
const metadata = resourceMetadataHandler(config);
const publicConfig = publicConfigHandler(config);
const ingest = ingestHandler(config);
const chat = chatHandler(config);
const report = reportHandler(config);
const tool = toolHandler(config);
const snap = snapHandler(config);
const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/mcp" || pathname === "/api/mcp") return mcp(req);
    if (pathname.startsWith("/.well-known/oauth-protected-resource")) return metadata(req);
    if (pathname === "/api/config") return publicConfig();
    if (pathname === "/api/ingest") return ingest(req);
    if (pathname === "/api/chat") return chat(req);
    if (pathname === "/api/report") return report(req);
    if (pathname === "/api/tool") return tool(req);
    if (pathname === "/api/snap") return snap(req);
    const file = Bun.file(
      `./public${pathname === "/" ? "/index.html" : pathname}${pathname.includes(".") || pathname === "/" ? "" : ".html"}`,
    );
    if (await file.exists()) return new Response(file);
    return new Response("Not found", { status: 404 });
  },
});

console.log(`manuals-mcp dev server on http://localhost:${port} (MCP at /mcp)`);
