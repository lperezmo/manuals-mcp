import { describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { savePageKinds } from "../src/finder/ingest.js";
import { pageKinds, pageStrip } from "../src/finder/page-kinds.js";

const base = {
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};
const env = readEnv({ ...base, JEV_API_KEY: "jev_test" });
const noJev = readEnv(base);

const text = (words: string) => `${words} `.repeat(8);
const page = (page_number: number, content: string) => ({ page_number, content });

function fakeJev(answer: (key: string) => unknown) {
  const calls: any[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, body });
    const answers = Object.fromEntries(Object.keys(body.questions).map((k) => [k, answer(k)]));
    return Response.json({ answers, usage: { input_tokens: 50 } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("page kinds", () => {
  test("one choice per page with text, in one call, keeping the top pick", async () => {
    const { calls, fetchImpl } = fakeJev((key) =>
      key === "p31"
        ? { probabilities: { fix: 0.8, care: 0.15, use: 0.05 } }
        : { choice: "safety", confidence: 0.9 },
    );
    const out = await pageKinds(
      env,
      [page(2, text("Warning, read all instructions")), page(3, " "), page(31, text("Error E4"))],
      fetchImpl,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toEndWith("/v1/systemone");
    expect(Object.keys(calls[0].body.questions)).toEqual(["p2", "p31"]);
    expect(calls[0].body.questions.p31.type).toBe("choice");
    expect(Object.keys(calls[0].body.questions.p31.criteria)).toContain("fix");
    expect(calls[0].body.state.pages.p31).toContain("Error E4");
    expect(out.kinds.get(31)).toEqual({ kind: "fix", p: 0.8 });
    expect(out.kinds.get(2)).toEqual({ kind: "safety", p: 0.9 });
    expect(out.kinds.has(3)).toBe(false);
  });

  test("a long manual is split into calls sent together, and answers outside the kinds are dropped", async () => {
    const pages = Array.from({ length: 90 }, (_, n) => page(n + 1, text(`Page ${n + 1}`)));
    const { calls, fetchImpl } = fakeJev((key) =>
      key === "p5" ? { probabilities: { recipe: 1 } } : { probabilities: { use: 0.7 } },
    );
    const out = await pageKinds(env, pages, fetchImpl);
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(Object.keys(c.body.questions).length).toBeLessThanOrEqual(40);
    expect(out.kinds.size).toBe(89);
    expect(out.kinds.has(5)).toBe(false);
  });

  test("a failed or slow call leaves its pages without a kind, and never throws", async () => {
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const out = await pageKinds(env, [page(1, text("Setup"))], down);
    expect(out.kinds.size).toBe(0);
    expect(out.failed).toBe(1);
    const broken = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    expect((await pageKinds(env, [page(1, text("Setup"))], broken)).kinds.size).toBe(0);
    expect((await pageKinds(noJev, [page(1, text("Setup"))])).calls).toBe(0);
  });

  test("the strip lists each kind's pages in order and skips covers and other languages", () => {
    expect(
      pageStrip([
        { page_number: 31, kind: "fix" },
        { page_number: 24, kind: "care" },
        { page_number: 30, kind: "fix" },
        { page_number: 1, kind: "other" },
        { page_number: 50, kind: "language" },
        { page_number: 2, kind: "safety" },
        { page_number: 9, kind: null },
      ]),
    ).toEqual([
      { kind: "safety", label: "Safety", pages: [2] },
      { kind: "care", label: "Care", pages: [24] },
      { kind: "fix", label: "Fix", pages: [30, 31] },
    ]);
  });
});

describe("saving page kinds while a manual is read", () => {
  function fakeDb(fail = false) {
    const updates: { set: any; filters: [string, unknown][] }[] = [];
    const from = (table: string) => {
      expect(table).toBe("manual_pages");
      const u = { set: null as any, filters: [] as [string, unknown][] };
      const chain: any = {
        update: (set: unknown) => {
          u.set = set;
          updates.push(u);
          return chain;
        },
        eq: (c: string, v: unknown) => {
          u.filters.push([c, v]);
          return chain;
        },
        in: (c: string, v: unknown) => {
          u.filters.push([c, v]);
          return chain;
        },
        // biome-ignore lint/suspicious/noThenProperty: a stand-in for the query builder's thenable.
        then: (ok: (r: unknown) => unknown) =>
          Promise.resolve({ error: fail ? { message: "column kind does not exist" } : null }).then(
            ok,
          ),
      };
      return chain;
    };
    return { db: { from } as any, updates };
  }

  test("one update per kind and sureness, scoped to the manual", async () => {
    const { fetchImpl } = fakeJev((key) =>
      key === "p7" ? { probabilities: { care: 0.62 } } : { probabilities: { fix: 0.9 } },
    );
    const { db, updates } = fakeDb();
    const n = await savePageKinds(
      env,
      db,
      "m1",
      [page(6, text("Error codes")), page(7, text("Cleaning")), page(8, text("Error codes"))],
      fetchImpl,
    );
    expect(n).toBe(3);
    expect(updates).toHaveLength(2);
    const fix = updates.find((u) => u.set.kind === "fix");
    expect(fix?.set.kind_p).toBe(0.9);
    expect(fix?.filters).toEqual([
      ["manual_id", "m1"],
      ["page_number", [6, 8]],
    ]);
    expect(updates.find((u) => u.set.kind === "care")?.set.kind_p).toBe(0.6);
  });

  test("a database without the kind columns, or no Jev, changes nothing else", async () => {
    const { fetchImpl } = fakeJev(() => ({ probabilities: { fix: 0.9 } }));
    expect(await savePageKinds(env, fakeDb(true).db, "m1", [page(1, text("E4"))], fetchImpl)).toBe(
      0,
    );
    const quiet = fakeDb();
    expect(await savePageKinds(noJev, quiet.db, "m1", [page(1, text("E4"))])).toBe(0);
    expect(quiet.updates).toHaveLength(0);
  });
});
