import { afterEach, describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { receiptHandler, toolHandler } from "../src/http.js";
import { addMonths, receiptSchema, warrantyStatus } from "../src/receipt.js";
import { testAuth } from "./helpers.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
});
const HOUSEHOLD = "11111111-1111-1111-1111-111111111111";
const ITEM = { id: "22222222-2222-2222-2222-222222222222", purchased_on: null };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("warranty math", () => {
  test("adds months the way Postgres does", () => {
    expect(addMonths("2026-01-15", 12)).toBe("2027-01-15");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2024-02-29", 12)).toBe("2025-02-28");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
  });

  test("covered, ending soon, ended and unknown", () => {
    const on = "2026-10-31";
    const bought = { purchased_on: "2026-01-15", warranty_ends_on: null };
    expect(warrantyStatus({ ...bought, warranty_months: 12 }, on)).toMatchObject({
      status: "covered",
      ends_on: "2027-01-15",
      days_left: 76,
    });
    expect(warrantyStatus({ ...bought, warranty_months: 11 }, on).status).toBe("ending_soon");
    const ended = warrantyStatus({ ...bought, warranty_months: 6 }, on);
    expect(ended.status).toBe("ended");
    expect(ended.summary).toContain("likely isn't covered");
    // A printed end date wins over the length.
    expect(
      warrantyStatus({ ...bought, warranty_months: 6, warranty_ends_on: "2028-01-01" }, on).status,
    ).toBe("covered");
    expect(warrantyStatus({ ...bought, warranty_months: null }, on).status).toBe("unknown");
    expect(warrantyStatus(null, on).summary).toContain("No receipt");
  });

  test("a sloppy read keeps what it can", () => {
    const read = receiptSchema.parse({
      found: true,
      store: "Appliance Barn",
      purchased_on: "March 3rd",
      price: "899.99",
      currency: "usd",
      warranty_months: 12,
    });
    expect(read).toMatchObject({ store: "Appliance Barn", price: 899.99, warranty_months: 12 });
    expect(read.purchased_on).toBeNull();
    expect(read.currency).toBeNull();
  });
});

const MUSE_RECEIPT = {
  choices: [
    {
      message: {
        content: JSON.stringify({
          found: true,
          kind: "receipt",
          store: "Appliance Barn",
          purchased_on: "2026-06-01",
          price: 899.99,
          currency: "USD",
          warranty_months: 24,
        }),
      },
    },
  ],
};

function fakeSupabase(opts: { receiptsTable?: boolean; photosToday?: number } = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (path.endsWith("/rpc/model_runs_today_all")) return Response.json(0);
    if (path.endsWith("/rpc/ensure_household")) return Response.json(HOUSEHOLD);
    if (path.endsWith("/model_runs")) {
      if (method === "POST") return new Response(null, { status: 201 });
      const n = opts.photosToday ?? 0;
      return new Response(null, { status: 200, headers: { "content-range": `*/${n}` } });
    }
    if (path.endsWith("/items")) {
      if (method === "PATCH") return new Response(null, { status: 204 });
      return Response.json(ITEM);
    }
    if (path.includes("/storage/v1/object/receipts")) {
      if (opts.receiptsTable === false)
        return Response.json({ error: "Bucket not found" }, { status: 404 });
      return Response.json({ Key: "receipts/x.jpg" });
    }
    if (path.endsWith("/receipts")) {
      if (opts.receiptsTable === false)
        return Response.json(
          { message: 'relation "public.receipts" does not exist', code: "42P01" },
          { status: 404 },
        );
      return Response.json({ ...body, created_at: "2026-10-31T00:00:00Z" });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return calls;
}

const snap = (token: string, extra: object = {}) =>
  new Request("https://manuals.example.com/api/receipt", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ item_id: ITEM.id, image: "data:image/jpeg;base64,AAAA", ...extra }),
  });

const muse = (answer: object = MUSE_RECEIPT) =>
  (async () => Response.json(answer)) as unknown as typeof fetch;

describe("/api/receipt", () => {
  test("needs a signed-in user", async () => {
    const { verify } = await testAuth();
    const req = new Request("https://manuals.example.com/api/receipt", {
      method: "POST",
      body: "{}",
    });
    expect((await receiptHandler(env, verify)(req)).status).toBe(401);
  });

  test("reads the receipt, stores the photo and the row, and fills the purchase date", async () => {
    const { verify, mint } = await testAuth();
    const calls = fakeSupabase();
    const res = await receiptHandler(env, verify, muse())(snap(await mint()));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ found: true, saved: true, store: "Appliance Barn" });
    expect(out.warranty).toMatchObject({ ends_on: "2028-06-01" });
    const upload = calls.find((c) => c.path.includes("/storage/v1/object/receipts"));
    expect(upload?.path).toContain(`/receipts/${HOUSEHOLD}/`);
    const row = calls.find((c) => c.method === "POST" && c.path.endsWith("/receipts"))?.body;
    expect(row).toMatchObject({
      item_id: ITEM.id,
      household_id: HOUSEHOLD,
      price: 899.99,
      warranty_months: 24,
      read_by: "server",
    });
    expect(row.image_path).toMatch(new RegExp(`^${HOUSEHOLD}/.+\\.jpg$`));
    const patch = calls.find((c) => c.method === "PATCH" && c.path.endsWith("/items"));
    expect(patch?.body).toEqual({ purchased_on: "2026-06-01" });
    const logged = calls.find((c) => c.method === "POST" && c.path.endsWith("/model_runs"));
    expect(logged?.body).toMatchObject({ kind: "snap", ok: true, item_id: ITEM.id });
  });

  test("before the database update it still answers and keeps the purchase date", async () => {
    const { verify, mint } = await testAuth();
    const calls = fakeSupabase({ receiptsTable: false });
    const res = await receiptHandler(env, verify, muse())(snap(await mint()));
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ found: true, saved: false, receipt: null });
    expect(out.note).toContain("purchase date was kept");
    expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith("/items"))).toBe(true);
  });

  test("a photo with no receipt saves nothing", async () => {
    const { verify, mint } = await testAuth();
    const calls = fakeSupabase();
    const empty = { choices: [{ message: { content: '{"found":false}' } }] };
    const res = await receiptHandler(env, verify, muse(empty))(snap(await mint()));
    expect(await res.json()).toEqual({ found: false });
    expect(calls.some((c) => c.path.includes("receipts"))).toBe(false);
  });

  test("counts toward the daily photo limit", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase({ photosToday: 20 });
    let asked = false;
    const net = (async () => {
      asked = true;
      return Response.json(MUSE_RECEIPT);
    }) as unknown as typeof fetch;
    const res = await receiptHandler(env, verify, net)(snap(await mint()));
    expect(res.status).toBe(429);
    expect(asked).toBe(false);
  });

  test("refuses anything that isn't an image", async () => {
    const { verify, mint } = await testAuth();
    const res = await receiptHandler(
      env,
      verify,
    )(snap(await mint(), { image: "data:text/html;base64,PGI+" }));
    expect(res.status).toBe(400);
  });
});

describe("warranty_status", () => {
  test("tells an AI a broken thing is likely still covered", async () => {
    const { verify, mint } = await testAuth();
    const bought = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
      if (path.endsWith("/rpc/ensure_household")) return Response.json(HOUSEHOLD);
      if (path.endsWith("/items"))
        return Response.json([{ ...ITEM, nickname: "Washer", brand: "Brightwash" }]);
      if (path.endsWith("/receipts"))
        return Response.json([
          {
            item_id: ITEM.id,
            kind: "receipt",
            purchased_on: bought,
            store: "Appliance Barn",
            warranty_months: 12,
            warranty_ends_on: null,
            image_path: `${HOUSEHOLD}/r.jpg`,
          },
        ]);
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const res = await toolHandler(
      env,
      verify,
    )(
      new Request("https://manuals.example.com/api/tool", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${await mint()}` },
        body: JSON.stringify({ name: "warranty_status", args: { item: "washer" } }),
      }),
    );
    const out = await res.json();
    expect(out.ok).toBe(true);
    expect(out.summary).toContain("Likely still under warranty");
    expect(out.data.warranty.status).toBe("covered");
    expect(out.data.receipt).toMatchObject({ store: "Appliance Barn", photo_saved: true });
  });
});
