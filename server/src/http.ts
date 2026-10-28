import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  createMcpHandler,
  generateProtectedResourceMetadata,
  getPublicOrigin,
  metadataCorsOptionsRequestHandler,
  withMcpAuth,
} from "mcp-handler";
import { bearer, supabaseVerifier } from "./auth.js";
import { type ChatUsage, callTool, messageSchema, runChat } from "./chat.js";
import { householdId, userDb } from "./db.js";
import { authIssuer, type Env } from "./env.js";
import { processStoredManual } from "./finder/ingest.js";
import { INSTRUCTIONS, registerTools, SERVER_INFO } from "./mcp.js";
import { logRun, runsToday } from "./runs.js";
import { MAX_IMAGE_BYTES, readLabel } from "./snap.js";

// HTTP entry points, shared by the Vercel functions in api/ and the local
// dev server. All of them are Web-standard (Request) => Response.

export type Verify = (token: string | undefined) => Promise<AuthInfo | undefined>;

/** The MCP endpoint's public path; /mcp is rewritten to api/mcp on Vercel. */
export const MCP_PATH = "/mcp";
export const RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;

export function mcpHandler(env: Env, verify: Verify = supabaseVerifier(env)) {
  const handler = createMcpHandler((server) => registerTools(server, env), {
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  });
  return withMcpAuth(handler, (_req, token) => verify(token), {
    required: true,
    resourceMetadataPath: RESOURCE_METADATA_PATH,
    resourceUrl: env.publicUrl,
  });
}

/** RFC 9728 metadata: tells AI apps to sign in with Supabase Auth. */
export function resourceMetadataHandler(env: Env) {
  const preflight = metadataCorsOptionsRequestHandler();
  return (req: Request) => {
    if (req.method === "OPTIONS") return preflight();
    const metadata = generateProtectedResourceMetadata({
      authServerUrls: [authIssuer(env)],
      resourceUrl: `${env.publicUrl ?? getPublicOrigin(req)}${MCP_PATH}`,
      additionalMetadata: { resource_name: "Manuals" },
    });
    return Response.json(metadata, {
      headers: { "access-control-allow-origin": "*", "cache-control": "max-age=3600" },
    });
  };
}

/** Public values the consent page needs to talk to Supabase Auth. */
export function publicConfigHandler(env: Env) {
  return () =>
    Response.json(
      { supabaseUrl: env.supabaseUrl, supabasePublishableKey: env.supabasePublishableKey },
      { headers: { "cache-control": "public, max-age=300" } },
    );
}

/**
 * The app uploads a PDF to storage, then calls this to extract its text and,
 * when a server reader is configured, distill its schedule.
 */
export function ingestHandler(env: Env, verify: Verify = supabaseVerifier(env)) {
  return async (req: Request) => {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await verify(bearer(req));
    if (!auth) return Response.json({ error: "Sign in first." }, { status: 401 });
    let manualId: unknown;
    try {
      manualId = ((await req.json()) as { manual_id?: unknown }).manual_id;
    } catch {
      return Response.json({ error: "Send JSON with manual_id." }, { status: 400 });
    }
    if (typeof manualId !== "string")
      return Response.json({ error: "manual_id is required." }, { status: 400 });
    try {
      const db = userDb(env, auth.token);
      const outcome = await processStoredManual({
        env,
        db,
        householdId: await householdId(db),
        manualId,
      });
      return Response.json(outcome);
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 422 });
    }
  };
}

/** The website's chat with Muse: same tools as /mcp, as the signed-in user. */
export function chatHandler(
  env: Env,
  verify: Verify = supabaseVerifier(env),
  fetchImpl: typeof fetch = fetch,
) {
  return async (req: Request) => {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await verify(bearer(req));
    if (!auth) return Response.json({ error: "Sign in first." }, { status: 401 });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Send JSON with messages." }, { status: 400 });
    }
    const parsed = messageSchema.safeParse(body);
    if (!parsed.success)
      return Response.json({ error: "Send a few short messages." }, { status: 400 });
    const db = userDb(env, auth.token);
    try {
      if ((await runsToday(db, "chat")) >= env.chatDailyLimit) {
        return Response.json(
          {
            error: `That's all the chat for today (${env.chatDailyLimit} questions). It resets within a day; the buttons still work.`,
          },
          { status: 429 },
        );
      }
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 502 });
    }
    const usage: ChatUsage = {
      model: env.chatModel ?? env.reader?.model ?? "",
      tokens_in: 0,
      tokens_out: 0,
    };
    const started = Date.now();
    try {
      const result = await runChat(env, auth, parsed.data.messages, fetchImpl, usage);
      await logRun(db, {
        kind: "chat",
        ok: true,
        model: usage.model,
        ms: Date.now() - started,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        tools_used: result.tools_used,
      });
      return Response.json(result);
    } catch (err) {
      await logRun(db, {
        kind: "chat",
        ok: false,
        model: usage.model,
        error: (err as Error).message,
        ms: Date.now() - started,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
      });
      return Response.json({ error: (err as Error).message }, { status: 502 });
    }
  };
}

/** One tool call from a website button, as the signed-in user. */
export function toolHandler(env: Env, verify: Verify = supabaseVerifier(env)) {
  return async (req: Request) => {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await verify(bearer(req));
    if (!auth) return Response.json({ error: "Sign in first." }, { status: 401 });
    let body: { name?: unknown; args?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "Send JSON with name and args." }, { status: 400 });
    }
    if (typeof body.name !== "string") {
      return Response.json({ error: "name is required." }, { status: 400 });
    }
    try {
      const outcome = await callTool(env, auth, body.name, body.args);
      return Response.json(outcome, { status: outcome.ok ? 200 : 422 });
    } catch (err) {
      return Response.json({ ok: false, summary: (err as Error).message }, { status: 500 });
    }
  };
}

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

/** Reads a label photo (JSON with a data URL) into brand, model and serial. */
export function snapHandler(
  env: Env,
  verify: Verify = supabaseVerifier(env),
  fetchImpl: typeof fetch = fetch,
) {
  return async (req: Request) => {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await verify(bearer(req));
    if (!auth) return Response.json({ error: "Sign in first." }, { status: 401 });
    let image: unknown;
    try {
      image = ((await req.json()) as { image?: unknown }).image;
    } catch {
      return Response.json({ error: "Send JSON with an image data URL." }, { status: 400 });
    }
    const match = typeof image === "string" ? image.match(DATA_URL) : null;
    if (!match?.[1] || !match[2]) {
      return Response.json({ error: "Send a JPEG, PNG or WebP photo." }, { status: 400 });
    }
    if (match[2].length * 0.75 > MAX_IMAGE_BYTES) {
      return Response.json({ error: "That photo is too big; try a smaller one." }, { status: 413 });
    }
    try {
      return Response.json(await readLabel(env, { mime: match[1], base64: match[2] }, fetchImpl));
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 502 });
    }
  };
}
