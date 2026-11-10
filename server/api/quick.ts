import { env } from "../src/env.js";
import {
  pageCheckHandler,
  publicConfigHandler,
  pulseHandler,
  reportHandler,
  suggestHandler,
  upkeepGroupsHandler,
} from "../src/http.js";

// The short endpoints share one function, because Vercel's Hobby plan allows
// 12 functions a deployment. vercel.json rewrites each /api/<name> here with
// ?route=<name>; the long-running ones (chat, ingest, mcp...) keep their own.
const config = env();
const routes: Record<
  string,
  { method: "GET" | "POST"; run: (req: Request) => Response | Promise<Response> }
> = {
  // Public Supabase settings for the sign-in and consent page.
  config: { method: "GET", run: publicConfigHandler(config) },
  // Household Pulse on the home page: what's worth doing now (Jev, no Muse).
  pulse: { method: "POST", run: pulseHandler(config) },
  "page-check": { method: "POST", run: pageCheckHandler(config) },
  report: { method: "POST", run: reportHandler(config) },
  suggest: { method: "POST", run: suggestHandler(config) },
  "upkeep-groups": { method: "POST", run: upkeepGroupsHandler(config) },
};

function handler(req: Request) {
  const url = new URL(req.url);
  // The rewrite adds ?route=; the path's last part covers a direct call.
  const name = url.searchParams.get("route") ?? url.pathname.split("/").pop() ?? "";
  const route = Object.hasOwn(routes, name) ? routes[name] : undefined;
  if (!route) return new Response("Not found", { status: 404 });
  if (req.method !== route.method)
    return new Response("Method not allowed", { status: 405, headers: { allow: route.method } });
  return route.run(req);
}

export const GET = handler;
export const POST = handler;
