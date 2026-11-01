import { afterEach, describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { chatHandler } from "../src/http.js";
import { lookAtPhoto } from "../src/photo-check.js";
import { testAuth } from "./helpers.js";

const base = {
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
};
const env = readEnv({ ...base, JEV_API_KEY: "jev_test" });
const PHOTO = "data:image/jpeg;base64,AAAA";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Supabase stand-in: counts and logging. */
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

function ask(token: string, messages: { role: string; content: string }[], image?: string) {
  return new Request("https://manuals.example.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages, ...(image ? { image } : {}) }),
  });
}

/** Jev answers both the route and the photo look; Muse's requests are kept. */
function network(look: { simple: number; yes: number } | null, toMuse: any[], toJev: any[] = []) {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.includes("typesafe")) {
      toJev.push(body);
      if (body.questions.intent)
        return Response.json({
          answers: { intent: { type: "choice", choice: "ask", confidence: 0.9 } },
          usage: { input_tokens: 200 },
        });
      if (!look) return new Response("no", { status: 503 });
      return Response.json({
        answers: { simple: { noul: look.simple }, yes: { noul: look.yes } },
        usage: { input_tokens: 2100 },
      });
    }
    toMuse.push(body);
    return Response.json({
      choices: [{ message: { content: "The manual says to rinse it monthly." } }],
      usage: { prompt_tokens: 800, completion_tokens: 30 },
    });
  }) as unknown as typeof fetch;
}

const imageParts = (body: any) =>
  body.messages.flatMap((m: any) =>
    Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "image_url") : [],
  );

describe("photos in the chat", () => {
  test("a simple, confident look is answered by Jev and Muse gets text only", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    fakeSupabase(logged);
    const toMuse: any[] = [];
    const toJev: any[] = [];
    const res = await chatHandler(
      env,
      verify,
      network({ simple: 0.95, yes: 0.92 }, toMuse, toJev),
    )(ask(await mint(), [{ role: "user", content: "[photo] Is the lint screen clogged?" }], PHOTO));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tools_used).toEqual(["photo_check"]);
    expect(imageParts(toMuse[0])).toHaveLength(0);
    const last = toMuse[0].messages.at(-1);
    expect(last.content).toContain("Is the lint screen clogged?");
    expect(last.content).toContain("[photo, checked by Jev:");
    expect(last.content).toContain("the answer is yes (confidence 0.92)");
    const look = toJev.find((j) => j.questions.simple);
    expect(look.assets["chat-photo"]).toEqual({
      type: "image",
      format: "jpg",
      data_base64: "AAAA",
    });
    expect(logged).toHaveLength(1);
    expect(logged[0].kind).toBe("chat");
    expect(logged[0].tools_used).toContain("photo:jev 0.95/0.92");
    expect(JSON.parse(logged[0].raw_output).photo_check.tokens_in).toBe(2100);
  });

  test("reading a display goes to Muse with the image, on this turn only", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    fakeSupabase(logged);
    const toMuse: any[] = [];
    const res = await chatHandler(
      env,
      verify,
      network({ simple: 0.1, yes: 0.5 }, toMuse),
    )(
      ask(
        await mint(),
        [
          { role: "user", content: "[photo] Is the filter dirty?" },
          { role: "assistant", content: "Yes, rinse it." },
          { role: "user", content: "[photo] What does this code on the display mean?" },
        ],
        PHOTO,
      ),
    );
    expect(res.status).toBe(200);
    const parts = imageParts(toMuse[0]);
    expect(parts).toEqual([{ type: "image_url", image_url: { url: PHOTO } }]);
    expect(toMuse[0].messages.at(-1).content[0].text).toContain("What does this code");
    expect(toMuse[0].messages[1].content).toBe("[photo] Is the filter dirty?");
    expect(logged[0].tools_used).toContain("photo:muse 0.10/0.50");
  });

  test("with Jev down or unset, the photo goes straight to Muse", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    const toMuse: any[] = [];
    await chatHandler(
      env,
      verify,
      network(null, toMuse),
    )(ask(await mint(), [{ role: "user", content: "[photo] Is the light on?" }], PHOTO));
    expect(imageParts(toMuse[0])).toHaveLength(1);
    const unset: any[] = [];
    await chatHandler(
      readEnv(base),
      verify,
      network(null, unset),
    )(ask(await mint(), [{ role: "user", content: "[photo]" }], PHOTO));
    expect(imageParts(unset[0])).toHaveLength(1);
  });

  test("an unsure answer is not trusted", async () => {
    const look = await lookAtPhoto(
      env,
      { mime: "image/jpeg", base64: "AAAA" },
      "Is it frosted?",
      (async () =>
        Response.json({
          answers: { simple: { noul: 0.9 }, yes: { noul: 0.6 } },
        })) as unknown as typeof fetch,
    );
    expect(look?.finding).toBeNull();
    expect(
      await lookAtPhoto(env, { mime: "image/webp", base64: "AAAA" }, "Is it frosted?"),
    ).toBeNull();
  });

  test("refuses a file that isn't a photo, or one too big", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    const net = network(null, []);
    const token = await mint();
    const text = await chatHandler(
      env,
      verify,
      net,
    )(ask(token, [{ role: "user", content: "hi" }], "data:text/html;base64,AAAA"));
    expect(text.status).toBe(400);
    const big = await chatHandler(
      env,
      verify,
      net,
    )(
      ask(
        token,
        [{ role: "user", content: "hi" }],
        `data:image/jpeg;base64,${"A".repeat(2_800_000)}`,
      ),
    );
    expect(big.status).toBe(413);
  });
});
