import { afterEach, describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { chatHandler } from "../src/http.js";
import { testAuth } from "./helpers.js";

// A phone that pauses the page mid-turn never gets the reply; the page picks it
// up later from model_runs by its turn id. So the reply must be saved there.
const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
});
const TURN = "0b6f2a43-6c2e-4e5f-9b1a-2f6c1d1e9a77";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

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
    return Response.json([]);
  }) as typeof fetch;
}

function ask(token: string, turn?: string) {
  return new Request("https://manuals.example.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messages: [{ role: "user", content: "How often should I clean the filter?" }],
      ...(turn ? { turn } : {}),
    }),
  });
}

const muse = (async () =>
  Response.json({
    choices: [{ message: { content: "Every month, says page 12." } }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  })) as unknown as typeof fetch;

describe("a chat turn the page can pick up later", () => {
  test("the reply is saved with the page's turn id", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    fakeSupabase(logged);
    const res = await chatHandler(env, verify, muse)(ask(await mint(), TURN));
    expect(res.status).toBe(200);
    const run = logged.find((r) => r.kind === "chat");
    const saved = JSON.parse(run.raw_output);
    expect(saved.turn).toBe(TURN);
    expect(saved.reply).toBe("Every month, says page 12.");
    expect(Array.isArray(saved.tools_used)).toBe(true);
  });

  test("without a turn id nothing extra is saved", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    fakeSupabase(logged);
    await chatHandler(env, verify, muse)(ask(await mint()));
    expect(logged.find((r) => r.kind === "chat").raw_output).toBeNull();
  });

  test("a turn id that isn't a uuid is refused", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    const res = await chatHandler(env, verify, muse)(ask(await mint(), "not-a-uuid"));
    expect(res.status).toBe(400);
  });
});
