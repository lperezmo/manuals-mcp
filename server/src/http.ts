import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  createMcpHandler,
  generateProtectedResourceMetadata,
  getPublicOrigin,
  metadataCorsOptionsRequestHandler,
  withMcpAuth,
} from "mcp-handler";
import { bearer, supabaseVerifier, userFrom } from "./auth.js";
import { background, quickOrBackground } from "./background.js";
import {
  type ChatImage,
  type ChatUsage,
  callTool,
  messageSchema,
  runChat,
  withCard,
} from "./chat.js";
import { householdId, type ItemRow, userDb } from "./db.js";
import {
  answerDisplay,
  type DisplayAnswer,
  type DisplayRead,
  displayTag,
  readDisplay,
} from "./display-code.js";
import { authIssuer, type Env } from "./env.js";
import {
  cachedSnapshot,
  type FastLane,
  fastAllowed,
  fastTag,
  forgetSnapshot,
  hintFor,
  loadSnapshot,
  quickAnswer,
  rememberSnapshot,
  suggestions,
} from "./fastlane.js";
import {
  ATTACH_DOWNLOAD_MS,
  FetchPdfError,
  fetchPdf,
  SiteBlockedError,
} from "./finder/fetch-pdf.js";
import {
  processStoredManual,
  READ_BUDGET_MS,
  ReadingBusyError,
  storeManual,
} from "./finder/ingest.js";
import { blockedMessage, findManual } from "./finder/search.js";
import { INSTRUCTIONS, registerTools, SERVER_INFO } from "./mcp.js";
import { isSafetyTurn, memoryTag, noteFrom, notesForMuse, saveNote } from "./memory.js";
import { checkPhoto, checkRead, lookAtPhoto } from "./photo-check.js";
import { buildPulse, pulseLog } from "./pulse.js";
import { readReceipt, saveReceipt, warrantyStatus } from "./receipt.js";
import {
  pushReport,
  REPORT_DAILY_LIMIT,
  reportSchema,
  reportsToday,
  saveReport,
} from "./report.js";
import {
  isSetup,
  OFF_TOPIC_CONFIDENCE,
  OFF_TOPIC_REPLY,
  type RouteDecision,
  routeTurn,
  SETUP_MESSAGE,
  toolsFor,
} from "./router.js";
import { BUDGET_USED, logRun, modelRunsTodayAll, runsToday } from "./runs.js";
import { MAX_IMAGE_BYTES, modelGuess, radioSticker, readLabel } from "./snap.js";
import { ITEM_COLUMNS, itemLabel } from "./tools/context.js";
import { groupTasks } from "./upkeep.js";

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
/**
 * How long a read may take before the page is told "started, it keeps going".
 * An answer that needs no read (already read, busy, a bad id) is quicker.
 */
export const READ_QUICK_MS = 2_500;

export function ingestHandler(env: Env, verify: Verify = supabaseVerifier(env)) {
  return async (req: Request) => {
    // The read's time counts from here: the function limit does too.
    const deadline = Date.now() + READ_BUDGET_MS;
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await verify(bearer(req));
    if (!auth) return Response.json({ error: "Sign in first." }, { status: 401 });
    let body: { manual_id?: unknown; reread?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "Send JSON with manual_id." }, { status: 400 });
    }
    if (typeof body.manual_id !== "string")
      return Response.json({ error: "manual_id is required." }, { status: 400 });
    try {
      const db = userDb(env, auth.token);
      const read = await quickOrBackground(
        processStoredManual({
          env,
          db,
          householdId: await householdId(db),
          manualId: body.manual_id,
          reread: body.reread === true,
          deadline,
        }),
        READ_QUICK_MS,
      );
      if (!read.done)
        return Response.json({ reading: true, manual_id: body.manual_id }, { status: 202 });
      return Response.json(read.value);
    } catch (err) {
      if (err instanceof ReadingBusyError)
        return Response.json({ error: err.message, busy: true }, { status: 409 });
      return Response.json({ error: (err as Error).message }, { status: 422 });
    }
  };
}

/**
 * "Use this" on a found manual: downloads the PDF and stores it. With
 * `read: true` (what the page sends) Muse's read starts here too, in the same
 * function, so the download and the read share its time limit (300 s) and the
 * read gives up at READ_BUDGET_MS from the start of the request.
 */
export function attachHandler(
  env: Env,
  verify: Verify = supabaseVerifier(env),
  fetchImpl: typeof fetch = fetch,
) {
  return async (req: Request) => {
    // A slow download eats into the read's time: both share this function's limit.
    const deadline = Date.now() + READ_BUDGET_MS;
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await verify(bearer(req));
    if (!auth) return Response.json({ error: "Sign in first." }, { status: 401 });
    let body: { item_id?: unknown; url?: unknown; official?: unknown; read?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "Send JSON with item_id and url." }, { status: 400 });
    }
    if (typeof body.item_id !== "string" || typeof body.url !== "string")
      return Response.json({ error: "item_id and url are required." }, { status: 400 });
    const pdfUrl = body.url;
    const db = userDb(env, auth.token);
    // With read: true, Muse's read starts here and keeps going if the page is left.
    const answer = async (manualId: string, existing: boolean) => {
      const base = { manual_id: manualId, ...(existing ? { existing: true } : {}) };
      if (body.read !== true) return Response.json(base);
      try {
        const read = await quickOrBackground(
          processStoredManual({ env, db, householdId: await householdId(db), manualId, deadline }),
          READ_QUICK_MS,
        );
        return Response.json(read.done ? { ...base, ...read.value } : { ...base, reading: true });
      } catch (err) {
        if (err instanceof ReadingBusyError) return Response.json({ ...base, reading: true });
        return Response.json({ ...base, error: (err as Error).message }, { status: 422 });
      }
    };
    const run = (async () => {
      try {
        const { data: item, error } = await db
          .from("items")
          .select(ITEM_COLUMNS)
          .eq("id", body.item_id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!item)
          return Response.json({ error: "That thing isn't in your household." }, { status: 404 });
        // A second tap, or a retry after a dropped connection, reuses the stored copy.
        const stored = async (url: string) => {
          const { data } = await db
            .from("manuals")
            .select("id")
            .eq("item_id", body.item_id as string)
            .eq("source_url", url)
            .not("storage_path", "is", null)
            .limit(1)
            .maybeSingle();
          return (data?.id as string | undefined) ?? null;
        };
        const before = await stored(pdfUrl);
        if (before) return answer(before, true);
        let fetched: Awaited<ReturnType<typeof fetchPdf>>;
        const started = Date.now();
        try {
          fetched = await fetchPdf(pdfUrl, fetchImpl, ATTACH_DOWNLOAD_MS);
        } catch (err) {
          const message =
            err instanceof SiteBlockedError
              ? blockedMessage(err, (item as ItemRow).brand)
              : err instanceof FetchPdfError
                ? err.message
                : "The maker's site is too slow right now. Try again in a bit, or open the PDF, save it and upload it.";
          // The page's "Reading" pill watches for this, so it ends even if the page was left.
          if (body.read === true)
            await logRun(db, {
              kind: "read",
              ok: false,
              error: message,
              ms: Date.now() - started,
              item_id: item.id as string,
              raw_output: JSON.stringify({ step: "download", url: pdfUrl }),
            });
          return Response.json(
            { error: message, ...(err instanceof SiteBlockedError ? { blocked: true } : {}) },
            { status: 422 },
          );
        }
        const after = fetched.finalUrl === pdfUrl ? null : await stored(fetched.finalUrl);
        if (after) return answer(after, true);
        const manualId = await storeManual({
          db,
          householdId: await householdId(db),
          item: item as ItemRow,
          bytes: fetched.bytes,
          source: "url",
          sourceUrl: fetched.finalUrl,
          official: body.official === true,
        });
        return answer(manualId, false);
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    })();
    // A slow maker's site keeps downloading even if the page is left.
    background(run);
    return run;
  };
}

/** Sorts a thing's upkeep tasks into the page's tiles. Reads the tasks as the user (RLS). */
export function upkeepGroupsHandler(
  env: Env,
  verify: Verify = supabaseVerifier(env),
  fetchImpl: typeof fetch = fetch,
) {
  return async (req: Request) => {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await verify(bearer(req));
    if (!auth) return Response.json({ error: "Sign in first." }, { status: 401 });
    let itemId: unknown;
    try {
      itemId = ((await req.json()) as { item_id?: unknown }).item_id;
    } catch {}
    if (typeof itemId !== "string")
      return Response.json({ error: "item_id is required." }, { status: 400 });
    if (!env.router) return Response.json({ groups: {} });
    const db = userDb(env, auth.token);
    try {
      const { data: item, error } = await db
        .from("items")
        .select("nickname, brand, model, tasks(id, title, details)")
        .eq("id", itemId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!item)
        return Response.json({ error: "That thing isn't in your household." }, { status: 404 });
      const tasks = (item.tasks ?? []) as { id: string; title: string; details: string | null }[];
      const groups = await groupTasks(env, itemLabel(item as never), tasks.slice(0, 80), fetchImpl);
      return Response.json({ groups });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 502 });
    }
  };
}

/**
 * Household Pulse for the home page: the few upcoming things worth doing now
 * (pulse.ts). One Jev call at most, read as the user. Answers {pulse: null}
 * when Jev is unset or down, and the page then shows no Pulse card.
 */
export function pulseHandler(
  env: Env,
  verify: Verify = supabaseVerifier(env),
  fetchImpl: typeof fetch = fetch,
) {
  return async (req: Request) => {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await verify(bearer(req));
    if (!auth) return Response.json({ error: "Sign in first." }, { status: 401 });
    if (!env.router) return Response.json({ pulse: null });
    const { userId } = userFrom(auth);
    if (!fastAllowed(`pulse:${userId}`)) return Response.json({ pulse: null, slow_down: true });
    const db = userDb(env, auth.token);
    try {
      const pulse = await buildPulse(env, db, userId, fetchImpl);
      if (pulse?.jev) {
        await logRun(db, {
          kind: "pulse",
          ok: true,
          model: env.router.model,
          ms: pulse.jev.ms,
          tokens_in: pulse.jev.tokens_in,
          raw_output: pulseLog(pulse),
        });
      }
      return Response.json({ pulse });
    } catch {
      return Response.json({ pulse: null });
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
    let image: ChatImage | undefined;
    if (parsed.data.image !== undefined) {
      const match = parsed.data.image.match(DATA_URL);
      if (!match?.[1] || !match[2] || parsed.data.messages.at(-1)?.role !== "user") {
        return Response.json({ error: "Send a JPEG, PNG or WebP photo." }, { status: 400 });
      }
      if (match[2].length * 0.75 > MAX_IMAGE_BYTES) {
        return Response.json(
          { error: "That photo is too big; try a smaller one." },
          { status: 413 },
        );
      }
      image = { mime: match[1], base64: match[2] };
    }
    const db = userDb(env, auth.token);
    const { messages, via, turn: turnId } = parsed.data;
    const last = messages[messages.length - 1];
    const previous = messages.slice(0, -1).findLast((m) => m.role === "assistant")?.content;
    // A photo turn's text, without the "[photo]" stand-in the page puts in front.
    const question = last?.content.replace(/^\[photo\]\s*/, "") ?? "";
    const started = Date.now();
    // The fast lane: one Jev call over the saved facts and tasks also routes the
    // turn. A confident, complete, harmless answer goes back without Muse, so it
    // doesn't count against the chat limit.
    const routable =
      via === undefined && last?.role === "user" && !!question && !SETUP_MESSAGE.test(last.content);
    let lane: FastLane | null = null;
    // Set when the fast lane's Jev call never came back (down or timed out):
    // the turn then skips the router instead of waiting for Jev a second time.
    let jevDown = false;
    const userId = userFrom(auth).userId;
    // A photo may be of a display showing an error code: Jev reads it against
    // the household's saved codes, alongside the fast lane, even when the
    // photo came with no words.
    const photoTurn = image !== undefined && via === undefined && last?.role === "user";
    let shown: DisplayRead | null = null;
    // Jev's yes/no look at the photo (below) starts now, beside the display
    // read, so a photo turn that goes on to Muse waits for one image call, not two.
    const looking = image ? lookAtPhoto(env, image, question, fetchImpl) : null;
    if ((routable || photoTurn) && env.router && fastAllowed(`chat:${userId}`)) {
      const watched = (async (...args: Parameters<typeof fetch>) => {
        try {
          return await fetchImpl(...args);
        } catch (err) {
          jevDown = true;
          throw err;
        }
      }) as typeof fetch;
      try {
        const snapshot = await loadSnapshot(db);
        rememberSnapshot(userId, snapshot);
        // The display read gets the plain fetch: its failing alone isn't Jev being down.
        [lane, shown] = await Promise.all([
          routable
            ? quickAnswer(
                env,
                snapshot,
                { message: question, previous, image: image !== undefined },
                watched,
              )
            : null,
          image ? readDisplay(env, image, snapshot, question, fetchImpl) : null,
        ]);
      } catch {
        lane = null;
      }
    }
    // House memory: a lasting fact in the person's own words, from the same Jev call.
    const draft = noteFrom(lane, question);
    const memory = draft ? [memoryTag(await saveNote(db, draft), draft)] : [];
    const read: DisplayAnswer | null = shown ? answerDisplay(shown, lane, question) : null;
    const fromPhoto = !lane?.answer && !!read?.answer;
    const instant = lane?.answer ?? read?.answer;
    if (instant) {
      const { pick } = instant;
      await logRun(db, {
        kind: "fast",
        ok: true,
        model: env.router?.model ?? "jev",
        ms: Date.now() - started,
        tokens_in: (lane?.tokens_in ?? 0) + (shown?.tokens_in ?? 0) || null,
        tokens_out: 0,
        item_id: pick.item.id,
        tools_used: [
          ...(lane ? [fastTag(lane)] : []),
          ...(shown && read ? [displayTag(shown, read)] : []),
          `${pick.row.type}:${pick.row.kind}`,
          ...memory,
        ],
        raw_output: JSON.stringify({
          question,
          line: pick.row,
          scores: lane?.scores,
          ...(shown ? { display: { ...shown.scores, code: read?.code, p: read?.p } } : {}),
        }),
      });
      return Response.json({
        reply: instant.text,
        tools_used: fromPhoto ? ["photo_check", "fast_lane"] : ["fast_lane"],
        fast: {
          item_id: pick.item.id,
          type: pick.row.type,
          id: pick.row.id,
          page: pick.row.page,
          ms: fromPhoto ? (shown?.ms ?? 0) : (lane?.ms ?? 0),
        },
      });
    }
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
    let decision: RouteDecision | null =
      via === "card"
        ? { route: "answer", confidence: 1, ms: 0, tokens_in: null }
        : via === "more"
          ? { route: "ask", confidence: 1, ms: 0, tokens_in: null }
          : last?.role === "user" && SETUP_MESSAGE.test(last.content)
            ? { route: "setup", confidence: 1, ms: 0, tokens_in: null }
            : lane
              ? lane.route
              : last?.role === "user" && question && !jevDown
                ? await routeTurn(env, { previous, message: question }, fetchImpl)
                : null;
    // A photo is never small talk or off topic to Muse: it gets every tool.
    if (image && (decision?.route === "smalltalk" || decision?.route === "off_topic")) {
      decision = null;
    }
    const routeTag = [
      ...(decision ? [`route:${decision.route} ${decision.confidence.toFixed(2)}`] : []),
      ...(lane ? [fastTag(lane)] : []),
      ...(shown && read ? [displayTag(shown, read)] : []),
      ...memory,
    ];
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
    // Jev's quick look at a photo: a simple, confident yes/no about how
    // something looks reaches Muse as text, so Muse skips the image read.
    // Skipped when Jev just failed to answer the fast lane.
    let turn = messages;
    // What the household told Muse before, read while Jev looks at any photo.
    // A car seat or safety turn gets none.
    const notes = isSafetyTurn(lane, question) ? null : notesForMuse(db);
    const look = image && !jevDown ? await looking : null;
    if (image && look?.finding) {
      turn = [...messages.slice(0, -1), { role: "user", content: `${question}\n${look.finding}` }];
      image = undefined;
    }
    // Jev's picks ride along under the question, so Muse can skip a lookup or two.
    const hint = lane && decision?.route !== "smalltalk" ? hintFor(lane) : null;
    if (hint) {
      const lastTurn = turn[turn.length - 1];
      if (lastTurn?.role === "user") {
        turn = [...turn.slice(0, -1), { role: "user", content: `${lastTurn.content}\n${hint}` }];
      }
    }
    const photoTag = look
      ? [`photo:${look.finding ? "jev" : "muse"} ${look.simple.toFixed(2)}/${look.yes.toFixed(2)}`]
      : image
        ? ["photo:muse"]
        : [];
    // Jev's tokens ride on the chat row, so a photo turn counts once against the chat limit.
    const photoCheck = look
      ? {
          photo_check: {
            model: env.router?.model,
            tokens_in: look.tokens_in,
            ms: look.ms,
            simple: look.simple,
            yes: look.yes,
          },
        }
      : {};
    // The turn id and what the page would have shown, so a paused page can pick it up.
    const rawFor = (answer?: Record<string, unknown>) =>
      look || turnId
        ? JSON.stringify({ ...photoCheck, ...(turnId ? { turn: turnId, ...answer } : {}) })
        : null;
    try {
      const result = await runChat(env, auth, turn, fetchImpl, usage, toolsFor(decision), {
        image,
        mustAsk: isSetup(decision),
        context: await notes,
      });
      await logRun(db, {
        kind: "chat",
        ok: true,
        model: usage.model,
        ms: Date.now() - started,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        tools_used: [...routeTag, ...photoTag, ...result.tools_used],
        raw_output: rawFor({
          reply: result.reply,
          tools_used: look?.finding ? ["photo_check", ...result.tools_used] : result.tools_used,
          ...(result.card
            ? { card: result.card, history: withCard(result.reply, result.card) }
            : {}),
        }),
      });
      // A turn that changed something makes type-ahead read the facts again.
      if (result.tools_used.some((t) => !READ_ONLY_TOOLS.has(t))) {
        forgetSnapshot(userId);
      }
      if (look?.finding) result.tools_used.unshift("photo_check");
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
        tools_used: [...routeTag, ...photoTag],
        raw_output: rawFor({ error: (err as Error).message }),
      });
      return Response.json({ error: (err as Error).message }, { status: 502 });
    }
  };
}

/** Tools that only read; a chat turn that used only these leaves type-ahead's cache alone. */
const READ_ONLY_TOOLS = new Set([
  "list_items",
  "ask_manual",
  "upcoming",
  "car_seat_status",
  "warranty_status",
  "show_card",
]);

/**
 * Search as you type: the saved facts and tasks Jev thinks answer what the
 * person is typing, before they press Enter. The page keeps one request in
 * flight and asks again when the text has changed (TypeSafe's intelliprompter
 * pattern). Never calls Muse, and answers an empty list when Jev is unset or down.
 */
export function suggestHandler(
  env: Env,
  verify: Verify = supabaseVerifier(env),
  fetchImpl: typeof fetch = fetch,
) {
  return async (req: Request) => {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await verify(bearer(req));
    if (!auth) return Response.json({ error: "Sign in first." }, { status: 401 });
    let q: unknown;
    try {
      q = ((await req.json()) as { q?: unknown }).q;
    } catch {}
    if (typeof q !== "string") return Response.json({ error: "q is required." }, { status: 400 });
    const text = q.trim().slice(0, 200);
    if (text.length < 2 || !env.router) return Response.json({ suggestions: [] });
    const { userId } = userFrom(auth);
    if (!fastAllowed(`suggest:${userId}`))
      return Response.json({ suggestions: [], slow_down: true });
    const started = Date.now();
    try {
      const snapshot = await cachedSnapshot(userDb(env, auth.token), userId);
      const lane = await quickAnswer(env, snapshot, { message: text, mode: "suggest" }, fetchImpl);
      return Response.json({ suggestions: suggestions(lane), ms: Date.now() - started });
    } catch {
      return Response.json({ suggestions: [] });
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

/**
 * Jev's box call (where a doubtful value is on the photo) must finish this
 * long after the request arrived, or it's skipped. The photo routes have 60 s;
 * this leaves room to log the run and save a receipt.
 */
const BOX_BY_MS = 45_000;

/** What the person sees when reading a photo failed: Muse's timeout in plain words. */
function photoError(err: Error): string {
  return err.name === "TimeoutError"
    ? "Muse took too long with that photo. Try it once more."
    : err.message;
}

/** Reads a label photo (JSON with a data URL) into brand, model and serial. */
export function snapHandler(
  env: Env,
  verify: Verify = supabaseVerifier(env),
  fetchImpl: typeof fetch = fetch,
) {
  return async (req: Request) => {
    const arrived = Date.now();
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
      if (!label.model) {
        // No line says "Model": offer the likeliest tagged code for the person to confirm.
        const guess = modelGuess(label.codes);
        if (guess) Object.assign(label, { model_guess: guess });
        // A Wi-Fi module's sticker (FCC or IC ID) doesn't say what the thing is,
        // so a category read off it is a guess; the wizard asks instead.
        if (radioSticker(label.codes)) {
          Object.assign(label, { category: null, kind: null, nickname: null, radio: true });
        }
      }
      // Jev's second look at what Muse read: a doubtful model number sends the
      // wizard to its "Almost" step instead of finding the wrong manual. Asked
      // even when found is false, since the wizard still uses a brand or model.
      const reread = await checkRead(env, photo, label, "label", fetchImpl, arrived + BOX_BY_MS);
      const doubtful = reread?.doubtful ?? [];
      const boxes = reread?.boxes;
      await logRun(db, {
        kind: "snap",
        ok: true,
        model,
        ms: Date.now() - started,
        raw_output: JSON.stringify(reread ? { ...label, check: reread } : label),
      });
      return Response.json(
        doubtful.length ? { ...label, unsure: true, doubtful, ...(boxes ? { boxes } : {}) } : label,
      );
    } catch (err) {
      const error = (err as Error).message;
      await logRun(db, { kind: "snap", ok: false, model, error, ms: Date.now() - started });
      return Response.json({ error: photoError(err as Error) }, { status: 502 });
    }
  };
}

/**
 * Reads a receipt or warranty card photo for one thing, saves it with the
 * photo, and answers with when the warranty ends. Counts toward the daily
 * photo limit, like a label photo.
 */
export function receiptHandler(
  env: Env,
  verify: Verify = supabaseVerifier(env),
  fetchImpl: typeof fetch = fetch,
) {
  return async (req: Request) => {
    const arrived = Date.now();
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await verify(bearer(req));
    if (!auth) return Response.json({ error: "Sign in first." }, { status: 401 });
    let body: { item_id?: unknown; image?: unknown; force?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "Send JSON with item_id and an image." }, { status: 400 });
    }
    if (typeof body.item_id !== "string")
      return Response.json({ error: "item_id is required." }, { status: 400 });
    const match = typeof body.image === "string" ? body.image.match(DATA_URL) : null;
    if (!match?.[1] || !match[2]) {
      return Response.json({ error: "Send a JPEG, PNG or WebP photo." }, { status: 400 });
    }
    if (match[2].length * 0.75 > MAX_IMAGE_BYTES) {
      return Response.json({ error: "That photo is too big; try a smaller one." }, { status: 413 });
    }
    const db = userDb(env, auth.token);
    let item: { id: string; purchased_on: string | null };
    try {
      if ((await runsToday(db, "snap")) >= env.snapDailyLimit) {
        return Response.json(
          {
            error: `That's all the photos for today (${env.snapDailyLimit}). Type the details instead.`,
          },
          { status: 429 },
        );
      }
      if ((await modelRunsTodayAll(db)) >= env.globalDailyLimit) {
        return Response.json({ error: BUDGET_USED }, { status: 429 });
      }
      const { data, error } = await db
        .from("items")
        .select("id, purchased_on")
        .eq("id", body.item_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data)
        return Response.json({ error: "That thing isn't in your household." }, { status: 404 });
      item = data;
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 502 });
    }
    const model = env.chatModel ?? env.reader?.model ?? null;
    const started = Date.now();
    const photo = { mime: match[1], base64: match[2] };
    // The same quick look as label photos, asking for a receipt or card instead.
    const check = body.force === true ? null : await checkPhoto(env, photo, fetchImpl, "receipt");
    if (check?.retake) {
      await logRun(db, {
        kind: "snap",
        ok: true,
        model: env.router?.model ?? null,
        ms: check.ms,
        tokens_in: check.tokens_in,
        tokens_out: 0,
        item_id: item.id,
        raw_output: JSON.stringify({ photo: "receipt", retake: check.retake }),
      });
      return Response.json({ found: false, retake: check.retake });
    }
    try {
      const read = await readReceipt(env, photo, fetchImpl);
      // The same second look: a doubtful date or price is saved, but the
      // person is asked to check it against the photo. Anything read is saved
      // below, found or not, so anything read is checked.
      const reread = await checkRead(env, photo, read, "receipt", fetchImpl, arrived + BOX_BY_MS);
      const doubtful = reread?.doubtful ?? [];
      if (doubtful.length) read.unsure = true;
      await logRun(db, {
        kind: "snap",
        ok: true,
        model,
        ms: Date.now() - started,
        item_id: item.id,
        raw_output: JSON.stringify({
          photo: "receipt",
          ...read,
          ...(reread ? { check: reread } : {}),
        }),
      });
      if (!read.found && !read.purchased_on && !read.store && !read.warranty_months) {
        return Response.json({ found: false });
      }
      const saved = await saveReceipt({
        db,
        householdId: await householdId(db),
        item,
        read,
        image: photo,
      });
      return Response.json({
        ...read,
        found: true,
        saved: !!saved.receipt,
        receipt: saved.receipt,
        warranty: warrantyStatus({
          purchased_on: read.purchased_on ?? null,
          warranty_months: read.warranty_months ?? null,
          warranty_ends_on: read.warranty_ends_on ?? null,
        }),
        ...(saved.note ? { note: saved.note } : {}),
        ...(doubtful.length ? { doubtful } : {}),
        ...(reread?.boxes ? { boxes: reread.boxes } : {}),
      });
    } catch (err) {
      const error = (err as Error).message;
      await logRun(db, { kind: "snap", ok: false, model, error, ms: Date.now() - started });
      return Response.json({ error: photoError(err as Error) }, { status: 502 });
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
        const search = env.search;
        const job = (async () => {
          const found = await findManual(env, item, fetchImpl);
          // The candidates come first, so a return visit can show them without searching again.
          await logRun(db, {
            kind: "search",
            ok: true,
            model: search.provider,
            ms: Date.now() - started,
            item_id: item.id,
            raw_output: JSON.stringify(
              { query: found.query, candidates: found.candidates, tried: found.tried },
              null,
              2,
            ),
          });
          return found;
        })();
        background(job);
        const found = await job;
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
