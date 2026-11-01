import { afterEach, describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { receiptHandler, snapHandler } from "../src/http.js";
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

  test("a model read with found false still gets the second look", async () => {
    // The wizard goes on with a brand or model even when Muse says found: false.
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    const muse = {
      choices: [{ message: { content: JSON.stringify({ found: false, model: "WTW5000DW1" }) } }],
    };
    const net = (async (url: string, init: RequestInit) => {
      if (!url.includes("typesafe")) return Response.json(muse);
      const sent = JSON.parse(String(init.body));
      if ("sharp" in sent.questions) return jevBody(0.95, 0.9);
      return Response.json({ answers: { model: { noul: 0.03 } } });
    }) as unknown as typeof fetch;
    const out = await (await snapHandler(env, verify, net)(snap(await mint()))).json();
    expect(out).toMatchObject({ model: "WTW5000DW1", unsure: true, doubtful: ["model"] });
  });

  test("Jev failing on the second look leaves the read as it was", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    const net = (async (url: string, init: RequestInit) => {
      if (!url.includes("typesafe")) return Response.json(MUSE_LABEL);
      const sent = JSON.parse(String(init.body));
      if ("sharp" in sent.questions) return jevBody(0.95, 0.9);
      throw new Error("The operation timed out.");
    }) as unknown as typeof fetch;
    const res = await snapHandler(env, verify, net)(snap(await mint()));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ found: true, model: "WTW5000DW1", unsure: false });
    expect(out.doubtful).toBeUndefined();
  });
});

describe("receipt with the second look", () => {
  const ITEM = { id: "22222222-2222-2222-2222-222222222222", purchased_on: null };
  function fakeSupabase(saved: any[]) {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const path = new URL(url).pathname;
      const method = init?.method ?? "GET";
      if (path.endsWith("/rpc/model_runs_today_all")) return Response.json(0);
      if (path.endsWith("/rpc/ensure_household"))
        return Response.json("11111111-1111-1111-1111-111111111111");
      if (path.endsWith("/model_runs")) {
        if (method === "POST") return new Response(null, { status: 201 });
        return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
      }
      if (path.endsWith("/items")) {
        if (method === "PATCH") return new Response(null, { status: 204 });
        return Response.json(ITEM);
      }
      if (path.includes("/storage/v1/object/receipts")) return Response.json({ Key: "x" });
      if (path.endsWith("/receipts")) {
        const body = JSON.parse(String(init?.body));
        saved.push(body);
        return Response.json({ ...body, created_at: "2026-10-31T00:00:00Z" });
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
  }
  const post = (token: string) =>
    new Request("https://manuals.example.com/api/receipt", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ item_id: ITEM.id, image: "data:image/jpeg;base64,AAAA" }),
    });
  const museSays = (read: object) => ({
    choices: [{ message: { content: JSON.stringify(read) } }],
  });
  const READ = { found: true, store: "Appliance Barn", purchased_on: "2026-06-01", price: 649 };

  test("a doubtful date is saved and flagged", async () => {
    const { verify, mint } = await testAuth();
    const saved: any[] = [];
    fakeSupabase(saved);
    const net = (async (url: string, init: RequestInit) => {
      if (!url.includes("typesafe")) return Response.json(museSays(READ));
      const sent = JSON.parse(String(init.body));
      if ("sharp" in sent.questions) return jevBody(0.95, 0.9);
      return Response.json({
        answers: { store: { noul: 0.9 }, purchased_on: { noul: 0.02 }, price: { noul: 0.8 } },
      });
    }) as unknown as typeof fetch;
    const out = await (await receiptHandler(env, verify, net)(post(await mint()))).json();
    expect(out).toMatchObject({ saved: true, unsure: true, doubtful: ["purchased_on"] });
    expect(saved[0]).toMatchObject({ purchased_on: "2026-06-01" });
  });

  test("Jev down on the second look still saves the receipt", async () => {
    const { verify, mint } = await testAuth();
    const saved: any[] = [];
    fakeSupabase(saved);
    const net = (async (url: string, init: RequestInit) => {
      if (!url.includes("typesafe")) return Response.json(museSays(READ));
      const sent = JSON.parse(String(init.body));
      if ("sharp" in sent.questions) return jevBody(0.95, 0.9);
      return new Response("busy", { status: 503 });
    }) as unknown as typeof fetch;
    const res = await receiptHandler(env, verify, net)(post(await mint()));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ saved: true, unsure: false });
    expect(out.doubtful).toBeUndefined();
    expect(saved).toHaveLength(1);
  });

  test("a date read with found false is still checked before it's saved", async () => {
    // The handler saves a date or store even when Muse says found: false.
    const { verify, mint } = await testAuth();
    const saved: any[] = [];
    fakeSupabase(saved);
    const asked: string[][] = [];
    const net = (async (url: string, init: RequestInit) => {
      if (!url.includes("typesafe")) {
        return Response.json(museSays({ found: false, purchased_on: "2026-06-01" }));
      }
      const sent = JSON.parse(String(init.body));
      if ("sharp" in sent.questions) return jevBody(0.95, 0.9);
      asked.push(Object.keys(sent.questions));
      return Response.json({ answers: { purchased_on: { noul: 0.01 } } });
    }) as unknown as typeof fetch;
    const out = await (await receiptHandler(env, verify, net)(post(await mint()))).json();
    expect(asked).toEqual([["purchased_on"]]);
    expect(out).toMatchObject({ saved: true, doubtful: ["purchased_on"] });
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
