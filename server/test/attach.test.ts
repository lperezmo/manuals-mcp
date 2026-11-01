import { afterEach, describe, expect, test } from "bun:test";
import { userDb } from "../src/db.js";
import { readEnv } from "../src/env.js";
import { processStoredManual, READ_TIMED_OUT } from "../src/finder/ingest.js";
import { attachHandler, ingestHandler } from "../src/http.js";
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

  test("a maker's site that blocks apps ends at once, says what to do, and ends the pill", async () => {
    const { verify, mint } = await testAuth();
    const logged: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/rest/v1/items")) return Response.json({ ...ITEM, brand: "Whirlpool" });
      if (url.includes("/rest/v1/model_runs") && init?.method === "POST") {
        logged.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      }
      if (url.includes("/rest/v1/manuals")) return new Response(null, { status: 204 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const akamai = (async () =>
      new Response("Access Denied", { status: 403 })) as unknown as typeof fetch;
    const req = new Request("https://manuals.example.com/api/attach", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await mint()}` },
      body: JSON.stringify({
        item_id: ITEM.id,
        url: "https://www.whirlpool.com/content/dam/global/documents/201508/owners-manual-W10717214-RevA.pdf",
        official: true,
        read: true,
      }),
    });
    const started = Date.now();
    const res = await attachHandler(env, verify, akamai)(req);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error:
        "Whirlpool's site won't let apps download its manuals. Tap Open, save the PDF on your phone, then add it with Upload a PDF.",
      blocked: true,
    });
    // A failed read with no manual: the "Reading" pill sees it and ends, even on another page.
    expect(logged).toEqual([
      expect.objectContaining({
        kind: "read",
        ok: false,
        item_id: ITEM.id,
        error: expect.stringContaining("won't let apps"),
      }),
    ]);
    expect(logged[0]?.manual_id).toBeUndefined();
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

  test("a second tap reuses the stored copy instead of downloading it again", async () => {
    const { verify, mint } = await testAuth();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/rest/v1/items")) return Response.json(ITEM);
      if (url.includes("/rest/v1/manuals") && (init?.method ?? "GET") === "GET")
        return Response.json({ id: "44444444-4444-4444-4444-444444444444" });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    let downloads = 0;
    const site = (async () => {
      downloads++;
      return new Response("%PDF-1.7 tiny", { headers: { "content-type": "application/pdf" } });
    }) as unknown as typeof fetch;
    const res = await attachHandler(env, verify, site)(attach(await mint()));
    expect(await res.json()).toEqual({
      manual_id: "44444444-4444-4444-4444-444444444444",
      existing: true,
    });
    expect(downloads).toBe(0);
  });
});

const MANUAL_ID = "33333333-3333-3333-3333-333333333333";
const ingest = (token: string, body: Record<string, unknown>) =>
  new Request("https://manuals.example.com/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ manual_id: MANUAL_ID, ...body }),
  });

/** A stored manual, and a fake database that records each call and answers the claim. */
function manualDb(manual: Record<string, unknown>, claimed: boolean) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${decodeURIComponent(new URL(url).pathname + new URL(url).search)}`);
    if (url.includes("/rpc/ensure_household"))
      return Response.json("11111111-1111-1111-1111-111111111111");
    if (url.includes("/rest/v1/manuals") && method === "GET")
      return Response.json({
        id: MANUAL_ID,
        storage_path: "h/m.pdf",
        page_count: 20,
        items: ITEM,
        ...manual,
      });
    if (
      url.includes("/rest/v1/manuals") &&
      method === "PATCH" &&
      url.includes("reading_since.is.null")
    )
      return Response.json(claimed ? [{ id: MANUAL_ID }] : []);
    if (url.includes("/rest/v1/manuals")) return new Response(null, { status: 204 });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return calls;
}

describe("read a stored manual", () => {
  test("a manual that is already read comes back without a new read", async () => {
    const { verify, mint } = await testAuth();
    const calls = manualDb({ status: "distilled", reader_at: "2026-10-01T00:00:00Z" }, true);
    const res = await ingestHandler(env, verify)(ingest(await mint(), {}));
    expect(res.status).toBe(200);
    expect((await res.json()).note).toBe("Already read.");
    expect(calls.some((c) => c.startsWith("PATCH"))).toBe(false);
    expect(calls.some((c) => c.includes("/storage/"))).toBe(false);
  });

  test("a read already running is refused as busy, without touching the PDF", async () => {
    const { verify, mint } = await testAuth();
    const calls = manualDb({ status: "text_ready", reader_at: null }, false);
    const res = await ingestHandler(env, verify)(ingest(await mint(), {}));
    expect(res.status).toBe(409);
    expect((await res.json()).busy).toBe(true);
    expect(calls.some((c) => c.includes("/storage/"))).toBe(false);
  });

  test("reading it again right after a read is refused", async () => {
    const { verify, mint } = await testAuth();
    manualDb({ status: "distilled", reader_at: new Date().toISOString() }, true);
    const res = await ingestHandler(env, verify)(ingest(await mint(), { reread: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("just read");
  });

  test("a read that runs out of time says so and frees the manual", async () => {
    const calls = manualDb({ status: "pending", reader_at: null }, true);
    const fake = globalThis.fetch;
    const bodies: string[] = [];
    // The PDF download stands in for any slow step: it answers long after the deadline.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (init?.body && typeof init.body === "string") bodies.push(init.body);
      if (url.includes("/storage/v1/object")) {
        await new Promise((r) => setTimeout(r, 300));
        return new Response("gone", { status: 500 });
      }
      return fake(input, init);
    }) as typeof fetch;
    const started = Date.now();
    const out = await processStoredManual({
      env,
      db: userDb(env, "token"),
      householdId: "11111111-1111-1111-1111-111111111111",
      manualId: MANUAL_ID,
      deadline: Date.now() + 30,
    });
    expect(Date.now() - started).toBeLessThan(250);
    expect(out.note).toBe(READ_TIMED_OUT);
    expect(out.distilled).toBeNull();
    // The page gets a plain sentence, never written over a read that already finished...
    expect(bodies.some((b) => b.includes(READ_TIMED_OUT))).toBe(true);
    expect(calls.some((c) => c.startsWith("PATCH") && c.includes("status=neq.distilled"))).toBe(
      true,
    );
    // ...the lock is let go so Read it again works...
    expect(bodies.some((b) => b === JSON.stringify({ reading_since: null }))).toBe(true);
    // ...and model_runs has a line saying why.
    expect(calls.some((c) => c.startsWith("POST /rest/v1/model_runs"))).toBe(true);
    expect(bodies.some((b) => b.includes("Ran out of time"))).toBe(true);
  });
});
