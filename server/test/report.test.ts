import { afterEach, describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { reportHandler } from "../src/http.js";
import { testAuth } from "./helpers.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  PUBLIC_URL: "https://manuals.example.com",
  NTFY_TOPIC: "manuals-test-topic",
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function send(body: unknown, token?: string) {
  return new Request("https://manuals.example.com/api/report", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** A fake Supabase that has `filed` reports today and records inserts. */
function fakeSupabase(filed: number) {
  const inserted: any[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("/rest/v1/issue_reports")) return new Response("unexpected", { status: 500 });
    if (init?.method === "POST") {
      inserted.push(JSON.parse(String(init.body)));
      return Response.json({ id: "33333333-3333-3333-3333-333333333333" }, { status: 201 });
    }
    return new Response(null, { status: 200, headers: { "content-range": `*/${filed}` } });
  }) as typeof fetch;
  return inserted;
}

describe("report an issue", () => {
  test("needs a signed-in user", async () => {
    const { verify } = await testAuth();
    const res = await reportHandler(env, verify)(send({ message: "Broken" }));
    expect(res.status).toBe(401);
  });

  test("saves the report as the user and pushes it", async () => {
    const { verify, mint } = await testAuth();
    const token = await mint();
    const inserted = fakeSupabase(2);
    const pushes: { url: string; init: RequestInit }[] = [];
    const ntfy = (async (url: string, init: RequestInit) => {
      pushes.push({ url, init });
      return new Response("{}");
    }) as unknown as typeof fetch;

    const res = await reportHandler(
      env,
      verify,
      ntfy,
    )(
      send(
        {
          message: "The washer manual came out empty",
          page: "/runs",
          run_id: "a2e8678e-0dd9-41f0-9d6d-091e9022b173",
        },
        token,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "33333333-3333-3333-3333-333333333333", pushed: true });
    expect(inserted[0]).toMatchObject({
      message: "The washer manual came out empty",
      page: "/runs",
    });
    expect(pushes[0]?.url).toBe("https://ntfy.sh/manuals-test-topic");
    expect(String(pushes[0]?.init.body)).toContain("The washer manual came out empty");
    expect(String(pushes[0]?.init.body)).toContain("From: parent@example.com");
    expect(new Headers(pushes[0]?.init.headers).get("click")).toBe(
      "https://manuals.example.com/runs",
    );
  });

  test("stops at the household's daily limit", async () => {
    const { verify, mint } = await testAuth();
    const token = await mint();
    const inserted = fakeSupabase(10);
    let pushed = false;
    const ntfy = (async () => {
      pushed = true;
      return new Response("{}");
    }) as unknown as typeof fetch;

    const res = await reportHandler(env, verify, ntfy)(send({ message: "Again" }, token));
    expect(res.status).toBe(429);
    expect(inserted).toHaveLength(0);
    expect(pushed).toBe(false);
  });
});
