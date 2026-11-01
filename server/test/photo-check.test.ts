import { afterEach, describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { snapHandler } from "../src/http.js";
import { checkPhoto } from "../src/photo-check.js";
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

  test("Read it anyway skips the check and asks Muse", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    let jevAsked = false;
    const net = (async (url: string) => {
      if (url.includes("typesafe")) {
        jevAsked = true;
        return jevBody(0, 0);
      }
      return Response.json(MUSE_LABEL);
    }) as unknown as typeof fetch;
    const res = await snapHandler(env, verify, net)(snap(await mint(), { force: true }));
    expect((await res.json()).model).toBe("WTW5000DW1");
    expect(jevAsked).toBe(false);
  });
});
