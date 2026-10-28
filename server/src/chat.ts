import type { AuthInfo, CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "./env.js";
import { INSTRUCTIONS, registerTools } from "./mcp.js";

// The website's chat: Muse Spark (or any OpenAI-compatible model) with the
// same 8 tools the MCP server exposes, run as the signed-in user so RLS
// applies exactly as it does over MCP. Kept small on purpose: a few tool
// rounds, short answers, and a capped history.

const MAX_STEPS = 6;
const MAX_HISTORY = 20;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_TOOL_RESULT_CHARS = 12_000;

const CHAT_INSTRUCTIONS = `${INSTRUCTIONS}

You are Muse, answering inside the Manuals website. Answer in two to five short sentences, plain text, no markdown tables. Use the tools; never guess what a manual says. You can't browse the web here, so to add a manual the user pastes a PDF link or uploads one on the Things page.`;

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
  return tools;
}

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
});

type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatReply {
  reply: string;
  tools_used: string[];
}

export async function runChat(
  env: Env,
  auth: AuthInfo,
  history: z.infer<typeof messageSchema>["messages"],
  fetchImpl: typeof fetch = fetch,
): Promise<ChatReply> {
  const reader = env.reader;
  if (!reader) throw new Error("The chat model isn't configured (READER_* settings).");
  const tools = chatTools(env);
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
  const messages: Message[] = [
    { role: "system", content: CHAT_INSTRUCTIONS },
    ...history.slice(-MAX_HISTORY),
  ];
  const used: string[] = [];

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
        tools: definitions,
        max_tokens: 700,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`The chat model answered ${res.status}.`);
    const body = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    };
    const message = body.choices?.[0]?.message;
    const calls = message?.tool_calls ?? [];
    if (!calls.length) {
      return {
        reply: message?.content?.trim() || "Sorry, I didn't get an answer.",
        tools_used: used,
      };
    }

    messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: calls });
    for (const call of calls) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: await runTool(byName.get(call.function.name), call, ctx),
      });
      used.push(call.function.name);
    }
  }
  return {
    reply: "That took more steps than I can do at once. Could you ask a narrower question?",
    tools_used: used,
  };
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
