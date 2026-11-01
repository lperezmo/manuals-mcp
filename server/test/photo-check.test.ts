import { afterEach, describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { snapHandler } from "../src/http.js";
import { checkPhoto, checkRead, DOUBT_BELOW } from "../src/photo-check.js";
import { testAuth } from "./helpers.js";

const base = {
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
};
const env = readEnv({ ...base, JEV_API_KEY: "jev_test" });
const PHOTO = { mime: "image/jpeg", base64: "AAAA" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const jevBody = (label: number, sharp: number) =>
  Response.json({
    answers: { label: { type: "noul", noul: label }, sharp: { type: "noul", noul: sharp } },
    usage: { input_tokens: 2128 },
  });
const jev = (label: number, sharp: number) =>
  (async () => jevBody(label, sharp)) as unknown as typeof fetch;

describe("checkPhoto", () => {
  test("sends the image as an asset with the images header", async () => {
    let sent: any;
    let headers: Headers | undefined;
    await checkPhoto(env, PHOTO, (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      headers = new Headers(init.headers);
      return jevBody(0.9, 0.9);
    }) as unknown as typeof fetch);
    expect(headers?.get("TypeSafe-Danger-Zone-Images")).toBe("true");
    expect(sent.assets["label-photo"]).toEqual({
      type: "image",
      format: "jpg",
      data_base64: "AAAA",
    });
    expect(Object.keys(sent.questions)).toEqual(["label", "sharp"]);
  });

  test("only a confident no asks for a retake", async () => {
    expect((await checkPhoto(env, PHOTO, jev(0.07, 0.9)))?.retake).toBe("no_label");
    expect((await checkPhoto(env, PHOTO, jev(0.53, 0.01)))?.retake).toBe("blurry");
    expect((await checkPhoto(env, PHOTO, jev(0.99, 0.59)))?.retake).toBeNull();
  });

  test("lets the photo through when Jev is unset, down, or the format is WebP", async () => {
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    expect(await checkPhoto(env, PHOTO, down)).toBeNull();
    expect(await checkPhoto(readEnv(base), PHOTO, jev(0, 0))).toBeNull();
    expect(await checkPhoto(env, { ...PHOTO, mime: "image/webp" }, jev(0, 0))).toBeNull();
  });
});

describe("snap with the photo check", () => {
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

  const snap = (token: string, extra: object = {}) =>
    new Request("https://manuals.example.com/api/snap", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ image: "data:image/jpeg;base64,AAAA", ...extra }),
    });

  const MUSE_LABEL = {
    choices: [
      {
        message: {
          content: JSON.stringify({ found: true, brand: "Whirlpool", model: "WTW5000DW1" }),
        },
      },
    ],
  };

  test("a blurry photo comes back without asking Muse", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    fakeSupabase(logged);
    let museAsked = false;
    const net = (async (url: string) => {
      if (url.includes("typesafe")) return jevBody(0.5, 0.01);
      museAsked = true;
      return Response.json(MUSE_LABEL);
    }) as unknown as typeof fetch;
    const res = await snapHandler(env, verify, net)(snap(await mint()));
    expect(await res.json()).toEqual({ found: false, retake: "blurry" });
    expect(museAsked).toBe(false);
    expect(logged[0]).toMatchObject({ kind: "snap", model: "jev-latest", tokens_in: 2128 });
  });

  test("Read it anyway skips the photo check and asks Muse", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    const asked: string[][] = [];
    const net = (async (url: string, init: RequestInit) => {
      if (url.includes("typesafe")) {
        const sent = JSON.parse(String(init.body));
        asked.push(Object.keys(sent.questions));
        return Response.json({
          answers: { brand: { noul: 0.97 }, model: { noul: 0.93 } },
        });
      }
      return Response.json(MUSE_LABEL);
    }) as unknown as typeof fetch;
    const res = await snapHandler(env, verify, net)(snap(await mint(), { force: true }));
    const out = await res.json();
    expect(out.model).toBe("WTW5000DW1");
    expect(out.doubtful).toBeUndefined();
    // Only the second look at what Muse read, not the label/sharp check.
    expect(asked).toEqual([["brand", "model"]]);
  });

  test("a model number Jev doubts sends the wizard to check it", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    fakeSupabase(logged);
    const net = (async (url: string, init: RequestInit) => {
      if (!url.includes("typesafe")) return Response.json(MUSE_LABEL);
      const sent = JSON.parse(String(init.body));
      if ("sharp" in sent.questions) return jevBody(0.95, 0.9);
      return Response.json({
        answers: { brand: { noul: 0.96 }, model: { noul: 0.04 } },
        usage: { input_tokens: 2200 },
      });
    }) as unknown as typeof fetch;
    const res = await snapHandler(env, verify, net)(snap(await mint()));
    const out = await res.json();
    expect(out).toMatchObject({ model: "WTW5000DW1", unsure: true, doubtful: ["model"] });
    expect(JSON.parse(logged.at(-1).raw_output).check.scores).toEqual({ brand: 0.96, model: 0.04 });
  });
});

describe("checkRead", () => {
  const answers = (scores: Record<string, number>) =>
    (async () =>
      Response.json({
        answers: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { noul: v }])),
        usage: { input_tokens: 2300 },
      })) as unknown as typeof fetch;

  test("asks one question per value read, with the photo sent once", async () => {
    let sent: any;
    let headers: Headers | undefined;
    await checkRead(
      env,
      PHOTO,
      { found: true, brand: "GE", model: "GSWWD09S1A09B", serial: null, unsure: false },
      "label",
      (async (_u: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        headers = new Headers(init.headers);
        return Response.json({ answers: {} });
      }) as unknown as typeof fetch,
    );
    expect(headers?.get("TypeSafe-Danger-Zone-Images")).toBe("true");
    expect(Object.keys(sent.assets)).toEqual(["label-read"]);
    expect(Object.keys(sent.questions)).toEqual(["brand", "model"]);
    expect(sent.questions.model.instructions).toContain('"GSWWD09S1A09B"');
  });

  test("marks only confident noes on a receipt as doubtful", async () => {
    const read = {
      found: true,
      store: "Appliance Barn",
      purchased_on: "2026-06-01",
      price: 649,
      warranty_months: 24,
    };
    const check = await checkRead(
      env,
      PHOTO,
      read,
      "receipt",
      answers({ store: 0.9, purchased_on: 0.08, price: DOUBT_BELOW, warranty_months: 0.31 }),
    );
    expect(check?.doubtful).toEqual(["purchased_on"]);
    expect(check?.tokens_in).toBe(2300);
  });

  test("leaves the read alone when Jev is unset, down, WebP or there's nothing to check", async () => {
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const read = { model: "WTW5000DW1" };
    expect(await checkRead(env, PHOTO, read, "label", down)).toBeNull();
    expect(await checkRead(readEnv(base), PHOTO, read, "label", answers({ model: 0 }))).toBeNull();
    expect(
      await checkRead(env, { ...PHOTO, mime: "image/webp" }, read, "label", answers({ model: 0 })),
    ).toBeNull();
    expect(await checkRead(env, PHOTO, { model: " " }, "label", answers({ model: 0 }))).toBeNull();
  });
});
