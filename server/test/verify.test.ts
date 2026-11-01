import { describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import type { Knowledge } from "../src/finder/knowledge.js";
import { numbersOn, verifyKnowledge } from "../src/finder/verify.js";

const base = {
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};
const withJev = readEnv({ ...base, JEV_API_KEY: "jev_test" });
const noJev = readEnv(base);

const PAGES = [
  {
    page_number: 12,
    content: "Rear-facing: 4-40 lb (1.8-18 kg) and 19-49 in. Clean the harness every two weeks.",
  },
  { page_number: 30, content: "Error E4: the drain is blocked. Clean the filter." },
];

const knowledge = (): Knowledge => ({
  tasks: [
    { title: "Clean the harness", interval_unit: "weeks", interval_value: 2, source_page: 12 },
    { title: "Wash the cover", interval_unit: "weeks", interval_value: 3, source_page: 12 },
  ],
  facts: [
    { kind: "error_code", label: "E4", value: "Drain blocked", source_page: 30 },
    { kind: "error_code", label: "E9", value: "Door open", source_page: 30 },
  ],
  seat_modes: [
    {
      mode: "rear_facing",
      weight_unit: "lb",
      height_unit: "in",
      min_weight: 4,
      max_weight: 40,
      max_height: 49,
      source_page: 12,
    },
    {
      mode: "forward_facing",
      weight_unit: "lb",
      height_unit: "in",
      min_weight: 22,
      max_weight: 65,
      source_page: 12,
    },
  ],
});

describe("numbersOn", () => {
  test("reads digits, decimals, thousands and small number words", () => {
    const n = numbersOn("Up to 1,000 cycles, 1.8 kg, every two weeks");
    for (const v of ["1000", "1.8", "2"]) expect(n.has(v)).toBe(true);
  });
});

describe("verifyKnowledge", () => {
  test("without Jev, still flags numbers the page doesn't show", async () => {
    const v = await verifyKnowledge(noJev, knowledge(), PAGES);
    expect(v.flagged).toEqual([
      { list: "tasks", index: 1, why: "numbers" },
      { list: "seat_modes", index: 1, why: "numbers" },
    ]);
    expect(v.knowledge.tasks[0]?.unsure).toBeUndefined();
    expect(v.knowledge.tasks[1]?.unsure).toBe(true);
  });

  test("asks Jev once per page and flags what it doesn't support", async () => {
    const calls: any[] = [];
    const jev = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      const answers = Object.fromEntries(
        Object.entries(body.questions).map(([k, q]: [string, any]) => [
          k,
          { type: "noul", noul: q.instructions.includes("E9") ? 0.04 : 0.6 },
        ]),
      );
      return Response.json({ answers, usage: { input_tokens: 100 } });
    }) as unknown as typeof fetch;
    const v = await verifyKnowledge(withJev, knowledge(), PAGES, jev);
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0].questions)).toHaveLength(4);
    expect(v.flagged).toContainEqual({ list: "facts", index: 1, why: "unsupported" });
    expect(v.knowledge.facts[0]?.unsure).toBeUndefined();
    expect(v.tokens_in).toBe(200);
  });

  test("a part name Jev can't find on the page isn't sent to a person", async () => {
    const k = knowledge();
    k.facts.push({
      kind: "part",
      label: "Roller ring",
      value: "Holds the turntable",
      source_page: 30,
    });
    const doubt = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 0.01 }]),
      );
      return Response.json({ answers });
    }) as unknown as typeof fetch;
    const v = await verifyKnowledge(withJev, k, PAGES, doubt);
    expect(v.knowledge.facts[2]?.unsure).toBeUndefined();
    expect(v.knowledge.facts[1]?.unsure).toBe(true);
  });

  test("car seat limits fail closed when Jev is down", async () => {
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const v = await verifyKnowledge(withJev, knowledge(), PAGES, down);
    expect(v.knowledge.seat_modes.every((s) => s.unsure)).toBe(true);
    expect(v.knowledge.facts.some((f) => f.unsure)).toBe(false);
  });
});
