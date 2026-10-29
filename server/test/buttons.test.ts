import { afterEach, describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { snapHandler, toolHandler } from "../src/http.js";
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

function post(path: string, body: unknown, token?: string) {
  return new Request(`https://manuals.example.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("/api/tool", () => {
  test("needs a signed-in user", async () => {
    const { verify } = await testAuth();
    const res = await toolHandler(env, verify)(post("/api/tool", { name: "list_items" }));
    expect(res.status).toBe(401);
  });

  test("runs a tool and splits its summary from its data", async () => {
    const { verify, mint } = await testAuth();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/rpc/ensure_household"))
        return Response.json("11111111-1111-1111-1111-111111111111");
      if (url.includes("/rest/v1/items")) {
        return Response.json([{ id: "22222222-2222-2222-2222-222222222222", nickname: "Washer" }]);
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const res = await toolHandler(
      env,
      verify,
    )(post("/api/tool", { name: "list_items", args: {} }, await mint()));
    const body = (await res.json()) as {
      ok: boolean;
      summary: string;
      data: { nickname: string }[];
    };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.summary).toBe("1 item in this household.");
    expect(body.data[0]?.nickname).toBe("Washer");
  });

  test("rejects bad arguments without running anything", async () => {
    const { verify, mint } = await testAuth();
    const res = await toolHandler(
      env,
      verify,
    )(post("/api/tool", { name: "revise_fact", args: { id: "nope" } }, await mint()));
    expect(res.status).toBe(422);
  });
});

function usage(today: number, all: number, logged: any[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/rpc/model_runs_today_all")) return Response.json(all);
    if (url.includes("/rest/v1/model_runs")) {
      if (init?.method === "POST") {
        logged.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      }
      return new Response(null, { status: 200, headers: { "content-range": `*/${today}` } });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

describe("/api/snap", () => {
  test("reads a label photo with the reader model", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    usage(0, 0, logged);
    let sent: any;
    const model = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                found: true,
                brand: "Brightwash",
                model: "BW-4100",
                category: "washer",
                kind: "appliance",
                nickname: "Washer",
              }),
            },
          },
        ],
      });
    }) as unknown as typeof fetch;
    const res = await snapHandler(
      env,
      verify,
      model,
    )(post("/api/snap", { image: "data:image/jpeg;base64,AAAA" }, await mint()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ found: true, brand: "Brightwash", model: "BW-4100" });
    expect(sent.messages[1].content[1].image_url.url).toBe("data:image/jpeg;base64,AAAA");
    expect(logged).toEqual([expect.objectContaining({ kind: "snap", ok: true })]);
  });

  test("stops at the household's daily photo limit", async () => {
    const { verify, mint } = await testAuth();
    usage(20, 20);
    let asked = false;
    const model = (async () => {
      asked = true;
      return Response.json({});
    }) as unknown as typeof fetch;
    const res = await snapHandler(
      env,
      verify,
      model,
    )(post("/api/snap", { image: "data:image/jpeg;base64,AAAA" }, await mint()));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain("20");
    expect(asked).toBe(false);
  });

  test("stops when the site-wide budget is used up", async () => {
    const { verify, mint } = await testAuth();
    usage(0, 400);
    const res = await snapHandler(
      env,
      verify,
    )(post("/api/snap", { image: "data:image/jpeg;base64,AAAA" }, await mint()));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain("budget");
  });

  test("refuses anything that isn't an image", async () => {
    const { verify, mint } = await testAuth();
    const res = await snapHandler(
      env,
      verify,
    )(post("/api/snap", { image: "data:text/html;base64,PGI+" }, await mint()));
    expect(res.status).toBe(400);
  });
});
