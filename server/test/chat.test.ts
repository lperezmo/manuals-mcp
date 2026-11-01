import { afterEach, describe, expect, test } from "bun:test";
import { chatTools } from "../src/chat.js";
import { readEnv } from "../src/env.js";
import { chatHandler } from "../src/http.js";
import { testAuth } from "./helpers.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function ask(content: string, token?: string) {
  return new Request("https://manuals.example.com/api/chat", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ messages: [{ role: "user", content }] }),
  });
}

describe("website chat", () => {
  test("offers the model the 9 MCP tools plus update_item and show_card", () => {
    expect(
      chatTools(env)
        .map((t) => t.name)
        .sort(),
    ).toEqual(
      [
        "add_item",
        "ask_manual",
        "car_seat_status",
        "catch_up",
        "list_items",
        "log_done",
        "record_measurement",
        "revise_fact",
        "show_card",
        "upcoming",
        "update_item",
      ].sort(),
    );
  });

  test("needs a signed-in user", async () => {
    const { verify } = await testAuth();
    const res = await chatHandler(env, verify)(ask("What do we have?"));
    expect(res.status).toBe(401);
  });

  test("runs a tool as the user, then answers", async () => {
    const { verify, mint } = await testAuth();
    const token = await mint();
    const supabaseAuth: (string | null)[] = [];
    const logged: any[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      supabaseAuth.push(new Headers(init?.headers).get("authorization"));
      if (url.includes("/rpc/ensure_household"))
        return Response.json("11111111-1111-1111-1111-111111111111");
      if (url.includes("/rpc/model_runs_today_all")) return Response.json(12);
      if (url.includes("/rest/v1/model_runs")) {
        if (init?.method === "POST") {
          logged.push(JSON.parse(String(init.body)));
          return new Response(null, { status: 201 });
        }
        return new Response(null, { status: 200, headers: { "content-range": "*/3" } });
      }
      if (url.includes("/rest/v1/items")) {
        return Response.json([
          { id: "22222222-2222-2222-2222-222222222222", nickname: "Washer", kind: "appliance" },
        ]);
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const sent: any[] = [];
    const model = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      if (sent.length === 1) {
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "list_items", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        });
      }
      return Response.json({
        choices: [{ message: { content: "You have a washer." } }],
        usage: { prompt_tokens: 900, completion_tokens: 40 },
      });
    }) as unknown as typeof fetch;

    const res = await chatHandler(env, verify, model)(ask("What do we have?", token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: "You have a washer.", tools_used: ["list_items"] });
    expect(sent[0].model).toBe("muse-spark");
    expect(sent[0].tools).toHaveLength(11);
    const toolMessage = sent[1].messages.find((m: { role: string }) => m.role === "tool");
    expect(toolMessage.content).toContain("Washer");
    expect(supabaseAuth.every((a) => a === `Bearer ${token}`)).toBe(true);
    expect(logged).toEqual([
      expect.objectContaining({
        kind: "chat",
        ok: true,
        model: "muse-spark",
        tokens_in: 900,
        tokens_out: 40,
        tools_used: ["list_items"],
      }),
    ]);
  });

  test("stops at the household's daily chat limit", async () => {
    const { verify, mint } = await testAuth();
    const token = await mint();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/rest/v1/model_runs"))
        return new Response(null, { status: 200, headers: { "content-range": "*/5" } });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    let asked = false;
    const model = (async () => {
      asked = true;
      return Response.json({});
    }) as unknown as typeof fetch;

    const limited = readEnv({
      SUPABASE_URL: "https://example-ref.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      READER_BASE_URL: "https://muse.example.com/v1",
      READER_MODEL: "muse-spark",
      CHAT_DAILY_LIMIT: "5",
    });
    const res = await chatHandler(limited, verify, model)(ask("Hi", token));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain("5 questions");
    expect(asked).toBe(false);
  });
});
