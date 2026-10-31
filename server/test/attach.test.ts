import { afterEach, describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { attachHandler } from "../src/http.js";
import { testAuth } from "./helpers.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
});
const ITEM = {
  id: "22222222-2222-2222-2222-222222222222",
  nickname: "Microwave",
  kind: "appliance",
};
const PDF_URL =
  "https://www.galanz.com/us/wp-content/uploads/2021/01/GSWWD09S1A09A-User-Manual.pdf";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const attach = (token?: string) =>
  new Request("https://manuals.example.com/api/attach", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ item_id: ITEM.id, url: PDF_URL, official: true }),
  });

describe("attach a found manual", () => {
  test("needs a signed-in user", async () => {
    const { verify } = await testAuth();
    expect((await attachHandler(env, verify)(attach())).status).toBe(401);
  });

  test("a slow maker's site gets a sentence a person can act on", async () => {
    const { verify, mint } = await testAuth();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/rest/v1/items")) return Response.json(ITEM);
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const slow = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    const res = await attachHandler(env, verify, slow)(attach(await mint()));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("too slow");
  });

  test("stores the PDF and answers with the manual id, without reading it", async () => {
    const { verify, mint } = await testAuth();
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (url.includes("/rest/v1/items")) return Response.json(ITEM);
      if (url.includes("/rpc/ensure_household"))
        return Response.json("11111111-1111-1111-1111-111111111111");
      if (url.includes("/rest/v1/manuals") && init?.method === "POST")
        return Response.json({ id: "33333333-3333-3333-3333-333333333333" });
      if (url.includes("/rest/v1/manuals")) return new Response(null, { status: 204 });
      if (url.includes("/storage/v1/object")) return Response.json({ Key: "manuals/x.pdf" });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const site = (async () =>
      new Response(new TextEncoder().encode("%PDF-1.7 tiny"), {
        headers: { "content-type": "application/pdf" },
      })) as unknown as typeof fetch;
    const res = await attachHandler(env, verify, site)(attach(await mint()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ manual_id: "33333333-3333-3333-3333-333333333333" });
    expect(calls.some((c) => c.includes("/storage/v1/object"))).toBe(true);
    expect(calls.some((c) => c.includes("manual_pages"))).toBe(false);
  });
});
