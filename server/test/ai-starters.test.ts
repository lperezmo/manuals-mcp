import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { startersHandler } from "../src/http.js";
import { addDays, today } from "../src/lib/schedule.js";
import { resetPulseCache } from "../src/pulse.js";
import {
  choosePicks,
  MAX_CHARS,
  parseStarters,
  picksPrompt,
  resetStartersCache,
  STARTERS_DAILY,
} from "../src/starters.js";
import { testAuth } from "./helpers.js";

// Home's chat starters written by Muse for what's coming up (Jev ranks it).
// The plain-JS merge with the templates is in starters.test.ts.

const base = {
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};
const muse = { READER_BASE_URL: "https://muse.example.com/v1", READER_MODEL: "muse-spark" };
const env = readEnv({ ...base, ...muse, JEV_API_KEY: "jev_test" });
const NOW = today();

const realFetch = globalThis.fetch;
beforeEach(() => {
  resetPulseCache();
  resetStartersCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ESPRESSO = { id: "11111111-1111-1111-1111-111111111111", nickname: "Espresso machine" };
const FURNACE = { id: "33333333-3333-3333-3333-333333333333", nickname: "Furnace" };
const full = (i: { id: string; nickname: string }) => ({
  ...i,
  kind: "appliance",
  category: null,
  icon: null,
  tint: null,
  archived_at: null,
});

describe("what Muse is told about", () => {
  test("Jev's lines first in its order, then the rest latest first, at most five", () => {
    const card = (key: string) => ({
      key,
      title: key,
      sub: "late 2 days",
      chip: "worse" as const,
      item: ESPRESSO,
    });
    const ev = (key: string, late: number) => ({ key, title: key, sub: "", late, item: FURNACE });
    const picks = choosePicks(
      [card("b"), card("a")],
      [ev("a", 9), ev("c", -3), ev("d", 4), ev("e", 0), ev("f", -10), ev("g", -12)],
    );
    expect(picks.map((p) => p.key)).toEqual(["b", "a", "d", "e", "c"]);
    expect(picks[0]?.chip).toBe("worse");
    expect(picks[2]?.chip).toBeNull();
  });

  test("one line per thing, with why it matters", () => {
    expect(
      picksPrompt([
        {
          key: "k",
          title: "Descale",
          nickname: "Espresso machine",
          sub: "late 12 days · every 3 months",
          chip: "worse",
        },
        {
          key: "w",
          title: "Warranty ending",
          nickname: "Furnace",
          sub: "19 days left",
          chip: null,
        },
      ]),
    ).toBe(
      "- Descale (Espresso machine): late 12 days · every 3 months, gets worse if left\n- Warranty ending (Furnace): 19 days left",
    );
  });
});

describe("reading Muse's answer", () => {
  test("keeps short distinct questions, at most three", () => {
    const raw = JSON.stringify({
      questions: [
        "How do I descale my espresso machine?",
        "how do I descale my espresso machine?",
        "Can the furnace filter wait a week?",
        "Tell me about the warranty",
        `What ${"very ".repeat(20)}long question is this?`,
        "See https://example.com for more?",
        42,
        "  When did I last   change the  furnace filter? ",
        "What does my furnace warranty cover?",
      ],
    });
    expect(parseStarters(`\`\`\`json\n${raw}\n\`\`\``).map((s) => s.text)).toEqual([
      "How do I descale my espresso machine?",
      "Can the furnace filter wait a week?",
      "When did I last change the furnace filter?",
    ]);
    for (const s of parseStarters(raw)) {
      expect(s.label).toBe(s.text);
      expect(s.text.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  });

  test("anything else gives nothing", () => {
    expect(parseStarters("not json")).toEqual([]);
    expect(parseStarters('{"questions": "one?"}')).toEqual([]);
    expect(parseStarters("[]")).toEqual([]);
  });
});

/** Supabase, Jev and Muse stand-ins: a late descale and a furnace filter due soon. */
function fakeNet(
  logged: any[],
  museCalls: any[],
  opts: { museStatus?: number; tasks?: unknown[]; usedToday?: number } = {},
) {
  const net = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("typesafe")) {
      const body = JSON.parse(String(init?.body));
      const answers: Record<string, unknown> = {};
      String(body.state.events)
        .split("\n")
        .forEach((_line, i) => {
          const id = `e${i + 1}`;
          answers[`${id}_safety`] = { noul: 0.02 };
          answers[`${id}_worse`] = { choice: i === 0 ? "u3" : "u1", confidence: 0.8 };
          answers[`${id}_money`] = { noul: 0.2 };
          answers[`${id}_quick`] = { noul: 0.6 };
        });
      return Response.json({ answers, usage: { input_tokens: 500 } });
    }
    if (url.startsWith("https://muse.example.com/v1/chat/completions")) {
      museCalls.push(JSON.parse(String(init?.body)));
      if (opts.museStatus) return new Response("down", { status: opts.museStatus });
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                questions: [
                  "How do I descale my espresso machine?",
                  "Can the furnace filter wait another week?",
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 300, completion_tokens: 700 },
      });
    }
    if (url.includes("/rest/v1/tasks"))
      return Response.json(
        opts.tasks ?? [
          {
            id: "t-descale",
            title: "Descale",
            interval_unit: "months",
            interval_value: 3,
            next_due_on: addDays(NOW, -12),
            items: full(ESPRESSO),
          },
          {
            id: "t-filter",
            title: "Change the filter",
            interval_unit: "months",
            interval_value: 1,
            next_due_on: addDays(NOW, 5),
            items: full(FURNACE),
          },
        ],
      );
    if (url.includes("/rest/v1/items")) return Response.json([full(ESPRESSO), full(FURNACE)]);
    if (url.includes("/rest/v1/pulse_snoozes")) return Response.json([]);
    if (url.includes("/rest/v1/receipts")) return Response.json([]);
    if (url.includes("/rest/v1/household_notes")) return Response.json([]);
    if (url.includes("/rest/v1/model_runs")) {
      if (init?.method === "POST") {
        logged.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      }
      return new Response("[]", {
        status: 200,
        headers: {
          "content-range": `0-0/${opts.usedToday ?? 0}`,
          "content-type": "application/json",
        },
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  globalThis.fetch = net;
  return net;
}

function post(token?: string) {
  return new Request("https://manuals.example.com/api/starters", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: "{}",
  });
}

describe("starters handler", () => {
  test("Muse words what Jev ranked, once, and the run is logged", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    const museCalls: any[] = [];
    const net = fakeNet(logged, museCalls);
    const res = await startersHandler(env, verify, net)(post(await mint()));
    expect(res.status).toBe(200);
    const { starters } = (await res.json()) as any;
    expect(starters.map((s: any) => s.text)).toEqual([
      "How do I descale my espresso machine?",
      "Can the furnace filter wait another week?",
    ]);
    expect(museCalls).toHaveLength(1);
    const told = museCalls[0].messages[1].content as string;
    expect(told).toContain("- Descale (Espresso machine): late 12 days");
    expect(told).toContain("Change the filter (Furnace)");
    // The late descale (Jev's line) comes before the filter.
    expect(told.indexOf("Descale")).toBeLessThan(told.indexOf("Change the filter"));
    expect(logged).toEqual([
      expect.objectContaining({
        kind: "starters",
        ok: true,
        model: "muse-spark",
        tokens_in: 300,
        tokens_out: 700,
      }),
    ]);

    // Same things coming up: the same questions, and Muse isn't asked again.
    const again = await startersHandler(env, verify, net)(post(await mint()));
    expect(((await again.json()) as any).starters).toHaveLength(2);
    expect(museCalls).toHaveLength(1);
    expect(logged).toHaveLength(1);
  });

  test("works without Jev, from what's due", async () => {
    const { verify, mint } = await testAuth();
    const museCalls: any[] = [];
    const net = fakeNet([], museCalls);
    const res = await startersHandler(
      readEnv({ ...base, ...muse }),
      verify,
      net,
    )(post(await mint()));
    expect(((await res.json()) as any).starters).toHaveLength(2);
    expect(museCalls[0].messages[1].content).toContain("Descale (Espresso machine)");
  });

  test("null keeps Home's templates: nothing due, Muse down or unset, the day's calls used", async () => {
    const { verify, mint } = await testAuth();
    const museCalls: any[] = [];
    const empty = await startersHandler(
      env,
      verify,
      fakeNet([], museCalls, { tasks: [] }),
    )(post(await mint()));
    expect(await empty.json()).toEqual({ starters: null });
    expect(museCalls).toHaveLength(0);

    const down = await startersHandler(
      env,
      verify,
      fakeNet([], museCalls, { museStatus: 503 }),
    )(post(await mint()));
    expect(await down.json()).toEqual({ starters: null });

    const used = await startersHandler(
      env,
      verify,
      fakeNet([], [], { usedToday: STARTERS_DAILY }),
    )(post(await mint()));
    expect(await used.json()).toEqual({ starters: null });

    const unset = await startersHandler(readEnv(base), verify, fakeNet([], []))(post(await mint()));
    expect(await unset.json()).toEqual({ starters: null });
  });

  test("needs a signed-in user", async () => {
    const { verify } = await testAuth();
    expect((await startersHandler(env, verify)(post())).status).toBe(401);
  });
});
