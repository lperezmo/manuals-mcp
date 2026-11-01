import { describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import type { Knowledge } from "../src/finder/knowledge.js";
import { trimTrivia } from "../src/finder/trim.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  JEV_API_KEY: "jev_test",
});

const knowledge = (): Knowledge => ({
  facts: [
    { kind: "error_code", label: "Er03", value: "Low temperature protection", source_page: 28 },
    { kind: "spec", label: "Power", value: "1350 W", source_page: 10 },
    { kind: "safety", label: "Child supervision", value: "Supervise children.", source_page: 3 },
    { kind: "other", label: "Child lock", value: "Hold STOP 3 s.", source_page: 9 },
  ],
  tasks: [
    { title: "Clean the filter", interval_unit: "months", interval_value: 3, source_page: 20 },
    { title: "Unplug before cleaning", interval_unit: "as_needed", source_page: 29 },
  ],
  seat_modes: [],
});

/** Jev stand-in: "no" for anything mentioning supervise or unplug. */
const jev = (seen: any[]) =>
  (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push(body);
    const answers = Object.fromEntries(
      Object.entries(body.state.entries).map(([k, text]) => [
        k,
        { type: "noul", noul: /supervise|unplug/i.test(String(text)) ? 0.05 : 0.8 },
      ]),
    );
    return Response.json({ answers, usage: { input_tokens: 300 } });
  }) as unknown as typeof fetch;

describe("trimTrivia", () => {
  test("asks only about entries that can be trivia, and drops the confident noes", async () => {
    const seen: any[] = [];
    const r = await trimTrivia(
      env,
      knowledge(),
      { label: "Microwave", kind: "appliance" },
      jev(seen),
    );
    // Error codes, specs and recurring tasks are never asked about.
    expect(Object.values(seen[0].state.entries)).toEqual([
      "Child supervision: Supervise children.",
      "Child lock: Hold STOP 3 s.",
      "Unplug before cleaning. ",
    ]);
    expect(r.knowledge.facts.map((f) => f.label)).toEqual(["Er03", "Power", "Child lock"]);
    expect(r.knowledge.tasks.map((t) => t.title)).toEqual(["Clean the filter"]);
    expect(r.dropped).toHaveLength(2);
  });

  test("keeps every safety entry on baby gear", async () => {
    const seen: any[] = [];
    const r = await trimTrivia(
      env,
      knowledge(),
      { label: "Car seat", kind: "baby_gear" },
      jev(seen),
    );
    expect(r.knowledge.facts.map((f) => f.label)).toContain("Child supervision");
  });

  test("keeps everything when Jev is down", async () => {
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const r = await trimTrivia(env, knowledge(), { label: "Microwave", kind: "appliance" }, down);
    expect(r.knowledge.facts).toHaveLength(4);
    expect(r.dropped).toEqual([]);
  });
});
