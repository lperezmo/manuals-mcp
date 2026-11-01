import { afterEach, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { chatHandler } from "../src/http.js";
import { testAuth } from "./helpers.js";

// The display read (issue #16) in the chat: a photo with a question about
// something else, Jev's image endpoint answering 503, and the turn's wait.

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
  JEV_API_KEY: "jev_test",
});
const WASHER = "11111111-1111-1111-1111-111111111111";
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Supabase stand-in: one washer with E4 saved, and the model log. */
function fakeSupabase() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/rpc/model_runs_today_all")) return Response.json(1);
    if (url.includes("/rest/v1/items"))
      return Response.json([
        { id: WASHER, nickname: "Washer", brand: "Whirlpool", model: null, kind: "appliance" },
      ]);
    if (url.includes("/rest/v1/manual_facts"))
      return Response.json([
        {
          id: "f-e4",
          item_id: WASHER,
          kind: "error_code",
          label: "E4",
          value: "Drain error.",
          source_page: 31,
          source: "reader",
          status: "extracted",
        },
      ]);
    if (url.includes("/rest/v1/tasks")) return Response.json([]);
    if (url.includes("/rest/v1/seat_modes")) return Response.json([]);
    if (url.includes("/rest/v1/model_runs")) {
      if (init?.method === "POST") return new Response(null, { status: 201 });
      return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Jev reads E4 for sure; `about` is whether the question is about that code. */
function network(
  toMuse: unknown[],
  o: { about?: number; clear?: number; image503?: boolean; imageMs?: number },
) {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.includes("typesafe")) {
      const isImage = !!body.assets;
      // What Jev's image endpoint sometimes answers, in a few ms.
      if (isImage && o.image503)
        return Response.json({ error: "Image processing is unavailable" }, { status: 503 });
      if (isImage && o.imageMs) await wait(o.imageMs);
      if (body.questions.code)
        return Response.json({
          answers: {
            code: { choice: "f-e4", confidence: 0.98, probabilities: { "f-e4": 0.98 } },
            display: { noul: 0.97 },
            listed: { noul: 0.95 },
            clear: { noul: o.clear ?? 0.92 },
            safety: { noul: 0.02 },
            about: { noul: o.about ?? 0.95 },
          },
        });
      if (body.questions.row)
        return Response.json({
          answers: {
            row: { choice: "r1", confidence: 0.3, probabilities: { r1: 0.3 } },
            exists: { noul: 0.4 },
            intent: { choice: "ask", confidence: 0.93 },
            thing: { choice: "i1", confidence: 0.9 },
            judgment: { noul: 0.6 },
            safety: { noul: 0.02 },
          },
        });
      if (body.questions.simple)
        return Response.json({ answers: { simple: { noul: 0.1 }, yes: { noul: 0.5 } } });
    }
    toMuse.push(body);
    return Response.json({
      choices: [{ message: { content: "Muse answered." } }],
      usage: { prompt_tokens: 800, completion_tokens: 10 },
    });
  }) as unknown as typeof fetch;
}

function ask(token: string, content: string) {
  return new Request("https://manuals.example.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      messages: [{ role: "user", content }],
      image: "data:image/jpeg;base64,AAAA",
    }),
  });
}

const hasImage = (body: any) =>
  body.messages.some(
    (m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image_url"),
  );

test("a photo of a display with a question about something else goes to Muse", async () => {
  const { verify, mint } = await testAuth();
  fakeSupabase();
  const toMuse: unknown[] = [];
  const out = await (
    await chatHandler(
      env,
      verify,
      network(toMuse, { about: 0.04 }),
    )(ask(await mint(), "[photo] how often should I clean the lint filter on this?"))
  ).json();
  expect(out.reply).toBe("Muse answered.");
  expect(out.tools_used).not.toContain("fast_lane");
  expect(toMuse).toHaveLength(1);
});

test("Jev's image endpoint answering 503 fails open to Muse with the photo", async () => {
  const { verify, mint } = await testAuth();
  fakeSupabase();
  const toMuse: unknown[] = [];
  const res = await chatHandler(
    env,
    verify,
    network(toMuse, { image503: true }),
  )(ask(await mint(), "[photo] what does this mean?"));
  const out = await res.json();
  expect(res.status).toBe(200);
  expect(out.reply).toBe("Muse answered.");
  expect(toMuse).toHaveLength(1);
  expect(hasImage(toMuse[0])).toBe(true);
});

test("the display read and the photo look don't wait on each other", async () => {
  const { verify, mint } = await testAuth();
  fakeSupabase();
  const toMuse: unknown[] = [];
  const started = Date.now();
  // A blurry display, so the turn goes on to the look and Muse.
  await chatHandler(
    env,
    verify,
    network(toMuse, { clear: 0.3, imageMs: 400 }),
  )(ask(await mint(), "[photo] is the lint filter clogged?"));
  expect(toMuse).toHaveLength(1);
  // One image call's wait, not two back to back.
  expect(Date.now() - started).toBeLessThan(700);
});
