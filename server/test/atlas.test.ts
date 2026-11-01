import { describe, expect, test } from "bun:test";
import {
  type AtlasInput,
  type AtlasItem,
  type AtlasTask,
  buildAtlas,
  dueState,
  guessItem,
  guessTask,
  lensOptions,
  placements,
  scoreView,
  sortFacets,
  textScores,
} from "../src/atlas.js";
import { readEnv } from "../src/env.js";
import {
  loadAtlas,
  resolveView,
  resumeSorting,
  scoresFor,
  viewIsStale,
} from "../src/tools/house-atlas.js";

const base = {
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
};
const env = readEnv({ ...base, JEV_API_KEY: "jev_test" });
const noJev = readEnv(base);

const item = (id: string, nickname: string, extra: Partial<AtlasItem> = {}): AtlasItem => ({
  id,
  kind: "appliance",
  category: null,
  nickname,
  brand: null,
  model: null,
  child_id: null,
  notes: null,
  ...extra,
});
const task = (id: string, item_id: string, title: string, next_due_on: string | null = null) =>
  ({ id, item_id, title, details: null, next_due_on }) as AtlasTask;

const WASHER = item("w", "Washer", { brand: "Whirlpool", model: "WTW5000DW" });
const DEHUM = item("d", "Dehumidifier");
const CRIB = item("c", "Crib", { kind: "baby_gear" });
const KIDS = [{ id: "k1", nickname: "Rio" }];

/** A Jev stand-in that answers every question it is asked from a table, and records each call. */
function fakeJev(answer: (key: string, q: any) => unknown) {
  const calls: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([k, q]) => [k, answer(k, q)]),
    );
    return Response.json({ answers, usage: { input_tokens: 100 } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("sorting along lenses", () => {
  test("one choice per lens per thing and per task, in one call, keeping second places", async () => {
    const { calls, fetchImpl } = fakeJev((key) => {
      if (key === "i1_room")
        return { probabilities: { basement: 0.55, laundry: 0.4, garage: 0.05 } };
      if (key.endsWith("_room")) return { probabilities: { laundry: 0.9, kitchen: 0.1 } };
      if (key.endsWith("_system")) return { probabilities: { water: 0.8, power: 0.2 } };
      if (key.endsWith("_whose")) return { probabilities: { anyone: 0.7, adult: 0.3 } };
      if (key.endsWith("_effort")) return { probabilities: { fifteen_minutes: 0.9 } };
      return { probabilities: { any_time: 0.95, before_winter: 0.05 } };
    });
    const tasks = [task("t", "w", "Clean the drain pump filter")];
    const out = await sortFacets(
      env,
      { items: [WASHER, DEHUM], tasks, children: KIDS, all: [WASHER, DEHUM] },
      fetchImpl,
    );
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0].questions).sort()).toEqual(
      [
        "i0_room",
        "i0_system",
        "i0_whose",
        "i1_room",
        "i1_system",
        "i1_whose",
        "t0_effort",
        "t0_season",
      ].sort(),
    );
    // Each child of the household is an option for "who it's for".
    expect(calls[0].questions.i0_whose.criteria).toHaveProperty("child:k1");
    expect(calls[0].state.things.i0).toContain("Whirlpool WTW5000DW");
    expect(calls[0].state.things.i0).toContain("Clean the drain pump filter");
    expect(out.sorted).toEqual(new Set(["w", "d", "t"]));
    const dehumRooms = out.rows.filter((r) => r.id === "d" && r.lens === "room");
    expect(dehumRooms.map((r) => r.value)).toEqual(["basement", "laundry"]);
    // Below KEEP_P is dropped.
    expect(out.rows.find((r) => r.id === "t" && r.value === "before_winter")).toBeUndefined();
  });

  test("a big household is split into several calls sent together", async () => {
    const many = Array.from({ length: 45 }, (_, n) => item(`x${n}`, `Thing ${n}`));
    const { calls, fetchImpl } = fakeJev(() => ({ choice: "power", confidence: 0.8 }));
    await sortFacets(env, { items: many, tasks: [], children: [], all: many }, fetchImpl);
    expect(calls.length).toBe(3);
    for (const c of calls) expect(Object.keys(c.questions).length).toBeLessThanOrEqual(60);
  });

  test("answers outside the options, or a failed call, leave things unsorted", async () => {
    const bad = fakeJev(() => ({ probabilities: { moon: 1 } }));
    const out = await sortFacets(
      env,
      { items: [WASHER], tasks: [], children: [], all: [WASHER] },
      bad.fetchImpl,
    );
    expect(out.sorted.size).toBe(0);
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const out2 = await sortFacets(
      env,
      { items: [WASHER], tasks: [], children: [], all: [WASHER] },
      down,
    );
    expect(out2.rows).toEqual([]);
  });

  test("no Jev means no sort", async () => {
    const out = await sortFacets(noJev, { items: [WASHER], tasks: [], children: [], all: [] });
    expect(out.sorted.size).toBe(0);
  });
});

describe("keyword guesses", () => {
  test("things land in a sensible room, system and owner", () => {
    expect(guessItem(item("a", "Dishwasher"))).toMatchObject({
      room: { kitchen: 0.5 },
      system: { water: 0.5 },
      whose: { anyone: 0.5 },
    });
    expect(guessItem(item("b", "Car seat", { kind: "baby_gear", child_id: "k1" }), KIDS)).toEqual({
      room: { car: 0.5 },
      system: { safety: 0.5 },
      whose: { "child:k1": 0.5 },
    });
    expect(guessItem(CRIB, KIDS).whose).toEqual({ "child:k1": 0.5 });
  });

  test("tasks get an effort and a season from their words", () => {
    expect(guessTask(task("a", "h", "Flush the water heater tank before winter"))).toEqual({
      effort: { afternoon: 0.5 },
      season: { before_winter: 0.5 },
    });
    expect(guessTask(task("b", "s", "Test every alarm")).effort).toEqual({ five_minutes: 0.5 });
    expect(
      guessTask(task("c", "f", "Have a qualified technician check the burner")).effort,
    ).toEqual({
      pro: 0.5,
    });
  });

  test("whose options follow the household's children", () => {
    expect(Object.keys(lensOptions("whose", []))).toEqual(["anyone", "adult", "child"]);
    expect(Object.keys(lensOptions("whose", KIDS))).toEqual(["anyone", "adult", "child:k1"]);
  });
});

describe("views", () => {
  test("one yes/no per thing in one call", async () => {
    const { calls, fetchImpl } = fakeJev((key) => ({ noul: key === "i0" ? 0.97 : 0.1 }));
    const out = await scoreView(env, "could flood the floor", [WASHER, CRIB], [], fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0].questions.i0.type).toBe("noul");
    expect(calls[0].questions.i0.instructions).toContain("could flood the floor");
    expect(out).toEqual({ scores: { w: 0.97, c: 0.1 }, mode: "jev", tokens_in: 100 });
  });

  test("without Jev, a plain word match", async () => {
    const tasks = [task("t", "w", "Clean the drain pump filter")];
    expect(textScores("things with a drain", [WASHER, CRIB], tasks)).toEqual({ w: 1, c: 0 });
    const out = await scoreView(noJev, "the crib", [WASHER, CRIB]);
    expect(out).toMatchObject({ scores: { w: 0, c: 1 }, mode: "text" });
  });
});

describe("the map", () => {
  const today = "2026-11-01";
  const input: AtlasInput = {
    today,
    children: KIDS,
    items: [
      {
        ...WASHER,
        guess: false,
        facets: { room: { laundry: 0.9 }, system: { water: 0.9 }, whose: { anyone: 0.9 } },
      },
      {
        ...DEHUM,
        guess: false,
        facets: { room: { basement: 0.55, laundry: 0.4 }, system: { air_heat: 0.9 } },
      },
      { ...CRIB, guess: true, facets: { room: { nursery: 0.5 }, whose: { "child:k1": 0.5 } } },
    ],
    tasks: [
      {
        ...task("t1", "w", "Clean the drain pump filter", "2026-10-20"),
        guess: false,
        facets: { effort: { fifteen_minutes: 0.9 }, season: { any_time: 0.9 } },
      },
      {
        ...task("t2", "d", "Empty and rinse the bucket", "2026-11-04"),
        guess: false,
        facets: { effort: { five_minutes: 0.8 }, season: { any_time: 0.6, before_summer: 0.4 } },
      },
    ],
  };

  test("due state counts late and due within a week", () => {
    expect(dueState("2026-10-31", today)).toBe("late");
    expect(dueState("2026-11-08", today)).toBe("soon");
    expect(dueState("2026-11-20", today)).toBe("ok");
    expect(dueState(null, today)).toBe("none");
  });

  test("a thing shows in every room it is likely in, groups in lens order with health", () => {
    expect(placements({ basement: 0.55, laundry: 0.4, garage: 0.05 })).toEqual([
      ["basement", 0.55],
      ["laundry", 0.4],
    ]);
    const groups = buildAtlas("room", input);
    expect(groups.map((g) => g.value)).toEqual(["laundry", "nursery", "basement"]);
    const laundry = groups[0]!;
    expect(laundry.label).toBe("Laundry");
    expect(laundry.entries.map((e) => e.name)).toEqual(["Washer", "Dehumidifier"]);
    expect(laundry.late).toBe(1);
    expect(laundry.soon).toBe(1);
    expect(laundry.entries[0]).toMatchObject({
      task: "Clean the drain pump filter",
      state: "late",
    });
    expect(groups.find((g) => g.value === "nursery")?.entries[0]?.guess).toBe(true);
    expect(buildAtlas("whose", input).map((g) => g.label)).toEqual(["Anyone", "Rio"]);
  });

  test("effort and season map tasks, named with their thing", () => {
    const groups = buildAtlas("effort", input);
    expect(groups.map((g) => g.value)).toEqual(["five_minutes", "fifteen_minutes"]);
    expect(groups[0]?.entries[0]).toMatchObject({
      type: "task",
      name: "Dehumidifier",
      task: "Empty and rinse the bucket",
      item_id: "d",
    });
    expect(
      buildAtlas("season", input).find((g) => g.value === "before_summer")?.entries,
    ).toHaveLength(1);
  });

  test("a view keeps things over the bar, fades the maybe band and drops the rest", () => {
    const groups = buildAtlas("room", input, { scores: { w: 0.95, d: 0.5, c: 0.1 } });
    const laundry = groups.find((g) => g.value === "laundry")!;
    expect(laundry.entries.map((e) => [e.name, e.maybe])).toEqual([
      ["Washer", false],
      ["Dehumidifier", true],
    ]);
    expect(groups.find((g) => g.value === "nursery")).toBeUndefined();
  });
});

/** Just enough of the Supabase client for loadAtlas: canned reads, recorded writes. */
function fakeDb(tables: Record<string, unknown[]>) {
  const writes: { table: string; op: string; rows?: unknown; filter?: unknown }[] = [];
  const reads: Record<string, number> = {};
  const from = (table: string) => {
    const result = { data: tables[table] ?? [], error: null };
    const chain: any = {
      select: () => chain,
      is: () => chain,
      order: () => chain,
      range: (a: number, b: number) => {
        result.data = (tables[table] ?? []).slice(a, b + 1);
        reads[table] = (reads[table] ?? 0) + 1;
        return chain;
      },
      eq: (col: string, v: unknown) => {
        if (chain.op) writes.push({ table, op: chain.op, rows: chain.rows, filter: [col, v] });
        return chain;
      },
      in: (col: string, v: unknown) => {
        writes.push({ table, op: "delete", filter: [col, v] });
        return chain;
      },
      delete: () => chain,
      insert: (rows: unknown) => {
        writes.push({ table, op: "insert", rows });
        return chain;
      },
      update: (rows: unknown) => {
        chain.op = "update";
        chain.rows = rows;
        return chain;
      },
      // biome-ignore lint/suspicious/noThenProperty: a stand-in for the query builder's thenable.
      then: (ok: (r: unknown) => unknown) => Promise.resolve(result).then(ok),
    };
    return chain;
  };
  return { db: { from } as any, writes, reads };
}

describe("loading the atlas", () => {
  const items = [
    {
      ...WASHER,
      household_id: "h",
      icon: null,
      tint: null,
      updated_at: "2026-10-30T00:00:00Z",
      tasks: [
        { ...task("t1", "w", "Clean the drain pump filter"), household_id: "h", active: true },
        { ...task("t9", "w", "Old task"), household_id: "h", active: false },
      ],
    },
    {
      ...CRIB,
      household_id: "h",
      icon: null,
      tint: null,
      updated_at: "2026-10-29T00:00:00Z",
      tasks: [],
    },
  ];
  const sortedWasher = [
    { item_id: "w", lens: "room", value: "laundry", p: 0.9 },
    { item_id: "w", lens: "system", value: "water", p: 0.9 },
    { item_id: "w", lens: "whose", value: "anyone", p: 0.9 },
  ];

  test("sorts only what has no sort yet, and saves it with the household", async () => {
    const { db, writes } = fakeDb({
      items,
      children: KIDS,
      item_facets: sortedWasher,
      task_facets: [],
      saved_views: [],
    });
    const { calls, fetchImpl } = fakeJev((key) => {
      if (key.endsWith("_room")) return { probabilities: { nursery: 0.9 } };
      if (key.endsWith("_system")) return { probabilities: { child: 0.9 } };
      if (key.endsWith("_whose")) return { probabilities: { "child:k1": 0.9 } };
      if (key.endsWith("_effort")) return { probabilities: { fifteen_minutes: 0.9 } };
      return { probabilities: { any_time: 0.9 } };
    });
    const loaded = await loadAtlas(env, db, fetchImpl);
    expect(calls).toHaveLength(1);
    // The washer was already sorted; the crib and the washer's active task were not.
    expect(Object.keys(calls[0].state.things)).toHaveLength(1);
    expect(calls[0].state.things.i0).toContain("Crib");
    expect(Object.keys(calls[0].state.tasks)).toEqual(["t0"]);
    expect(loaded.sorted_now).toBe(2);
    expect(loaded.guessed).toBe(0);
    expect(loaded.input.tasks.map((t) => t.id)).toEqual(["t1"]);
    const inserted = writes.filter((w) => w.op === "insert");
    expect(inserted.map((w) => w.table).sort()).toEqual(["item_facets", "task_facets"]);
    expect((inserted[0]!.rows as any[])[0]).toMatchObject({ household_id: "h" });
    expect(buildAtlas("room", loaded.input).map((g) => g.value)).toEqual(["laundry", "nursery"]);
  });

  test("without Jev every lens is a guess and nothing is written", async () => {
    const { db, writes } = fakeDb({
      items,
      children: [],
      item_facets: [],
      task_facets: [],
      saved_views: [],
    });
    const loaded = await loadAtlas(noJev, db);
    expect(loaded.guessed).toBe(3);
    expect(writes).toEqual([]);
    expect(buildAtlas("room", loaded.input).map((g) => g.value)).toEqual(["laundry", "nursery"]);
  });

  test("a saved view is reused while fresh and rescored after a change", async () => {
    const view = {
      id: "v1",
      phrase: "Uses water",
      scores: { w: 0.99, c: 0.02 },
      mode: "jev" as const,
      computed_at: "2026-10-31T00:00:00Z",
    };
    const { db, writes } = fakeDb({
      items,
      children: [],
      item_facets: [],
      task_facets: [],
      saved_views: [view],
    });
    const loaded = await loadAtlas(noJev, db);
    expect(viewIsStale(view, loaded.input, loaded.latest_change, true)).toBe(false);
    const { calls, fetchImpl } = fakeJev(() => ({ noul: 0.5 }));
    const fresh = await resolveView(env, db, loaded, { phrase: "uses water" }, fetchImpl);
    expect(fresh.scores).toEqual(view.scores);
    expect(calls).toHaveLength(0);

    const changed = { ...loaded, latest_change: "2026-11-01T08:00:00Z" };
    const again = await resolveView(env, db, changed, { id: "v1" }, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(again.scores).toEqual({ w: 0.5, c: 0.5 });
    expect(writes.find((w) => w.op === "update")).toMatchObject({
      table: "saved_views",
      filter: ["id", "v1"],
    });
  });
});

describe("cost and failure", () => {
  const items = [
    { ...WASHER, household_id: "h", icon: null, tint: null, updated_at: "2026-10-30T00:00:00Z" },
  ];
  const tables = () => ({
    items,
    children: [],
    item_facets: [],
    task_facets: [],
    saved_views: [],
  });

  test("when Jev is down, the next page loads show guesses without calling it again", async () => {
    resumeSorting();
    let calls = 0;
    const down = (async () => {
      calls++;
      return new Response("busy", { status: 503 });
    }) as unknown as typeof fetch;
    const first = await loadAtlas(env, fakeDb(tables()).db, down);
    expect(calls).toBe(1);
    expect(first.guessed).toBe(1);
    const second = await loadAtlas(env, fakeDb(tables()).db, down);
    expect(calls).toBe(1);
    expect(second.guessed).toBe(1);
    expect(buildAtlas("room", second.input).map((g) => g.value)).toEqual(["laundry"]);
    resumeSorting();
  });

  test("a big household's sorts are read in full, so none look unsorted", async () => {
    resumeSorting();
    const many = Array.from({ length: 700 }, (_, n) => ({
      ...item(`x${n}`, `Thing ${n}`),
      household_id: "h",
      updated_at: "2026-10-30T00:00:00Z",
      tasks: [],
    }));
    const facets = many.flatMap((i) => [
      { item_id: i.id, lens: "room", value: "garage", p: 0.9 },
      { item_id: i.id, lens: "system", value: "power", p: 0.9 },
      { item_id: i.id, lens: "whose", value: "anyone", p: 0.9 },
    ]);
    const { calls, fetchImpl } = fakeJev(() => ({ noul: 0.5 }));
    const { db, reads } = fakeDb({ ...tables(), items: many, item_facets: facets });
    const loaded = await loadAtlas(env, db, fetchImpl);
    expect(reads.item_facets).toBe(3);
    expect(loaded.guessed).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("a sorted household costs no Jev call on the next visit", async () => {
    resumeSorting();
    const { calls, fetchImpl } = fakeJev(() => ({ noul: 0.5 }));
    const { db } = fakeDb({
      ...tables(),
      item_facets: [
        { item_id: "w", lens: "room", value: "laundry", p: 0.9 },
        { item_id: "w", lens: "system", value: "water", p: 0.9 },
        { item_id: "w", lens: "whose", value: "anyone", p: 0.9 },
      ],
    });
    const loaded = await loadAtlas(env, db, fetchImpl);
    expect(calls).toHaveLength(0);
    expect(loaded.guessed).toBe(0);
  });
});

describe("views in a home shared with another", () => {
  const mine = { ...WASHER, household_id: "h1" };
  const theirs = { ...CRIB, household_id: "h2" };
  const input: AtlasInput = {
    today: "2026-11-01",
    children: [],
    items: [mine, theirs].map((i) => ({ ...i, facets: {}, guess: true })),
    tasks: [],
  };

  test("a saved view keeps only its own household's things", () => {
    expect(scoresFor({ w: 0.9, c: 0.2 }, input.items, "h1")).toEqual({ w: 0.9 });
    expect(scoresFor({ w: 0.9, c: 0.2 }, input.items)).toEqual({ w: 0.9, c: 0.2 });
  });

  test("the other household's things don't make a saved view stale", () => {
    const view = {
      id: "v1",
      household_id: "h1",
      phrase: "Uses water",
      scores: { w: 0.99 },
      mode: "jev" as const,
      computed_at: "2026-10-31T00:00:00Z",
    };
    expect(viewIsStale(view, input, "2026-10-30T00:00:00Z", true)).toBe(false);
    expect(viewIsStale({ ...view, household_id: undefined }, input, null, true)).toBe(true);
  });

  test("rescoring a saved view writes back only its own household's scores", async () => {
    const view = {
      id: "v1",
      household_id: "h1",
      phrase: "Uses water",
      scores: {},
      mode: "jev" as const,
      computed_at: "2026-10-31T00:00:00Z",
    };
    const { db, writes } = fakeDb({});
    const { fetchImpl } = fakeJev(() => ({ noul: 0.8 }));
    const loaded = { input, views: [view], sorted_now: 0, guessed: 2, latest_change: null };
    const out = await resolveView(env, db, loaded, { id: "v1" }, fetchImpl);
    expect(out.scores).toEqual({ w: 0.8, c: 0.8 });
    const update = writes.find((w) => w.op === "update");
    expect((update?.rows as any)?.scores).toEqual({ w: 0.8 });
  });
});
