import { describe, expect, test } from "bun:test";
import {
  applyPlan,
  askForPlan,
  describeHistory,
  historySchema,
  type Plan,
  PlanError,
  type PlanTask,
  pickPages,
  readPlan,
  staggerDates,
} from "../src/catch-up.js";
import type { Db } from "../src/db.js";
import { readEnv } from "../src/env.js";

const env = readEnv({
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "k",
  READER_BASE_URL: "https://reader.example.com/v1",
  READER_MODEL: "muse-spark",
});

const task = (id: string, extra: Partial<PlanTask> = {}): PlanTask => ({
  id,
  title: `Task ${id}`,
  details: null,
  interval_unit: "months",
  interval_value: 3,
  source_page: null,
  last_done_on: null,
  next_due_on: null,
  ...extra,
});

const TASKS = [
  task("lint", { title: "Clean the lint screen", interval_unit: "cycles", interval_value: 1 }),
  task("hoses", { title: "Check the inlet hoses", source_page: 44 }),
  task("tub", { title: "Run the tub clean cycle" }),
  task("unpack", {
    title: "Remove the shipping bolts",
    interval_unit: "once",
    interval_value: null,
  }),
  task("level", { title: "Re-level it", interval_unit: "as_needed", interval_value: null }),
];

describe("history", () => {
  test("describes it in plain words for the model", () => {
    const h = historySchema.parse({
      condition: "stored",
      age_years: 6,
      idle_months: 24,
      done: "in storage two years, never touched",
      goal: "like_new",
    });
    expect(describeHistory(h)).toBe(
      'Coming out of storage. About 6 years old. Last used about 24 months ago. What has been done, in the owner\'s words: "in storage two years, never touched" Goal: get it back to like new.',
    );
    expect(describeHistory({ condition: "used", idle_months: 0 })).toContain("In use now.");
    expect(describeHistory({ condition: "used" })).toContain("No word on past upkeep.");
  });

  test("only takes the three conditions and goals", () => {
    expect(historySchema.safeParse({ condition: "broken" }).success).toBe(false);
    expect(historySchema.safeParse({ condition: "used", goal: "shiny" }).success).toBe(false);
  });
});

describe("reading a plan", () => {
  test("maps refs to tasks: done gets a date, never and unknown come due, skip and as needed stay", () => {
    const plan = readPlan(
      {
        summary: "Two years idle: clean it out before the first load.",
        tasks: [
          { ref: "T1", state: "done", days_ago: 0 },
          { ref: "t2", state: "never" },
          { ref: "T4", state: "skip" },
          { ref: "T5", state: "never" },
          { ref: "T9", state: "never" },
        ],
        catch_up: [],
      },
      TASKS,
      [],
      "2026-11-01",
    );
    expect(plan.done).toEqual([{ id: "lint", done_on: "2026-11-01" }]);
    expect(plan.never).toEqual(["hoses"]);
    // The model never mentioned T3, so nobody knows: it comes due soon, not now.
    expect(plan.unknown).toEqual(["tub"]);
    expect(plan.summary).toBe("Two years idle: clean it out before the first load.");
  });

  test("done without a when is unknown, and days ago becomes a date", () => {
    const plan = readPlan(
      {
        tasks: [
          { ref: "T1", state: "done" },
          { ref: "T2", state: "done", days_ago: 200 },
        ],
      },
      TASKS.slice(0, 2),
      [],
      "2026-11-01",
    );
    expect(plan.unknown).toEqual(["lint"]);
    expect(plan.done).toEqual([{ id: "hoses", done_on: "2026-04-15" }]);
  });

  test("keeps a page only when Muse saw it, and flags what isn't from the manual", () => {
    const plan = readPlan(
      {
        catch_up: [
          { title: "Flush the drain pump", source_page: 12, from_manual: true },
          { title: "Check the hoses before running it", source_page: 44, from_manual: true },
          { title: "Made-up page", source_page: 99, from_manual: true },
          { title: "Wipe off the dust", details: "General advice." },
          { title: "", details: "No title, left out." },
        ],
      },
      TASKS,
      [12],
    );
    expect(plan.steps).toEqual([
      { title: "Flush the drain pump", details: null, source_page: 12, cited: true },
      { title: "Check the hoses before running it", details: null, source_page: 44, cited: true },
      { title: "Made-up page", details: null, source_page: null, cited: false },
      { title: "Wipe off the dust", details: "General advice.", source_page: null, cited: false },
    ]);
  });

  test("caps the steps and shortens long text instead of dropping it", () => {
    const steps = Array.from({ length: 12 }, (_, i) => ({
      title: `Step ${i}`,
      details: "x ".repeat(500),
    }));
    const plan = readPlan({ catch_up: steps }, [], []);
    expect(plan.steps).toHaveLength(8);
    expect(plan.steps[0]?.details?.length).toBeLessThanOrEqual(600);
    expect(() => readPlan([], [], [])).toThrow("JSON object");
  });
});

describe("staggering", () => {
  test("two a day, a few days apart, so day one isn't ten alerts", () => {
    expect(staggerDates(5, "2026-11-01")).toEqual([
      "2026-11-01",
      "2026-11-01",
      "2026-11-04",
      "2026-11-04",
      "2026-11-07",
    ]);
    expect(staggerDates(0, "2026-11-01")).toEqual([]);
  });
});

describe("pages for the plan", () => {
  test("picks storage and startup pages, in page order", () => {
    const pages = [
      { page_number: 3, content: "Warranty and legal text." },
      {
        page_number: 30,
        content: "Before using the washer after long storage, run a rinse cycle.",
      },
      { page_number: 8, content: "Winterizing: drain the hoses before storage. Store it dry." },
    ];
    expect(pickPages(pages).map((p) => p.page_number)).toEqual([8, 30]);
    expect(pickPages(pages, 60).map((p) => p.page_number)).toEqual([8]);
  });
});

describe("asking Muse", () => {
  test("sends the history, numbered tasks and pages; reads the answer", async () => {
    let sent: any;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Run a rinse cycle first.",
                tasks: [{ ref: "T2", state: "never" }],
                catch_up: [{ title: "Run a rinse cycle", source_page: 30, from_manual: true }],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 1200, completion_tokens: 150 },
      });
    }) as unknown as typeof fetch;
    const out = await askForPlan(
      env,
      {
        itemLabel: "Washer (Brightwash BW-4100)",
        history: { condition: "stored", done: "no idea" },
        tasks: TASKS.slice(0, 2),
        pages: [{ page_number: 30, content: "After long storage, run a rinse cycle." }],
      },
      fake,
    );
    expect(sent.model).toBe("muse-spark");
    expect(sent.response_format).toEqual({ type: "json_object" });
    const user = sent.messages[1].content as string;
    expect(user).toContain("Coming out of storage.");
    expect(user).toContain("T2: Check the inlet hoses (every 3 months, manual p. 44)");
    expect(user).toContain("--- page 30 ---");
    expect(out.plan.never).toEqual(["hoses"]);
    expect(out.plan.steps[0]).toMatchObject({ source_page: 30, cited: true });
    expect(out.usage).toEqual({ model: "muse-spark", tokens_in: 1200, tokens_out: 150 });
  });

  test("an answer that isn't JSON fails with what came back", async () => {
    const fake = (async () =>
      Response.json({
        choices: [{ message: { content: "Sure! Here is a plan." } }],
      })) as unknown as typeof fetch;
    const err = await askForPlan(
      env,
      { itemLabel: "AC", history: { condition: "stored" }, tasks: [], pages: [] },
      fake,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PlanError);
    expect(err.raw).toBe("Sure! Here is a plan.");
  });
});

/** Just enough of the Supabase client for applyPlan, recording every write. */
function fakeDb(opts: { oldSchema?: boolean; logged?: Record<string, string> } = {}) {
  const writes: any[] = [];
  const db = {
    from(table: string) {
      const op: any = { table, filters: [] as unknown[] };
      const result = () => {
        if (opts.oldSchema && op.kind === "delete")
          return { error: { message: "column tasks.catch_up does not exist" } };
        if (opts.oldSchema && op.kind === "insert" && op.rows.some((r: any) => "catch_up" in r)) {
          return {
            error: {
              message: "Could not find the 'catch_up' column of 'tasks' in the schema cache",
            },
          };
        }
        if (opts.oldSchema && op.table === "items")
          return { error: { message: "column does not exist" } };
        writes.push(op);
        if (op.kind === "insert") {
          return {
            data: op.rows.map((r: any, i: number) => ({
              id: `new${i}`,
              title: r.title,
              next_due_on: r.next_due_on,
            })),
            error: null,
          };
        }
        return { data: null, error: null };
      };
      // A real promise, settled after the chained calls below have described the query.
      const chain: any = Promise.resolve().then(result);
      const step = (change: Record<string, unknown>) => () => {
        Object.assign(op, change);
        return chain;
      };
      chain.delete = step({ kind: "delete" });
      chain.select = step({});
      chain.insert = (rows: unknown[]) => step({ kind: "insert", rows })();
      chain.update = (change: unknown) => step({ kind: "update", change })();
      chain.eq = (k: string, v: unknown) => {
        op.filters.push([k, v]);
        return chain;
      };
      chain.is = chain.eq;
      return chain;
    },
    async rpc(name: string, args: any) {
      writes.push({ kind: "rpc", name, args });
      const next = opts.logged?.[args.p_task] ?? "2027-01-01";
      return { data: { id: args.p_task, active: true, next_due_on: next }, error: null };
    },
  };
  return { db: db as unknown as Db, writes };
}

const PLAN: Plan = {
  summary: "Clean it before using it.",
  done: [
    { id: "lint", done_on: "2026-10-31" },
    { id: "hoses", done_on: "2024-01-01" },
  ],
  never: ["tub"],
  unknown: ["unpack"],
  steps: [
    { title: "Flush the pump", details: "Page 30.", source_page: 30, cited: true },
    { title: "Dust the back", details: null, source_page: null, cited: false },
  ],
};

describe("seeding the schedule", () => {
  test("logs what's done, staggers the rest after the catch-up steps, and replaces old steps", async () => {
    const { db, writes } = fakeDb({ logged: { hoses: "2024-04-01" } });
    const out = await applyPlan({
      db,
      householdId: "h1",
      item: { id: "washer" },
      manualId: "m1",
      plan: PLAN,
      today: "2026-11-01",
    });
    const kinds = writes.map((w) =>
      w.kind === "rpc" ? `rpc:${w.args.p_task}` : `${w.kind}:${w.table}`,
    );
    expect(kinds.slice(0, 4)).toEqual(["delete:tasks", "rpc:lint", "rpc:hoses", "insert:tasks"]);
    const insert = writes.find((w) => w.kind === "insert");
    expect(
      insert.rows.map((r: any) => [
        r.title,
        r.next_due_on,
        r.status,
        r.source_page,
        r.source_manual_id,
        r.interval_unit,
        r.catch_up,
      ]),
    ).toEqual([
      ["Flush the pump", "2026-11-01", "extracted", 30, "m1", "once", true],
      ["Dust the back", "2026-11-01", "needs_review", null, null, "once", true],
    ]);
    expect(insert.rows[1].details).toBe("General advice, not from the manual.");
    // Never done first, then the done task that's overdue anyway, then the unknown one.
    const due = writes
      .filter((w) => w.kind === "update" && w.table === "tasks")
      .map((w) => [w.filters[0][1], w.change.next_due_on]);
    expect(due).toEqual([
      ["tub", "2026-11-04"],
      ["hoses", "2026-11-04"],
      ["unpack", "2026-11-07"],
    ]);
    expect(out).toMatchObject({ done: 1, due: 5, through: "2026-11-07", remembered: true });
    expect(out.steps.map((s) => s.cited)).toEqual([true, false]);
  });

  test("still works before the migration, without remembering the steps", async () => {
    const { db, writes } = fakeDb({ oldSchema: true });
    const out = await applyPlan({
      db,
      householdId: "h1",
      item: { id: "washer" },
      manualId: null,
      plan: { ...PLAN, done: [] },
      today: "2026-11-01",
    });
    const insert = writes.find((w) => w.kind === "insert");
    expect(insert.rows.every((r: any) => !("catch_up" in r))).toBe(true);
    expect(out.remembered).toBe(false);
    expect(out.steps).toHaveLength(2);
  });
});
