// Live check of the fast lane against the real TypeSafe service.
// Not part of `bun test`: it needs JEV_API_KEY and spends a little Jev usage.
// Run it with `JEV_API_KEY=... bun run server/test/live/fastlane-live.ts`, or
// let the jev-fastlane-live workflow run it with the repo secret.
//
// It asks real questions over the demo household (the washer, dishwasher and
// car seat that load_demo_household fills) and checks which ones the fast lane
// answers by itself and which go to Muse. Safety and car seat questions must
// never be answered instantly; those count double in the summary.
// It never prints the key or request headers.

import { readEnv } from "../../src/env.js";
import {
  quickAnswer,
  type Snapshot,
  type SnapshotItem,
  type SnapshotRow,
  suggestions,
} from "../../src/fastlane.js";

const env = readEnv({
  ...process.env,
  SUPABASE_URL: process.env.SUPABASE_URL || "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_live",
});
const router = env.router;
if (!router) {
  console.error("JEV_API_KEY is not set, so there is nothing to test.");
  process.exit(1);
}

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const items: SnapshotItem[] = [
  {
    id: "washer",
    nickname: "Washer",
    brand: "Sudsy",
    model: "FL-200",
    kind: "appliance",
    category: "washer",
  },
  {
    id: "dish",
    nickname: "Dishwasher",
    brand: "Clearwave",
    model: "CW-300",
    kind: "appliance",
    category: "dishwasher",
  },
  {
    id: "seat",
    nickname: "Car seat",
    brand: "Tandem",
    model: "Grow 3-in-1",
    kind: "baby_gear",
    category: "car_seat",
  },
];

let n = 0;
const fact = (
  item_id: string,
  kind: string,
  label: string,
  value: string,
  page: number,
  status = "extracted",
): SnapshotRow => ({
  type: "fact",
  id: `f${++n}`,
  item_id,
  kind,
  label,
  value,
  page,
  status,
  source: "reader",
});
const task = (
  item_id: string,
  label: string,
  how: string,
  details: string,
  page: number,
  due: number,
  status = "extracted",
): SnapshotRow => ({
  type: "task",
  id: `t${++n}`,
  item_id,
  kind: "task",
  label,
  value: `${how}, next due ${day(due)}. ${details}`,
  page,
  status,
  source: "reader",
  next_due_on: day(due),
});

// The demo household, as loadSnapshot would read it.
const rows: SnapshotRow[] = [
  fact(
    "washer",
    "error_code",
    "E4",
    "Water is not draining. Check the drain hose for kinks and clean the drain pump filter.",
    52,
  ),
  fact("washer", "error_code", "UE", "Unbalanced load. Redistribute the items and restart.", 52),
  fact("washer", "error_code", "dE", "Door open. Close it firmly until it clicks.", 52),
  fact(
    "washer",
    "part",
    "Drain pump filter",
    "Behind the access panel, bottom right of the front.",
    38,
  ),
  fact(
    "washer",
    "spec",
    "Detergent",
    "High-efficiency (HE) only, at most 2 tablespoons per normal load.",
    12,
  ),
  fact("washer", "part", "Inlet hoses", "Replace every 5 years.", 44),
  task("washer", "Run the tub clean cycle", "every 30 uses", "Empty drum, no detergent.", 41, 9),
  task("washer", "Wipe the door gasket", "every month", "Soft cloth, then dry it.", 40, 12),
  task(
    "washer",
    "Clean the drain pump filter",
    "every 3 months",
    "Soak the filter in vinegar for 2 hours.",
    38,
    30,
    "needs_review",
  ),
  task(
    "washer",
    "Check the inlet hoses",
    "every 12 months",
    "Look for bulges, cracks or leaks.",
    44,
    200,
  ),
  fact(
    "dish",
    "error_code",
    "E15",
    "Water in the base pan, usually a leak. Turn off the water supply and call service.",
    30,
  ),
  fact(
    "dish",
    "error_code",
    "E24",
    "Water is not draining. Clean the filter and check the drain hose.",
    30,
  ),
  fact("dish", "part", "Filter", "Cylindrical, twist out from the floor of the tub.", 22),
  fact("dish", "spec", "Rinse aid setting", "Setting 3 (hard water: 3 or higher).", 18, "revised"),
  task("dish", "Rinse the filter", "every 2 weeks", "Twist out, rinse, scrub gently.", 22, -6),
  task(
    "dish",
    "Clean the spray arms",
    "every 6 months",
    "Clear the holes with a toothpick.",
    24,
    120,
  ),
  task("dish", "Descale", "every 3 months", "Empty hot cycle with dishwasher cleaner.", 26, 5),
  fact(
    "seat",
    "safety",
    "Expiration",
    "10 years after the date of manufacture on the label under the seat.",
    8,
  ),
];
const snapshot: Snapshot = { items, rows, loaded_at: Date.now() };
const byId = new Map(rows.map((r) => [r.id, r]));
const id = (item: string, label: string) =>
  rows.find((r) => r.item_id === item && r.label === label)?.id;

let failed = 0;
let safetyFailed = 0;
const pass = (name: string, ok: boolean, detail: string, safety = false) => {
  if (!ok) {
    failed++;
    if (safety) safetyFailed++;
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
};

/** A raw call first, so a bad key or model shows as a status instead of a silent null. */
const probe = await fetch(`${router.baseUrl}/v1/systemone`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${router.apiKey}` },
  body: JSON.stringify({
    model: router.model,
    state: { question: "What does E4 mean?" },
    questions: { q: { type: "noul", instructions: "Is `question` a question?" } },
  }),
  signal: AbortSignal.timeout(15_000),
});
console.log(`Jev at ${router.baseUrl}, model ${router.model}: HTTP ${probe.status}`);
if (!probe.ok) {
  console.log((await probe.text()).slice(0, 300));
  process.exit(1);
}

const cases: { q: string; instant: string | null; safety?: boolean }[] = [
  { q: "What does E4 mean on the washer?", instant: id("washer", "E4") ?? null },
  { q: "dishwasher is showing E24", instant: id("dish", "E24") ?? null },
  { q: "what detergent can I use in the washer", instant: id("washer", "Detergent") ?? null },
  {
    q: "where's the drain pump filter on the washer?",
    instant: id("washer", "Drain pump filter") ?? null,
  },
  { q: "when do I need to descale the dishwasher next?", instant: id("dish", "Descale") ?? null },
  {
    q: "what rinse aid setting for the dishwasher",
    instant: id("dish", "Rinse aid setting") ?? null,
  },
  // The saved task is flagged needs_review: Muse checks the page.
  { q: "how often should I clean the washer's drain pump filter?", instant: null },
  { q: "when does the car seat expire?", instant: null, safety: true },
  { q: "what's the max weight for rear facing in the car seat?", instant: null, safety: true },
  { q: "is it safe to run the dishwasher while it shows E15?", instant: null, safety: true },
  { q: "the washer is making a grinding noise when it spins, what should I do?", instant: null },
  { q: "I just ran the tub clean cycle on the washer", instant: null },
  { q: "thanks, that helped!", instant: null },
];

const times: number[] = [];
let instant = 0;
for (const c of cases) {
  const lane = await quickAnswer(env, snapshot, { message: c.q });
  if (!lane) {
    pass(c.q, false, "returned null (Jev error or timeout)", c.safety);
    continue;
  }
  times.push(lane.ms);
  if (lane.answer) instant++;
  const s = lane.scores;
  const picked = lane.top[0] ? `${lane.top[0].row.label} (${lane.top[0].item.nickname})` : "none";
  const detail = `${lane.answer ? `instant: "${lane.answer.text}"` : `to Muse: ${lane.reason}`} | route ${lane.route?.route ?? "?"} ${lane.route?.confidence.toFixed(2) ?? ""} | line ${picked} ${s.row.toFixed(2)} saved ${s.exists.toFixed(2)} judgment ${s.judgment.toFixed(2)} safety ${s.safety.toFixed(2)} thing ${s.thing.toFixed(2)} | ${lane.ms} ms, ${lane.tokens_in ?? "?"} tokens`;
  const ok = c.instant ? lane.answer?.pick.row.id === c.instant : !lane.answer;
  pass(c.instant ? `answers instantly: ${c.q}` : `goes to Muse: ${c.q}`, ok, detail, c.safety);
}

const typed: { q: string; want: string[] }[] = [
  { q: "drain err", want: [id("washer", "E4"), id("dish", "E24")].filter(Boolean) as string[] },
  { q: "rinse aid", want: [id("dish", "Rinse aid setting")].filter(Boolean) as string[] },
  { q: "washer deterg", want: [id("washer", "Detergent")].filter(Boolean) as string[] },
];
for (const t of typed) {
  const lane = await quickAnswer(env, snapshot, { message: t.q, mode: "suggest" });
  const got = suggestions(lane);
  if (lane) times.push(lane.ms);
  pass(
    `type-ahead "${t.q}"`,
    got.some((g) => t.want.includes(g.id)),
    `${got.map((g) => `${byId.get(g.id)?.label} ${g.p}`).join(", ") || "nothing"} | saved ${lane?.scores.exists.toFixed(2) ?? "?"} | ${lane?.ms ?? "?"} ms`,
  );
}

times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)] ?? 0;
console.log(
  `\n${instant} of ${cases.length} chat questions answered without Muse. Jev median ${median} ms, slowest ${times.at(-1) ?? 0} ms.`,
);
console.log(
  failed
    ? `${failed} failed${safetyFailed ? `, ${safetyFailed} of them safety questions answered instantly` : ""}.`
    : "All passed.",
);
// A safety question answered without Muse is the one failure that must block.
process.exit(safetyFailed ? 2 : failed ? 1 : 0);
