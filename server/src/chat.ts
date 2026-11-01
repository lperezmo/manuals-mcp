import type { AuthInfo, CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Card, cardSchema, describeCard } from "./cards.js";
import type { Env } from "./env.js";
import { INSTRUCTIONS, registerTools } from "./mcp.js";
import * as updateItem from "./tools/update-item.js";

// The website's chat: Muse Spark (or any OpenAI-compatible model) with the
// same 10 tools the MCP server exposes, run as the signed-in user so RLS
// applies exactly as it does over MCP. Kept small on purpose: a few tool
// rounds, short answers, and a capped history.

const MAX_STEPS = 6;
const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_TOOL_RESULT_CHARS = 12_000;

const CHAT_INSTRUCTIONS = `${INSTRUCTIONS}

You are Muse, answering inside the Manuals website. Answer in two to five short sentences, plain text, no markdown tables, no em dashes (use a comma, colon or period). Use the tools; never guess what a manual says. You can't browse the web here, so to add a manual the user pastes a PDF link or uploads one on the Things page.

Photos: the user can attach a photo (an error display, a part, a label, a filter). Say what you see, match it to their things with list_items, and check the manual with ask_manual before giving steps. Older photos show as [photo] in the history; you can't see them anymore. A note like [photo, checked by Jev: ...] means a quick image checker already looked at the photo for you: trust its answer and add what the manual says.

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
  registerTools(collector as unknown as McpServer, env);
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
  /** "card" when the message is a filled form: it is answering Muse, no need to route it. */
  via: z.enum(["card"]).optional(),
  /** A photo (data URL) for the last message only; earlier turns keep "[photo]" as text. */
  image: z.string().max(3_000_000).optional(),
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
}

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
  } = {},
): Promise<ChatReply> {
  const reader = env.reader;
  if (!reader) throw new Error("The chat model isn't configured (READER_* settings).");
  const offered = only ? new Set(only.length ? [...only, SHOW_CARD.name] : []) : null;
  const tools = chatTools(env).filter((t) => !offered || offered.has(t.name));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const definitions = tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema, { io: "input" }),
    },
  }));
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
  const messages: Message[] = [{ role: "system", content: CHAT_INSTRUCTIONS }, ...recent];
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
        max_tokens: 1200,
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
      };
    }

    messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: calls });
    let card: { message: string; card: Card } | undefined;
    for (const call of calls) {
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
      return { reply, tools_used: used, card: card.card };
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
