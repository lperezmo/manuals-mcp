import { afterEach, describe, expect, test } from "bun:test";
import { cardSchema, describeCard } from "../src/cards.js";
import { ASK_NOW, runChat } from "../src/chat.js";
import { readEnv } from "../src/env.js";
import { chatHandler } from "../src/http.js";
import { routeTurn, toolsFor } from "../src/router.js";
import { testAuth } from "./helpers.js";

const base = {
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
};
const env = readEnv({ ...base, JEV_API_KEY: "jev_test" });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const jevSays = (choice: string, confidence: number) =>
  Response.json({
    model: "jev-1.14.0",
    answers: { intent: { type: "choice", choice, confidence, probabilities: {} } },
    usage: { input_tokens: 210, output_tokens: 3 },
  });

/** Supabase stand-in: counts, logging and one washer. */
function fakeSupabase(logged: any[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/rpc/model_runs_today_all")) return Response.json(1);
    if (url.includes("/rest/v1/model_runs")) {
      if (init?.method === "POST") {
        logged.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      }
      return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

function ask(content: string, token: string, extra: object = {}) {
  return new Request("https://manuals.example.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [{ role: "user", content }], ...extra }),
  });
}

describe("routeTurn", () => {
  test("asks Jev one choice question and reads its answer", async () => {
    let sent: any;
    const decision = await routeTurn(env, { message: "What does E4 mean?" }, (async (
      url: string,
      init: RequestInit,
    ) => {
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer jev_test");
      sent = JSON.parse(String(init.body));
      return jevSays("ask", 0.93);
    }) as unknown as typeof fetch);
    expect(sent.model).toBe("jev-latest");
    expect(sent.questions.intent.type).toBe("choice");
    expect(Object.keys(sent.questions.intent.criteria)).toContain("off_topic");
    expect(decision).toMatchObject({ route: "ask", confidence: 0.93, tokens_in: 210 });
    expect(toolsFor(decision)).toEqual([
      "list_items",
      "ask_manual",
      "car_seat_status",
      "upcoming",
      "warranty_status",
    ]);
  });

  test("falls back to every tool when unsure, down or unset", async () => {
    expect(toolsFor({ route: "ask", confidence: 0.4, ms: 1, tokens_in: 1 })).toBeNull();
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    expect(await routeTurn(env, { message: "hi" }, down)).toBeNull();
    const weird = (async () => jevSays("dance", 0.99)) as unknown as typeof fetch;
    expect(await routeTurn(env, { message: "hi" }, weird)).toBeNull();
    expect(await routeTurn(readEnv(base), { message: "hi" })).toBeNull();
  });
});

describe("chat with the router", () => {
  test("a confident off-topic message never reaches Muse", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    fakeSupabase(logged);
    let museCalled = false;
    const net = (async (url: string) => {
      if (url.includes("typesafe")) return jevSays("off_topic", 0.97);
      museCalled = true;
      return Response.json({});
    }) as unknown as typeof fetch;
    const res = await chatHandler(env, verify, net)(ask("Write my essay on Rome", await mint()));
    expect(res.status).toBe(200);
    expect((await res.json()).reply).toContain("things in your home");
    expect(museCalled).toBe(false);
    expect(logged[0]).toMatchObject({
      kind: "chat",
      model: "jev-latest",
      tools_used: ["route:off_topic 0.97"],
    });
  });

  test("Muse only sees the routed tools, and the route is logged", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    fakeSupabase(logged);
    const toMuse: any[] = [];
    const net = (async (url: string, init: RequestInit) => {
      if (url.includes("typesafe")) return jevSays("fix", 0.88);
      toMuse.push(JSON.parse(String(init.body)));
      return Response.json({ choices: [{ message: { content: "Let me check page 12." } }] });
    }) as unknown as typeof fetch;
    const res = await chatHandler(env, verify, net)(ask("The filter isn't monthly", await mint()));
    expect(res.status).toBe(200);
    expect(toMuse[0].tools.map((t: any) => t.function.name).sort()).toEqual(
      ["ask_manual", "list_items", "revise_fact", "show_card"].sort(),
    );
    expect(logged[0].tools_used).toEqual(["route:fix 0.88"]);
  });

  test("a filled form skips Jev and is treated as an answer", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    let jevCalled = false;
    const toMuse: any[] = [];
    const net = (async (url: string, init: RequestInit) => {
      if (url.includes("typesafe")) jevCalled = true;
      toMuse.push(JSON.parse(String(init.body)));
      return Response.json({ choices: [{ message: { content: "Saved." } }] });
    }) as unknown as typeof fetch;
    await chatHandler(env, verify, net)(ask("Bought: 2025-03-02", await mint(), { via: "card" }));
    expect(jevCalled).toBe(false);
    expect(toMuse[0].tools.map((t: any) => t.function.name)).toContain("update_item");
  });

  test("small talk goes to Muse with no tools at all", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    const toMuse: any[] = [];
    const net = (async (url: string, init: RequestInit) => {
      if (url.includes("typesafe")) return jevSays("smalltalk", 0.9);
      toMuse.push(JSON.parse(String(init.body)));
      return Response.json({ choices: [{ message: { content: "You're welcome!" } }] });
    }) as unknown as typeof fetch;
    await chatHandler(env, verify, net)(ask("thanks!", await mint()));
    expect(toMuse[0].tools).toBeUndefined();
  });
});

const CARD = {
  title: "About the car seat",
  fields: [
    { type: "choice", key: "for_child", label: "Who is it for?", options: ["Mia", "Someone new"] },
    { type: "number", key: "weight", label: "Their weight", units: ["lb", "kg"] },
    { type: "date", key: "made_on", label: "Date of manufacture (on the label)" },
  ],
};

describe("cards", () => {
  test("show_card ends the turn with a validated form", async () => {
    const { mint, verify } = await testAuth();
    const auth = await verify(await mint());
    const model = (async () =>
      Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: {
                    name: "show_card",
                    arguments: JSON.stringify({ message: "A few quick questions.", card: CARD }),
                  },
                },
              ],
            },
          },
        ],
      })) as unknown as typeof fetch;
    const result = await runChat(
      env,
      auth!,
      [{ role: "user", content: "set up the car seat" }],
      model,
    );
    expect(result.reply).toBe("A few quick questions.");
    expect(result.card?.fields).toHaveLength(3);
    expect(result.card?.submit).toBe("Send");
    expect(result.tools_used).toEqual(["show_card"]);
  });

  test("a bad form goes back to Muse instead of the user", async () => {
    const { mint, verify } = await testAuth();
    const auth = await verify(await mint());
    const turns: any[] = [];
    const model = (async (_u: string, init: RequestInit) => {
      turns.push(JSON.parse(String(init.body)));
      if (turns.length === 1)
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "c1",
                    type: "function",
                    function: {
                      name: "show_card",
                      arguments: JSON.stringify({
                        message: "Hi",
                        card: {
                          title: "x",
                          fields: [{ type: "html", key: "a", label: "<script>" }],
                        },
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      return Response.json({ choices: [{ message: { content: "When did you buy it?" } }] });
    }) as unknown as typeof fetch;
    const result = await runChat(env, auth!, [{ role: "user", content: "set up" }], model);
    expect(result.card).toBeUndefined();
    expect(result.reply).toBe("When did you buy it?");
    const toolMsg = turns[1].messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content).toStartWith("Invalid form");
  });

  test("rejects duplicate keys and oversize forms", () => {
    const dup = { title: "x", fields: [CARD.fields[2], CARD.fields[2]] };
    expect(cardSchema.safeParse(dup).success).toBe(false);
    const big = {
      title: "x",
      fields: Array.from({ length: 5 }, (_, i) => ({ ...CARD.fields[2], key: `k${i}` })),
    };
    expect(cardSchema.safeParse(big).success).toBe(false);
  });

  test("describes a form for the chat history", () => {
    const text = describeCard(cardSchema.parse(CARD));
    expect(text).toContain("[Form: About the car seat]");
    expect(text).toContain("Who is it for? (Mia / Someone new)");
    expect(text).toContain("Their weight (lb or kg)");
  });
});

describe("setting up a thing", () => {
  const card = (message: string) =>
    Response.json({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "c2",
                type: "function",
                function: {
                  name: "show_card",
                  arguments: JSON.stringify({ message, card: CARD }),
                },
              },
            ],
          },
        },
      ],
    });

  test("Muse saying it will ask, then stopping, still ends with a form", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    let jevCalled = false;
    const toMuse: any[] = [];
    const net = (async (url: string, init: RequestInit) => {
      if (url.includes("typesafe")) jevCalled = true;
      toMuse.push(JSON.parse(String(init.body)));
      if (toMuse.length === 1)
        return Response.json({
          choices: [
            {
              message: {
                content:
                  "Got it, let's get your Galanz Microwave set up. I'll ask a few quick things to tune its upkeep schedule.",
              },
            },
          ],
        });
      return card("When did you buy it?");
    }) as unknown as typeof fetch;
    const res = await chatHandler(
      env,
      verify,
      net,
    )(ask("Set up the Microwave with me: ask what you need to know.", await mint()));
    const body = await res.json();
    expect(jevCalled).toBe(false);
    expect(body.card?.fields).toHaveLength(3);
    expect(body.reply).toStartWith("Got it, let's get your Galanz Microwave set up.");
    expect(body.reply).toEndWith("When did you buy it?");
    expect(toMuse[0].tools.map((t: any) => t.function.name)).toContain("show_card");
    expect(toMuse[1].messages.at(-1)).toEqual({ role: "user", content: ASK_NOW });
  });

  test("a question in prose is left alone, and other turns are never pushed", async () => {
    const { mint, verify } = await testAuth();
    const auth = await verify(await mint());
    let calls = 0;
    const says = (content: string) =>
      (async () => {
        calls++;
        return Response.json({ choices: [{ message: { content } }] });
      }) as unknown as typeof fetch;
    const asked = await runChat(
      env,
      auth!,
      [{ role: "user", content: "set up" }],
      says("When did you buy it?"),
      undefined,
      null,
      { mustAsk: true },
    );
    expect(asked.reply).toBe("When did you buy it?");
    expect(calls).toBe(1);
    const plain = await runChat(
      env,
      auth!,
      [{ role: "user", content: "hi" }],
      says("I'll check that."),
    );
    expect(plain.reply).toBe("I'll check that.");
    expect(calls).toBe(2);
  });
});
