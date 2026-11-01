// Live check of House Atlas against the real TypeSafe (Jev) service.
// Not part of `bun test`: it needs JEV_API_KEY and spends a fraction of a cent.
// Without the key it says so and exits 0, so it never fails a local run.
// Run it with `JEV_API_KEY=... bun run server/test/live/atlas-live.ts`, or let
// the jev-atlas-live workflow run it with the repo secret.
//
// It sorts a small example household along every lens and scores two views,
// then checks Jev's top picks against what any person would say. Sorting fails
// open in the app (a failed call leaves keyword guesses), so a raw call comes
// first to surface the HTTP status. It never prints the key or headers.

import {
  type AtlasItem,
  type AtlasTask,
  buildAtlas,
  type Facets,
  foldFacets,
  scoreView,
  sortFacets,
  VIEW_BAR,
} from "../../src/atlas.js";
import { readEnv } from "../../src/env.js";
import { pageKinds } from "../../src/finder/page-kinds.js";

const env = readEnv({
  ...process.env,
  SUPABASE_URL: process.env.SUPABASE_URL || "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_live",
});
const router = env.router;
if (!router) {
  console.log("SKIP  JEV_API_KEY is not set, so the live atlas checks didn't run.");
  process.exit(0);
}

const thing = (id: string, nickname: string, extra: Partial<AtlasItem> = {}): AtlasItem => ({
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
const children = [{ id: "k1", nickname: "Rio" }];
const items: AtlasItem[] = [
  thing("washer", "Washer", { brand: "Whirlpool", model: "WTW5000DW", category: "washer" }),
  thing("dish", "Dishwasher", { brand: "Bosch", model: "SHPM65Z55N", category: "dishwasher" }),
  thing("fridge", "Fridge", { brand: "GE", model: "GNE27JYMFS", category: "refrigerator" }),
  thing("heater", "Water heater", { brand: "Rheem", model: "XE40M06ST45U1" }),
  thing("furnace", "Furnace", { brand: "Carrier", model: "59SC5A" }),
  thing("smoke", "Smoke alarms", { brand: "First Alert", model: "SC5" }),
  thing("seat", "Car seat", {
    brand: "Graco",
    model: "4Ever DLX",
    kind: "baby_gear",
    category: "car_seat",
    child_id: "k1",
  }),
  thing("crib", "Crib", {
    brand: "Babyletto",
    model: "Hudson",
    kind: "baby_gear",
    category: "crib",
  }),
  thing("mower", "Lawn mower", { brand: "EGO", model: "LM2135SP" }),
  thing("humid", "Humidifier", {
    brand: "Levoit",
    model: "LV600HH",
    notes: "Runs in Rio's room at night",
  }),
];
const task = (id: string, item_id: string, title: string): AtlasTask => ({
  id,
  item_id,
  title,
  details: null,
  next_due_on: null,
});
const tasks: AtlasTask[] = [
  task("t_alarm", "smoke", "Test every alarm"),
  task("t_flush", "heater", "Flush the tank to remove sediment"),
  task("t_mower", "mower", "Store the battery indoors for the winter"),
  task("t_filter", "furnace", "Change the air filter"),
  task("t_burner", "furnace", "Have a qualified technician inspect the burners and heat exchanger"),
  task("t_pump", "washer", "Clean the drain pump filter"),
];

let failed = 0;
const pass = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};

// 1. A raw call, so an auth or schema problem shows its status instead of a silent fallback.
{
  const res = await fetch(`${router.baseUrl}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${router.apiKey}` },
    body: JSON.stringify({
      model: router.model,
      state: { thing: "Washer (Whirlpool WTW5000DW)" },
      questions: {
        room: {
          type: "choice",
          instructions: "Which room is it in?",
          criteria: { laundry: "Laundry room", kitchen: "Kitchen" },
        },
      },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { answers?: { room?: unknown } };
  pass(
    "raw call",
    res.ok,
    `HTTP ${res.status} ${JSON.stringify(body.answers?.room ?? body).slice(0, 200)}`,
  );
  if (!res.ok) process.exit(1);
}

// 2. Sort every lens in as few calls as the batching allows.
const started = Date.now();
const sorted = await sortFacets(env, { items, tasks, children, all: items }, fetch);
const ms = Date.now() - started;
pass(
  "sorted everything",
  sorted.sorted.size === items.length + tasks.length,
  `${sorted.sorted.size}/${items.length + tasks.length} in ${ms} ms, ${sorted.tokens_in} input tokens`,
);
const facets = foldFacets(sorted.rows);
const top = (id: string, lens: keyof Facets) =>
  Object.entries(facets.get(id)?.[lens] ?? {}).sort((a, b) => b[1] - a[1])[0];
const expectTop = (id: string, lens: keyof Facets, ok: string[]) => {
  const [value, p] = top(id, lens) ?? ["(none)", 0];
  const all = JSON.stringify(facets.get(id)?.[lens] ?? {});
  pass(
    `${id} ${lens}`,
    ok.includes(value),
    `top ${value} ${p.toFixed(2)} (want ${ok.join("|")}) ${all}`,
  );
};
expectTop("washer", "room", ["laundry"]);
expectTop("dish", "room", ["kitchen"]);
expectTop("seat", "room", ["car"]);
expectTop("crib", "room", ["nursery"]);
expectTop("humid", "room", ["nursery", "bedroom"]);
expectTop("mower", "room", ["garage", "outdoors"]);
expectTop("heater", "room", ["basement", "garage"]);
expectTop("smoke", "room", ["whole_house"]);
expectTop("dish", "system", ["water"]);
expectTop("smoke", "system", ["safety"]);
expectTop("furnace", "system", ["air_heat"]);
expectTop("crib", "system", ["child", "safety"]);
expectTop("seat", "whose", ["child:k1"]);
expectTop("mower", "whose", ["adult"]);
expectTop("t_alarm", "effort", ["five_minutes"]);
expectTop("t_flush", "effort", ["afternoon", "pro"]);
expectTop("t_burner", "effort", ["pro"]);
expectTop("t_mower", "season", ["before_winter"]);
expectTop("t_filter", "season", ["any_time", "before_winter"]);
expectTop("t_pump", "season", ["any_time"]);

// 3. Views in plain words: one yes/no per thing.
const view = async (phrase: string, yes: string[], no: string[]) => {
  const t0 = Date.now();
  const out = await scoreView(env, phrase, items, tasks, fetch);
  const took = Date.now() - t0;
  const fmt = Object.entries(out.scores)
    .sort((a, b) => b[1] - a[1])
    .map(([k, p]) => `${k} ${p.toFixed(2)}`)
    .join(", ");
  pass(`view "${phrase}" mode`, out.mode === "jev", `${out.mode} in ${took} ms: ${fmt}`);
  for (const id of yes)
    pass(`  ${id} fits`, (out.scores[id] ?? 0) >= VIEW_BAR, `${out.scores[id]}`);
  for (const id of no) pass(`  ${id} doesn't`, (out.scores[id] ?? 1) < 0.4, `${out.scores[id]}`);
  return out;
};
const flood = await view(
  "things that could flood the floor",
  ["washer", "dish", "heater"],
  ["crib", "smoke", "mower"],
);
await view("baby safety", ["seat", "crib"], ["mower", "dish"]);

// 4. The map itself, from the live sort.
const input = {
  today: new Date().toISOString().slice(0, 10),
  children,
  items: items.map((i) => ({ ...i, facets: facets.get(i.id) ?? {}, guess: false })),
  tasks: tasks.map((t) => ({ ...t, facets: facets.get(t.id) ?? {}, guess: false })),
};
for (const lens of ["room", "system", "whose", "effort", "season"] as const) {
  const groups = buildAtlas(lens, input);
  console.log(
    `map ${lens}: ${groups.map((g) => `${g.label} [${g.entries.map((e) => (e.type === "task" ? e.task : e.name)).join("; ")}]`).join("  ")}`,
  );
}
const floodMap = buildAtlas("room", input, { scores: flood.scores });
console.log(
  `map room + flood view: ${floodMap.map((g) => `${g.label} [${g.entries.map((e) => `${e.name}${e.maybe ? "?" : ""}`).join("; ")}]`).join("  ")}`,
);

// 5. Manual atlas: each page of a manual gets a kind.
{
  const page = (page_number: number, content: string) => ({ page_number, content });
  const manual = [
    page(
      2,
      "IMPORTANT SAFETY INSTRUCTIONS. WARNING: To reduce the risk of fire, electric shock, or injury to persons, read all instructions before using this washer. Do not allow children to play on or in the washer.",
    ),
    page(
      7,
      "Installation. Level the washer: adjust the front leveling legs until the washer is steady. Connect the inlet hoses to the hot and cold water faucets, then route the drain hose into a standpipe.",
    ),
    page(
      18,
      "Cleaning the drain pump filter. Once a month, open the access panel at the lower front, place a shallow pan under it, unscrew the filter counterclockwise, rinse it under running water and screw it back in.",
    ),
    page(
      31,
      "Troubleshooting. Error code F9 E1: the washer is draining too slowly. Check that the drain hose is not kinked and the drain pump filter is not clogged. Error code F5 E2: the lid will not lock.",
    ),
    page(
      40,
      "LIMITED WARRANTY. For one year from the date of purchase, when this major appliance is installed, operated and maintained according to the instructions, the maker will pay for factory specified parts and repair labor.",
    ),
  ];
  const t0 = Date.now();
  const got = await pageKinds(env, manual, fetch);
  const took = Date.now() - t0;
  const want: Record<number, string[]> = {
    2: ["safety"],
    7: ["setup"],
    18: ["care", "fix"],
    31: ["fix"],
    40: ["warranty"],
  };
  pass(
    "page kinds call",
    got.failed === 0 && got.kinds.size === manual.length,
    `${got.kinds.size}/${manual.length} in ${took} ms, ${got.tokens_in} input tokens`,
  );
  for (const [n, ok] of Object.entries(want)) {
    const k = got.kinds.get(Number(n));
    pass(
      `  page ${n}`,
      !!k && ok.includes(k.kind),
      `${k?.kind ?? "(none)"} ${k?.p ?? ""} (want ${ok.join("|")})`,
    );
  }
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
