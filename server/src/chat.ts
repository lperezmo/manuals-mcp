import type { AuthInfo, CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Card, cardSchema, describeCard } from "./cards.js";
import type { Env } from "./env.js";
import { today } from "./lib/schedule.js";
import { INSTRUCTIONS, registerTools } from "./mcp.js";
import * as updateItem from "./tools/update-item.js";

// The website's chat: Muse Spark (or any OpenAI-compatible model) with the
// same tools the MCP server exposes (less the upload slot), run as the
// signed-in user so RLS applies exactly as it does over MCP. Kept small on
// purpose: a few tool rounds, short answers, and a capped history.

const MAX_STEPS = 6;
const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_TOOL_RESULT_CHARS = 12_000;

const CHAT_INSTRUCTIONS = `${INSTRUCTIONS}

You are Muse, answering inside the Manuals website. Answer in two to five short sentences, plain text, no markdown tables, no em dashes (use a comma, colon or period). Use the tools; never guess what a manual says. You can't browse the web here, so to add a manual the user pastes a PDF link or uploads one on the Things page.

Photos: the user can attach a photo (an error display, a part, a label, a filter). Say what you see, match it to their things with list_items, and check the manual with ask_manual before giving steps. Point at parts by how they look and where they sit ("the round cup in the middle of the mesh"), not only by the manual's name: a manual's "upper" and "lower" often aren't what the owner sees. When they ask which part is which, where something is, or aren't sure what they're looking at, call mark_photo to circle it on their photo, then answer in a few lines. Without a photo, when they ask where a part is or how to get at it, find the page with ask_manual, then call show_diagram so they see the manual's drawing with it circled. Older photos show as [photo] in the history; you can't see them anymore. A note like [photo, checked by Jev: ...] means a quick image checker already looked at the photo for you: trust its answer and add what the manual says.

Some manuals are printed in only one language other than English. Search them with ask_manual in that language's words ("filtro" for a Spanish manual's filter) when English words find nothing, and always answer in English, quoting the page.
A note like [jev hint: ...] under the user's message is a quick matcher's guess at which thing they mean (with its item id) and which saved lines may answer it. Use the item id with ask_manual instead of calling list_items first, check the lines against what the tools return, and never mention the hint. After an instant answer (a reply that quotes one saved line and its page), "Tell me more" asks you to go further: read the manual around that page and add what helps.

Forms: when you need details from the user, call show_card instead of asking in prose. It shows a small form (date, number with units, choice, checklist, text) under your message and ends your turn; the answers come back as the user's next message, then save them with the tools. Never say you will ask something and then stop: call show_card in the same turn. Never mention show_card or any tool by name.

Answers in their own words count. If the user types an answer instead of filling the form ("a year ago, a lot"), take it: turn rough answers into a best estimate (a lot of use is about 7 a week), save it, and move on. Never show the same form again, and never ask for an exact date someone gave roughly; most people don't remember one. A field answered "(skipped)" stays skipped.

Setting up a thing (the user says "set up" or "tell you about" it): call list_items and upcoming for it, then ask with as few cards as you can, one card at a time. Car seat: who it's for (offer the household's children, or ask the child's name, birth date, weight and height), and the date of manufacture from the seat's label (exact dates). Appliance: one card with four fields: when it was bought (a rough date), how often it's used a week, "Is it new?" (choice: Brand new / Used for a while / Coming out of storage), and "What has been done to it so far?" (text, e.g. cleaned the filter, a repair, nothing). Save with update_item and record_measurement; unless it's brand new, call catch_up with what they said (condition used or stored, age_years, done). Last, if it has many upkeep tasks, offer a checklist card of them (task ids as values, all checked) so the user can untick ones they don't need; turn unticked ones off with revise_fact (type task, active false). Then sum up in two sentences.`;

type ToolHandler = (input: unknown, ctx: unknown) => Promise<CallToolResult>;

interface ChatTool {
  name: string;
  description: string;
  schema: z.ZodType;
  handler: ToolHandler;
}

/** Collects the MCP tools by registering them on a stand-in server. */
export function chatTools(env: Env): ChatTool[] {
  const tools: ChatTool[] = [];
  const collector = {
    registerTool(
      name: string,
      config: { description?: string; inputSchema: z.ZodType },
      handler: ToolHandler,
    ) {
      tools.push({
        name,
        description: config.description ?? "",
        schema: config.inputSchema,
        handler,
      });
    },
  };
  registerTools(collector as unknown as McpServer, env, "chat");
  updateItem.register(collector as unknown as McpServer, env);
  tools.push(SHOW_CARD);
  return tools;
}

const showCardSchema = z.object({
  message: z.string().trim().min(1).max(600).describe("What you say above the form."),
  card: cardSchema,
});

/** Chat-only: ends the turn with a form under Muse's message. Never writes anything. */
const SHOW_CARD: ChatTool = {
  name: "show_card",
  description:
    "Shows the user a small form under your message and ends your turn. Use it to ask for dates, numbers with units, a choice, or a checklist. Up to 4 fields.",
  schema: showCardSchema,
  handler: async () => ({ content: [{ type: "text", text: "Shown." }] }),
};

export const messageSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(MAX_MESSAGE_CHARS),
      }),
    )
    .min(1)
    .max(60),
  /**
   * "card" when the message is a filled form: it is answering Muse, no need to route it.
   * "more" when the person tapped "Tell me more" under an instant answer: Muse answers.
   */
  via: z.enum(["card", "more"]).optional(),
  /** A photo (data URL) for the last message only; earlier turns keep "[photo]" as text. */
  image: z.string().max(3_000_000).optional(),
  /**
   * The page's id for this turn. The reply is saved with it, so a page the
   * phone paused (another app, screen off) can pick the answer up later.
   */
  turn: z.uuid().optional(),
});

/** A photo on this turn, already checked by the caller. */
export interface ChatImage {
  mime: string;
  base64: string;
}

/** What Muse is told when it says it will ask but stops before showing a form. */
export const ASK_NOW =
  "Ask your first question now with show_card. Don't announce it, just call show_card.";

type Message =
  | { role: "system"; content: string }
  | {
      role: "user";
      content:
        | string
        | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
    }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatUsage {
  model: string;
  tokens_in: number;
  tokens_out: number;
}

export interface ChatReply {
  reply: string;
  tools_used: string[];
  card?: Card;
  /** The person's photo with the part circled (a JPEG data URL), when Muse marked it. */
  marked?: string;
  /** The manual's own drawing of the part, circled, when Muse showed one. */
  diagram?: { image: string; page: number; circled: boolean };
}

/**
 * The manual's own drawing of a part, with the part circled on the real page
 * (diagram.ts). The caller finds the PDF and the drawing.
 */
export const SHOW_DIAGRAM = {
  name: "show_diagram",
  description:
    "Show the manual's own drawing of a part, with the part circled, after ask_manual found the page about it. Use it when the user asks where a part is, what it looks like, or how to remove or reach it. Not for error codes, specs or schedules. The user sees the drawing above your answer.",
  schema: z.object({
    item: z.string().min(1).describe("The item's id or name, as ask_manual reported it."),
    page: z.number().int().min(1).describe("The manual page ask_manual cited for this part."),
    part: z
      .string()
      .min(3)
      .max(120)
      .describe(
        'The part as the manual names it, plus how it looks: "the upper filter assembly (the round cup filter)".',
      ),
  }),
};

export type DiagramFn = (
  args: z.infer<typeof SHOW_DIAGRAM.schema>,
) => Promise<{ image: string; page: number; circled: boolean } | { error: string }>;

/**
 * Offered only on a turn with a photo: Meta's image model circles the part
 * on the person's own photo. The caller does the call, the cap and the log.
 */
export const MARK_PHOTO = {
  name: "mark_photo",
  description:
    "Circle a part on the photo the user just sent, so they can see exactly which one you mean. Use it when they ask where something is, which part is which, or seem unsure what they're looking at. Describe the one part by how it looks and where it sits in the photo. The user sees the marked photo above your answer.",
  schema: z.object({
    instruction: z
      .string()
      .min(5)
      .max(300)
      .describe(
        'What to circle, by look and place: "Circle the round gray cup in the middle of the mesh, right of the spray arm".',
      ),
  }),
};

/** Marks the turn's photo: the marked JPEG, or why not (shown to Muse, which answers in words). */
export type MarkFn = (instruction: string) => Promise<{ image: string } | { error: string }>;

export async function runChat(
  env: Env,
  auth: AuthInfo,
  history: z.infer<typeof messageSchema>["messages"],
  fetchImpl: typeof fetch = fetch,
  /** Filled in as the model answers, so the caller can log it even after a failure. */
  usage?: ChatUsage,
  /** Tool names to offer (from the router), or null/undefined for all of them. */
  only?: string[] | null,
  opts: {
    /** A photo for the last user message. */
    image?: ChatImage;
    /** Setting up a thing: the turn must end with a form or a question, not a promise of one. */
    mustAsk?: boolean;
    /** Background about this household (house memory), added after the instructions. */
    context?: string | null;
    /** Marks the turn's photo; offered as mark_photo when set. */
    mark?: MarkFn;
    /** Shows a manual drawing; offered as show_diagram when set. */
    diagram?: DiagramFn;
  } = {},
): Promise<ChatReply> {
  const reader = env.reader;
  if (!reader) throw new Error("The chat model isn't configured (READER_* settings).");
  const offered = only ? new Set(only.length ? [...only, SHOW_CARD.name] : []) : null;
  const tools = chatTools(env).filter((t) => !offered || offered.has(t.name));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const extra = [
    ...(opts.mark ? [MARK_PHOTO] : []),
    ...(opts.diagram && byName.has("ask_manual") ? [SHOW_DIAGRAM] : []),
  ];
  const definitions = [...tools, ...extra].map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema, { io: "input" }),
    },
  }));
  let marked: string | undefined;
  let diagram: ChatReply["diagram"];
  /** One drawing per turn, like the marked photo. */
  const diagramOnce = async (call: ToolCall): Promise<string> => {
    let raw: unknown = {};
    try {
      raw = JSON.parse(call.function.arguments || "{}");
    } catch {}
    const args = SHOW_DIAGRAM.schema.safeParse(raw);
    if (!args.success) return `Invalid arguments: ${args.error.message}`;
    if (diagram) return "A drawing is already shown this turn.";
    let out: Awaited<ReturnType<DiagramFn>>;
    try {
      out = (await opts.diagram?.(args.data)) ?? { error: "not available" };
    } catch (err) {
      out = { error: (err as Error).message };
    }
    if ("error" in out)
      return `Couldn't show the drawing: ${out.error}. Describe where it is in words.`;
    diagram = out;
    used.push(SHOW_DIAGRAM.name);
    return out.circled
      ? `Shown: the drawing from page ${out.page} with the part circled. Answer briefly; don't repeat the page number.`
      : `Shown: the drawing from page ${out.page}, but the part couldn't be pinpointed in it, so say which part of the drawing to look at.`;
  };
  /** One marked photo per turn; Muse is told how it went and answers in words either way. */
  const markOnce = async (call: ToolCall): Promise<string> => {
    let raw: unknown = {};
    try {
      raw = JSON.parse(call.function.arguments || "{}");
    } catch {}
    const args = MARK_PHOTO.schema.safeParse(raw);
    if (!args.success) return `Invalid arguments: ${args.error.message}`;
    if (marked) return "The photo is already marked this turn.";
    const out = await opts.mark?.(args.data.instruction);
    if (!out || !("image" in out))
      return `Couldn't mark the photo: ${out?.error ?? "not available"}. Say where it is in words.`;
    marked = out.image;
    used.push(MARK_PHOTO.name);
    return "Marked. The user sees their photo with it circled above your answer; say what it is and what to do, briefly.";
  };
  const ctx = { http: { authInfo: auth } };
  const recent: Message[] = history.slice(-MAX_HISTORY);
  const last = recent[recent.length - 1];
  if (opts.image && last?.role === "user" && typeof last.content === "string") {
    // Only this turn carries the picture; the client keeps "[photo]" in history.
    recent[recent.length - 1] = {
      role: "user",
      content: [
        { type: "text", text: last.content },
        {
          type: "image_url",
          image_url: { url: `data:${opts.image.mime};base64,${opts.image.base64}` },
        },
      ],
    };
  }
  // Muse doesn't know the date on its own; without it "a week ago" lands in May.
  const dated = `${CHAT_INSTRUCTIONS}\n\nToday is ${today()}.`;
  const system = opts.context ? `${dated}\n\n${opts.context}` : dated;
  const messages: Message[] = [{ role: "system", content: system }, ...recent];
  const used: string[] = [];
  // Set when Muse stopped on a promise to ask and was told to show the form.
  let intro = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetchImpl(`${reader.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(reader.apiKey ? { authorization: `Bearer ${reader.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: env.chatModel ?? reader.model,
        messages,
        ...(definitions.length ? { tools: definitions } : {}),
        // Muse's thinking counts here too; too low a cap cuts a long answer off.
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`The chat model answered ${res.status}.`);
    const body = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (usage) {
      usage.tokens_in += body.usage?.prompt_tokens ?? 0;
      usage.tokens_out += body.usage?.completion_tokens ?? 0;
    }
    const message = body.choices?.[0]?.message;
    const calls = message?.tool_calls ?? [];
    if (!calls.length) {
      const reply = message?.content?.trim() ?? "";
      // Muse sometimes says "I'll ask a few quick things" and stops. In a
      // setup turn that leaves the user with nothing to answer, so tell it
      // once to show the form, and keep what it said above the form.
      if (opts.mustAsk && !intro && byName.has(SHOW_CARD.name) && !reply.includes("?")) {
        intro = reply || " ";
        if (reply) messages.push({ role: "assistant", content: reply });
        messages.push({ role: "user", content: ASK_NOW });
        continue;
      }
      return {
        reply:
          [intro.trim(), reply].filter(Boolean).join("\n\n") || "Sorry, I didn't get an answer.",
        tools_used: used,
        ...(marked ? { marked } : {}),
        ...(diagram ? { diagram } : {}),
      };
    }

    messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: calls });
    let card: { message: string; card: Card } | undefined;
    for (const call of calls) {
      if (call.function.name === SHOW_DIAGRAM.name && opts.diagram && byName.has("ask_manual")) {
        messages.push({ role: "tool", tool_call_id: call.id, content: await diagramOnce(call) });
        continue;
      }
      if (call.function.name === MARK_PHOTO.name && opts.mark) {
        messages.push({ role: "tool", tool_call_id: call.id, content: await markOnce(call) });
        continue;
      }
      if (call.function.name === SHOW_CARD.name && byName.has(SHOW_CARD.name)) {
        const parsed = parseCard(call.function.arguments);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "error" in parsed ? `Invalid form: ${parsed.error}` : "Shown.",
        });
        if (!("error" in parsed)) {
          card = parsed;
          used.push(call.function.name);
        }
        continue;
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: await runTool(byName.get(call.function.name), call, ctx),
      });
      used.push(call.function.name);
    }
    if (card) {
      const reply = [intro.trim(), card.message].filter(Boolean).join("\n\n");
      return {
        reply,
        tools_used: used,
        card: card.card,
        ...(marked ? { marked } : {}),
        ...(diagram ? { diagram } : {}),
      };
    }
  }
  return {
    reply: "That took more steps than I can do at once. Could you ask a narrower question?",
    tools_used: used,
  };
}

function parseCard(args: string): { message: string; card: Card } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(args || "{}");
  } catch {
    return { error: "the arguments weren't valid JSON." };
  }
  const parsed = showCardSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message.slice(0, 1_000) };
  return parsed.data;
}

/** The history text for an assistant reply with a form, so Muse remembers what it asked. */
export function withCard(reply: string, card?: Card): string {
  return card ? `${reply}\n\n${describeCard(card)}` : reply;
}

async function runTool(tool: ChatTool | undefined, call: ToolCall, ctx: unknown): Promise<string> {
  if (!tool) return `No tool called ${call.function.name}.`;
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return "The arguments weren't valid JSON.";
  }
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) return `Invalid arguments: ${parsed.error.message}`;
  const result = await tool.handler(parsed.data, ctx);
  const text = result.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .join("\n")
    .slice(0, MAX_TOOL_RESULT_CHARS);
  return result.isError ? `Error: ${text}` : text;
}

export interface ToolOutcome {
  ok: boolean;
  summary: string;
  data?: unknown;
}

/** Runs one tool for the website's buttons, as the signed-in user. */
export async function callTool(
  env: Env,
  auth: AuthInfo,
  name: string,
  args: unknown,
): Promise<ToolOutcome> {
  const tool = chatTools(env).find((t) => t.name === name);
  if (!tool) return { ok: false, summary: `No tool called ${name}.` };
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) return { ok: false, summary: `Invalid arguments: ${parsed.error.message}` };
  const result = await tool.handler(parsed.data, { http: { authInfo: auth } });
  const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  // Tool replies are one sentence, a blank line, then JSON (see reply()).
  const split = text.indexOf("\n\n");
  let data: unknown;
  if (split > 0) {
    try {
      data = JSON.parse(text.slice(split + 2));
    } catch {}
  }
  return {
    ok: !result.isError,
    summary: data === undefined ? text : text.slice(0, split),
    data,
  };
}
