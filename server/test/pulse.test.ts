import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { pulseHandler } from "../src/http.js";
import { addDays, today } from "../src/lib/schedule.js";
import {
  askJev,
  BUDGET,
  buildPulse,
  choose,
  FLOOR,
  type PulseEvent,
  pulseSummary,
  resetPulseCache,
  type Signals,
  scoreOf,
  urgencyFrom,
} from "../src/pulse.js";
import { testAuth } from "./helpers.js";

const base = {
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};
const env = readEnv({ ...base, JEV_API_KEY: "jev_test" });
const NOW = today();

const realFetch = globalThis.fetch;
beforeEach(() => resetPulseCache());
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ESPRESSO = {
  id: "11111111-1111-1111-1111-111111111111",
  nickname: "Espresso machine",
  kind: "appliance",
  category: "coffee_maker",
  icon: null,
  tint: null,
};
const SMOKE = {
  id: "22222222-2222-2222-2222-222222222222",
  nickname: "Smoke alarm",
  kind: "other",
  category: "smoke_alarm",
  icon: null,
  tint: null,
};

const event = (key: string, over: Partial<PulseEvent> = {}): PulseEvent => ({
  key,
  kind: "task",
  item: ESPRESSO,
  title: key,
  sub: "due today · every month",
  task_id: key,
  late: 0,
  ...over,
});
const sig = (over: Partial<Signals> = {}): Signals => ({
  safety: 0,
  urgency: 0,
  money: 0,
  quick: 0,
  ...over,
});

describe("scoring", () => {
  test("urgency is the expected level from the probabilities, else the picked level", () => {
    expect(urgencyFrom({ probabilities: { u0: 0.5, u4: 0.5 } })).toBe(2);
    expect(urgencyFrom({ choice: "u3", confidence: 0.6 })).toBe(3);
    expect(urgencyFrom(undefined)).toBe(0);
  });

  test("safety skips the budget and comes first; the rest fill the budget over the floor", () => {
    const events = ["a", "b", "c", "d", "e"].map((k, i) => event(k, { late: i }));
    const signals = new Map<string, Signals>([
      ["a", sig({ urgency: 4, money: 1, quick: 1 })],
      ["b", sig({ urgency: 2, money: 0.5 })],
      ["c", sig({ quick: 0.2 })], // under the floor
      ["d", sig({ safety: 0.9 })],
      ["e", sig({ urgency: 2, money: 0.5 })], // ties with b, later wins
    ]);
    expect(scoreOf(signals.get("c") as Signals)).toBeLessThan(FLOOR);
    const cards = choose(events, signals);
    expect(cards.map((c) => c.key)).toEqual(["d", "a", "e"]);
    expect(cards).toHaveLength(BUDGET);
    expect(cards[0]?.chip).toBe("safety");
    expect(cards[0]?.snooze_days).toBe(1);
    expect(cards[1]?.chip).toBe("money");
    expect(cards[2]?.snooze_days).toBe(7);
  });

  test("a line that leans safety goes ahead of better scores inside the budget", () => {
    const events = ["smoke", "a", "b", "c"].map((k) => event(k));
    const signals = new Map<string, Signals>([
      ["smoke", sig({ safety: 0.77, urgency: 0.9 })], // under the floor on score alone
      ["a", sig({ urgency: 4, money: 1 })],
      ["b", sig({ urgency: 3, money: 1 })],
      ["c", sig({ urgency: 2, money: 1 })],
    ]);
    const cards = choose(events, signals);
    expect(cards.map((c) => c.key)).toEqual(["smoke", "a", "b"]);
    expect(cards[0]?.chip).toBe("safety");
    expect(cards[0]?.snooze_days).toBe(1);
  });

  test("more safety lines than the budget all show; nothing else does", () => {
    const events = ["s1", "s2", "s3", "s4", "x"].map((k) => event(k));
    const signals = new Map<string, Signals>(
      events.map((e) => [
        e.key,
        e.key === "x" ? sig({ urgency: 4, money: 1 }) : sig({ safety: 0.85 }),
      ]),
    );
    expect(choose(events, signals).map((c) => c.key)).toEqual(["s1", "s2", "s3", "s4"]);
  });
});

describe("askJev", () => {
  test("one call with four questions per event and the household's notes in state", async () => {
    const calls: any[] = [];
    const jev = (async (_u: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return Response.json({
        answers: {
          e1_safety: { noul: 0.05 },
          e1_worse: { choice: "u3", confidence: 0.7, probabilities: { u2: 0.3, u3: 0.7 } },
          e1_money: { noul: 0.4 },
          e1_quick: { noul: 0.8 },
          e2_safety: { noul: 0.95 },
        },
        usage: { input_tokens: 1234 },
      });
    }) as unknown as typeof fetch;
    const events = [
      event("task:descale:2026-11-01", { title: "Descale" }),
      event("task:battery:2026-11-02", { title: "Test the alarm", item: SMOKE }),
    ];
    const out = await askJev(
      env,
      events,
      [{ note: "We have really hard water", thing: "Espresso machine" }],
      NOW,
      jev,
    );
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions)).toEqual([
      "e1_safety",
      "e1_worse",
      "e1_money",
      "e1_quick",
      "e2_safety",
      "e2_worse",
      "e2_money",
      "e2_quick",
    ]);
    expect(calls[0].questions.e1_worse.type).toBe("choice");
    expect(Object.keys(calls[0].questions.e1_worse.criteria)).toEqual([
      "u0",
      "u1",
      "u2",
      "u3",
      "u4",
    ]);
    expect(calls[0].state.events).toContain("e1| Descale · Espresso machine (coffee maker)");
    expect(calls[0].state.notes).toContain(
      '- about "Espresso machine": "We have really hard water"',
    );
    expect(out?.tokens_in).toBe(1234);
    const descale = out?.signals.get("task:descale:2026-11-01");
    expect(descale?.urgency).toBeCloseTo(2.7);
    expect(descale?.quick).toBe(0.8);
    expect(out?.signals.get("task:battery:2026-11-02")?.safety).toBe(0.95);
  });

  test("fails open: no key, an error status or a thrown fetch give null", async () => {
    const events = [event("a")];
    expect(await askJev(readEnv(base), events, null, NOW)).toBeNull();
    const down = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await askJev(env, events, null, NOW, down)).toBeNull();
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await askJev(env, events, null, NOW, boom)).toBeNull();
  });
});

/** Supabase stand-in: two due tasks, one snoozed; an ending warranty; a note; the model log. */
function fakeSupabase(logged: any[], jevCalls: any[], jevStatus = 200) {
  const net = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("typesafe")) {
      const body = JSON.parse(String(init?.body));
      jevCalls.push(body);
      if (jevStatus !== 200) return new Response("down", { status: jevStatus });
      const answers: Record<string, unknown> = {};
      const lines = String(body.state.events).split("\n");
      lines.forEach((line, i) => {
        const id = `e${i + 1}`;
        const warranty = line.includes("warranty");
        answers[`${id}_safety`] = { noul: 0.02 };
        answers[`${id}_worse`] = { choice: warranty ? "u1" : "u3", confidence: 0.8 };
        answers[`${id}_money`] = { noul: warranty ? 0.9 : 0.2 };
        answers[`${id}_quick`] = { noul: 0.6 };
      });
      return Response.json({ answers, usage: { input_tokens: 900 } });
    }
    if (url.includes("/rest/v1/tasks"))
      return Response.json([
        {
          id: "t-descale",
          title: "Descale",
          interval_unit: "months",
          interval_value: 3,
          next_due_on: addDays(NOW, -12),
          items: ESPRESSO,
        },
        {
          id: "t-grinder",
          title: "Clean the grinder",
          interval_unit: "weeks",
          interval_value: 2,
          next_due_on: addDays(NOW, 3),
          items: ESPRESSO,
        },
      ]);
    if (url.includes("/rest/v1/items")) return Response.json([ESPRESSO, SMOKE]);
    if (url.includes("/rest/v1/pulse_snoozes"))
      return Response.json([{ event_key: `task:t-grinder:${addDays(NOW, 3)}` }]);
    if (url.includes("/rest/v1/receipts"))
      return Response.json([
        {
          id: "r1",
          item_id: ESPRESSO.id,
          kind: "receipt",
          purchased_on: addDays(NOW, -350),
          warranty_months: null,
          warranty_ends_on: addDays(NOW, 19),
          created_at: "2026-01-01T00:00:00Z",
        },
      ]);
    if (url.includes("/rest/v1/household_notes"))
      return Response.json([
        { note: "We have really hard water", items: { nickname: "Espresso machine" } },
      ]);
    if (url.includes("/rest/v1/model_runs")) {
      if (init?.method === "POST") logged.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 201 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  globalThis.fetch = net;
  return net;
}

function post(token?: string) {
  return new Request("https://manuals.example.com/api/pulse", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: "{}",
  });
}

describe("pulse handler", () => {
  test("asks Jev once about what isn't snoozed, shows the top lines and logs the run", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    const jevCalls: any[] = [];
    const net = fakeSupabase(logged, jevCalls);
    const res = await pulseHandler(env, verify, net)(post(await mint()));
    expect(res.status).toBe(200);
    const { pulse } = (await res.json()) as any;
    expect(jevCalls).toHaveLength(1);
    // The snoozed grinder task never reaches Jev.
    expect(jevCalls[0].state.events).not.toContain("Clean the grinder");
    expect(jevCalls[0].state.notes).toContain("really hard water");
    expect(pulse.snoozed).toBe(1);
    expect(pulse.considered).toBe(2);
    // Descale: 3/4 * 0.5 + 0.2 * 0.3 + 0.6 * 0.2 = 0.555; warranty: 1/4 * 0.5 + 0.9 * 0.3 + 0.12 = 0.515.
    expect(pulse.cards.map((c: any) => c.key)).toEqual([
      `task:t-descale:${addDays(NOW, -12)}`,
      `warranty:${ESPRESSO.id}:${addDays(NOW, 19)}`,
    ]);
    expect(pulse.cards[0].sub).toBe("late 12 days · every 3 months");
    expect(pulse.cards[0].chip).toBe("worse");
    expect(pulse.cards[1].chip).toBe("money");
    expect(pulse.cards[1].sub).toBe(`ends ${addDays(NOW, 19)} · 19 days left`);
    expect(logged).toEqual([
      expect.objectContaining({
        kind: "pulse",
        ok: true,
        model: env.router?.model,
        tokens_in: 900,
      }),
    ]);
    expect(JSON.parse(logged[0].raw_output).shown).toHaveLength(2);

    // Reloading the page within the cache window asks Jev nothing and logs nothing.
    const again = await pulseHandler(env, verify, net)(post(await mint()));
    expect(((await again.json()) as any).pulse.cards).toHaveLength(2);
    expect(jevCalls).toHaveLength(1);
    expect(logged).toHaveLength(1);
  });

  test("Jev down, or unset, means no Pulse card", async () => {
    const { verify, mint } = await testAuth();
    const jevCalls: any[] = [];
    const net = fakeSupabase([], jevCalls, 503);
    const down = await pulseHandler(env, verify, net)(post(await mint()));
    expect(await down.json()).toEqual({ pulse: null });
    expect(jevCalls).toHaveLength(1);
    const unset = await pulseHandler(readEnv(base), verify, net)(post(await mint()));
    expect(await unset.json()).toEqual({ pulse: null });
  });

  test("needs a signed-in user", async () => {
    const { verify } = await testAuth();
    expect((await pulseHandler(env, verify)(post())).status).toBe(401);
  });
});

describe("pulse summary for the tool", () => {
  test("says why each line is shown, or that nothing needs attention", async () => {
    const net = fakeSupabase([], []);
    const { userDb } = await import("../src/db.js");
    const pulse = await buildPulse(env, userDb(env, "token"), "user-1", net, NOW);
    expect(pulse && pulseSummary(pulse)).toBe(
      `2 thing(s) worth doing now:\n- Descale (Espresso machine): late 12 days · every 3 months, gets worse if left\n- Warranty ending (Espresso machine): ends ${addDays(NOW, 19)} · 19 days left, money at stake`,
    );
    expect(pulseSummary({ cards: [], considered: 3, snoozed: 0, jev: null })).toContain(
      "Nothing needs attention today",
    );
  });
});
