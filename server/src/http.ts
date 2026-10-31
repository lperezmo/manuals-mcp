import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  createMcpHandler,
  generateProtectedResourceMetadata,
  getPublicOrigin,
  metadataCorsOptionsRequestHandler,
  withMcpAuth,
} from "mcp-handler";
import { bearer, supabaseVerifier, userFrom } from "./auth.js";
import { type ChatUsage, callTool, messageSchema, runChat, withCard } from "./chat.js";
import { householdId, userDb } from "./db.js";
import { authIssuer, type Env } from "./env.js";
import { processStoredManual } from "./finder/ingest.js";
import { findManual } from "./finder/search.js";
import { INSTRUCTIONS, registerTools, SERVER_INFO } from "./mcp.js";
import { checkPhoto } from "./photo-check.js";
import {
  pushReport,
  REPORT_DAILY_LIMIT,
  reportSchema,
  reportsToday,
  saveReport,
} from "./report.js";
import {
  OFF_TOPIC_CONFIDENCE,
  OFF_TOPIC_REPLY,
  type RouteDecision,
  routeTurn,
  toolsFor,
} from "./router.js";
import { BUDGET_USED, logRun, modelRunsTodayAll, runsToday } from "./runs.js";
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
      if ((await modelRunsTodayAll(db)) >= env.globalDailyLimit) {
        return Response.json({ error: BUDGET_USED }, { status: 429 });
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
    const { messages, via } = parsed.data;
    const last = messages[messages.length - 1];
    const previous = messages.slice(0, -1).findLast((m) => m.role === "assistant")?.content;
    const decision: RouteDecision | null =
      via === "card"
        ? { route: "answer", confidence: 1, ms: 0, tokens_in: null }
        : last?.role === "user"
          ? await routeTurn(env, { previous, message: last.content }, fetchImpl)
          : null;
    const routeTag = decision ? [`route:${decision.route} ${decision.confidence.toFixed(2)}`] : [];
    if (decision?.route === "off_topic" && decision.confidence >= OFF_TOPIC_CONFIDENCE) {
      await logRun(db, {
        kind: "chat",
        ok: true,
        model: env.router?.model ?? "router",
        ms: Date.now() - started,
        tokens_in: decision.tokens_in,
        tokens_out: 0,
        tools_used: routeTag,
      });
      return Response.json({ reply: OFF_TOPIC_REPLY, tools_used: [] });
    }
    try {
      const result = await runChat(env, auth, messages, fetchImpl, usage, toolsFor(decision));
      await logRun(db, {
        kind: "chat",
        ok: true,
        model: usage.model,
        ms: Date.now() - started,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        tools_used: [...routeTag, ...result.tools_used],
      });
      return Response.json(
        result.card ? { ...result, history: withCard(result.reply, result.card) } : result,
      );
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
    let force = false;
    try {
      const body = (await req.json()) as { image?: unknown; force?: unknown };
      image = body.image;
      force = body.force === true;
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
    const db = userDb(env, auth.token);
    try {
      if ((await runsToday(db, "snap")) >= env.snapDailyLimit) {
        return Response.json(
          {
            error: `That's all the label photos for today (${env.snapDailyLimit}). Type the brand and model instead.`,
          },
          { status: 429 },
        );
      }
      if ((await modelRunsTodayAll(db)) >= env.globalDailyLimit) {
        return Response.json({ error: BUDGET_USED }, { status: 429 });
      }
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 502 });
    }
    const model = env.chatModel ?? env.reader?.model ?? null;
    const started = Date.now();
    const photo = { mime: match[1], base64: match[2] };
    // Jev's quick look: a photo with no label or unreadable text is sent back
    // before Muse spends a read on it. "Read it anyway" skips this.
    const check = force ? null : await checkPhoto(env, photo, fetchImpl);
    if (check?.retake) {
      await logRun(db, {
        kind: "snap",
        ok: true,
        model: env.router?.model ?? null,
        ms: check.ms,
        tokens_in: check.tokens_in,
        tokens_out: 0,
        raw_output: JSON.stringify({
          retake: check.retake,
          label: check.label,
          sharp: check.sharp,
        }),
      });
      return Response.json({ found: false, retake: check.retake });
    }
    try {
      const label = await readLabel(env, photo, fetchImpl);
      await logRun(db, { kind: "snap", ok: true, model, ms: Date.now() - started });
      return Response.json(label);
    } catch (err) {
      const error = (err as Error).message;
      await logRun(db, { kind: "snap", ok: false, model, error, ms: Date.now() - started });
      return Response.json({ error }, { status: 502 });
    }
  };
}

/** "Report an issue" from the website: saved as the user, then pushed to the maintainer. */
export function reportHandler(
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
      return Response.json({ error: "Send JSON with a message." }, { status: 400 });
    }
    const parsed = reportSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "Write a short message (up to 2,000 characters)." },
        { status: 400 },
      );
    }
    const db = userDb(env, auth.token);
    try {
      if ((await reportsToday(db)) >= REPORT_DAILY_LIMIT) {
        return Response.json(
          {
            error: `That's ${REPORT_DAILY_LIMIT} reports today, thank you! Please try again tomorrow.`,
          },
          { status: 429 },
        );
      }
      const id = await saveReport(db, parsed.data, req.headers.get("user-agent"));
      const pushed = await pushReport(
        env,
        { ...parsed.data, id, email: userFrom(auth).email },
        fetchImpl,
      );
      return Response.json({ id, pushed });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 502 });
    }
  };
}

/** Finds manual PDFs on the web for one of the user's things (website only). */
export function findManualHandler(
  env: Env,
  verify: Verify = supabaseVerifier(env),
  fetchImpl: typeof fetch = fetch,
) {
  return async (req: Request) => {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await verify(bearer(req));
    if (!auth) return Response.json({ error: "Sign in first." }, { status: 401 });
    if (!env.search)
      return Response.json({ error: "Web search isn't set up here." }, { status: 503 });
    let itemId: unknown;
    try {
      itemId = ((await req.json()) as { item_id?: unknown }).item_id;
    } catch {}
    if (typeof itemId !== "string")
      return Response.json({ error: "item_id is required." }, { status: 400 });
    const db = userDb(env, auth.token);
    try {
      if ((await runsToday(db, "search")) >= env.search.dailyLimit) {
        return Response.json(
          {
            error: `That's all the manual searches for today (${env.search.dailyLimit}). Paste a link or upload the PDF instead.`,
          },
          { status: 429 },
        );
      }
      const { data: item, error } = await db
        .from("items")
        .select("id, nickname, brand, model")
        .eq("id", itemId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!item)
        return Response.json({ error: "That thing isn't in your household." }, { status: 404 });
      const started = Date.now();
      try {
        const found = await findManual(env, item, fetchImpl);
        await logRun(db, {
          kind: "search",
          ok: true,
          model: env.search.provider,
          ms: Date.now() - started,
          item_id: item.id,
          raw_output: JSON.stringify({ query: found.query, tried: found.tried }, null, 2),
        });
        return Response.json({ query: found.query, candidates: found.candidates });
      } catch (err) {
        await logRun(db, {
          kind: "search",
          ok: false,
          model: env.search.provider,
          error: (err as Error).message,
          ms: Date.now() - started,
          item_id: item.id,
        });
        throw err;
      }
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 502 });
    }
  };
}
