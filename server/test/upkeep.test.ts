import { describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { groupTasks } from "../src/upkeep.js";

const base = {
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};
const env = readEnv({ ...base, JEV_API_KEY: "jev_test" });
const TASKS = [
  { id: "a", title: "Clean the interior", details: null },
  { id: "b", title: "Unplug before cleaning", details: "Disconnect the power cord." },
  { id: "c", title: "Something vague", details: null },
];

describe("groupTasks", () => {
  test("one Jev call, one choice question per task; unsure answers are left to the page", async () => {
    const calls: any[] = [];
    const jev = (async (_u: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return Response.json({
        answers: {
          t0: { type: "choice", choice: "cleaning", confidence: 0.95 },
          t1: { type: "choice", choice: "safety", confidence: 0.81 },
          t2: { type: "choice", choice: "checks", confidence: 0.3 },
        },
      });
    }) as unknown as typeof fetch;
    expect(await groupTasks(env, "Microwave", TASKS, jev)).toEqual({ a: "cleaning", b: "safety" });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions)).toEqual(["t0", "t1", "t2"]);
    expect(calls[0].questions.t0.criteria).toHaveProperty("cleaning");
  });

  test("no Jev, or no tasks, means no groups", async () => {
    expect(await groupTasks(readEnv(base), "Microwave", TASKS)).toEqual({});
    expect(await groupTasks(env, "Microwave", [])).toEqual({});
  });
});
