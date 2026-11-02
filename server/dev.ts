// Local dev server: the same handlers as the Vercel functions, on one port.
//   cp .env.example .env && bun run dev
import { readdir, stat } from "node:fs/promises";
import { env } from "./src/env.js";
import {
  attachHandler,
  chatHandler,
  findManualHandler,
  ingestHandler,
  mcpHandler,
  pageCheckHandler,
  publicConfigHandler,
  pulseHandler,
  receiptHandler,
  reportHandler,
  resourceMetadataHandler,
  snapHandler,
  suggestHandler,
  toolHandler,
  upkeepGroupsHandler,
} from "./src/http.js";

const config = env();
const mcp = mcpHandler(config);
const metadata = resourceMetadataHandler(config);
const publicConfig = publicConfigHandler(config);
const ingest = ingestHandler(config);
const chat = chatHandler(config);
const report = reportHandler(config);
const find = findManualHandler(config);
const tool = toolHandler(config);
const snap = snapHandler(config);
const suggest = suggestHandler(config);
const receipt = receiptHandler(config);
const pageCheck = pageCheckHandler(config);
const attach = attachHandler(config);
const upkeepGroups = upkeepGroupsHandler(config);
const pulse = pulseHandler(config);
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
    if (pathname === "/api/find-manual") return find(req);
    if (pathname === "/api/tool") return tool(req);
    if (pathname === "/api/snap") return snap(req);
    if (pathname === "/api/suggest") return suggest(req);
    if (pathname === "/api/receipt") return receipt(req);
    if (pathname === "/api/page-check") return pageCheck(req);
    if (pathname === "/api/attach") return attach(req);
    if (pathname === "/api/upkeep-groups") return upkeepGroups(req);
    if (pathname === "/api/pulse") return pulse(req);
    const file = Bun.file(
      `./public${pathname === "/" ? "/index.html" : pathname}${pathname.includes(".") || pathname === "/" ? "" : ".html"}`,
    );
    if (await file.exists()) {
      // The local test server is reached through a Cloudflare tunnel that tells
      // phones to keep scripts for 4 hours. Pages aren't kept, so each one names
      // its scripts and styles with the newest file time: a change is a new URL.
      if (/\.(html|js)$/.test(file.name ?? "")) {
        const v = await assetVersion();
        const text = (await file.text()).replace(
          /(["'(])\/(app|jobs|theme)\.(js|css)(?=["')])/g,
          `$1/$2.$3?v=${v}`,
        );
        return new Response(text, {
          headers: { "content-type": file.type, "cache-control": "no-cache" },
        });
      }
      return new Response(file, { headers: { "cache-control": "no-cache" } });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`manuals-mcp dev server on http://localhost:${port} (MCP at /mcp)`);

/** The newest modified time of the shared scripts and styles, as a short version stamp. */
async function assetVersion(): Promise<string> {
  const names = (await readdir("./public")).filter((n) => /\.(js|css)$/.test(n));
  const times = await Promise.all(names.map(async (n) => (await stat(`./public/${n}`)).mtimeMs));
  return Math.max(0, ...times)
    .toString(36)
    .replace(".", "");
}
