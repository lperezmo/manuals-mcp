import type { Env } from "./env.js";

// House Atlas: the household's things and upkeep tasks sorted along a few
// lenses at once, so "what's in the nursery", "what uses water" or "what can I
// do in five minutes" each have an answer. Jev answers one choice question per
// thing (or task) per lens, many in one call, and keeps the probabilities, so
// a dehumidifier that is 0.55 basement and 0.4 laundry shows in both.
//
// A view is the household's own words ("things that could flood the floor"):
// one yes/no per thing, in one call. Jev only decides where things belong;
// dates and due state come from the schedule. Without Jev every lens falls
// back to a keyword guess and views to a plain word match.

export type Subject = "item" | "task";

interface LensDef {
  label: string;
  subject: Subject;
  question: string;
  options: Record<string, string>;
}

export const LENSES = {
  room: {
    label: "Rooms",
    subject: "item",
    question: "Which part of the home is thing {id} usually kept or used in?",
    options: {
      kitchen: "Kitchen: cooking, food storage, dishes.",
      laundry: "Laundry room: washing and drying clothes.",
      nursery: "Nursery or a child's room: where a baby or child sleeps and is changed.",
      bathroom: "Bathroom: bathing, grooming, toilets.",
      bedroom: "A grown-up's bedroom.",
      living: "Living room or home office: screens, sofas, the network, cleaning gadgets.",
      basement: "Basement or utility closet: the water heater, furnace, sump pump, softener.",
      garage: "Garage or shed: tools, the mower, storage, workshop gear.",
      outdoors: "Outdoors: the yard, patio, grill, pool, garden.",
      car: "The car: car seats, the vehicle itself, things that travel in it.",
      whole_house:
        "All through the house: smoke alarms in every room, the thermostat, the network.",
    },
  },
  system: {
    label: "Systems",
    subject: "item",
    question: "Which of the home's systems does thing {id} belong to?",
    options: {
      water: "Water: it takes in, heats, holds or drains water.",
      air_heat: "Air and heat: heating, cooling, airflow, humidity, exhaust.",
      power: "Power: runs on mains or batteries and has no water, air or safety role.",
      safety: "Safety: alarms, detectors, car seats, gates, anything that protects people.",
      child: "Baby and child gear: feeding, sleeping, carrying, play.",
      none: "None of these: furniture or a plain object.",
    },
  },
  whose: {
    label: "Who it's for",
    subject: "item",
    question: "Who is thing {id} for?",
    // Filled per household: anyone, adult, and one option per child.
    options: {
      anyone: "The whole household shares it.",
      adult: "Grown-ups only: hot, heavy, sharp or powerful things, tools, the car.",
    },
  },
  effort: {
    label: "Effort",
    subject: "task",
    question: "How much time and skill does upkeep task {id} take?",
    options: {
      five_minutes: "About five minutes, no tools: a wipe, a rinse, a test button, a quick look.",
      fifteen_minutes:
        "About fifteen minutes or a simple tool: cleaning a filter, vacuuming a duct.",
      afternoon: "An afternoon or a messy job: flushing a tank, a deep clean, taking parts off.",
      pro: "Call a professional: gas, wiring, refrigerant, or the manual says a qualified technician.",
    },
  },
  season: {
    label: "Season",
    subject: "task",
    question: "When in the year does upkeep task {id} matter most?",
    options: {
      any_time: "Any time: it repeats on its own schedule, not tied to a season.",
      before_winter: "Before winter or the first frost: freezing, heating, storing for the cold.",
      before_summer: "Before summer or the first hot days: cooling, airflow, outdoor use.",
      after_storms: "After storms, floods or a power cut.",
    },
  },
} satisfies Record<string, LensDef>;

export type Lens = keyof typeof LENSES;
export const LENS_KEYS = Object.keys(LENSES) as Lens[];
export const ITEM_LENSES = LENS_KEYS.filter((l) => LENSES[l].subject === "item");
export const TASK_LENSES = LENS_KEYS.filter((l) => LENSES[l].subject === "task");

/** Probabilities below this aren't stored (the top pick always is). */
export const KEEP_P = 0.15;
/** A thing also shows in a second group when Jev gives it at least this. */
export const ALSO_P = 0.35;
/** A view keeps things at or above this, and fades the ones down to MAYBE_P. */
export const VIEW_BAR = 0.6;
export const MAYBE_P = 0.4;
/** Questions per Jev call; bigger households are split into a few calls sent together. */
const QUESTIONS_PER_CALL = 60;
/** The sort runs while the Atlas page waits, so a slow Jev gives up and the page shows guesses. */
const SORT_TIMEOUT_MS = 6_000;
/** Due within this many days counts as soon. */
export const SOON_DAYS = 7;

export interface AtlasChild {
  id: string;
  nickname: string;
}

export interface AtlasItem {
  id: string;
  kind: string;
  category: string | null;
  nickname: string;
  brand: string | null;
  model: string | null;
  child_id: string | null;
  notes: string | null;
  icon?: string | null;
  tint?: string | null;
  household_id?: string;
  updated_at?: string;
}

export interface AtlasTask {
  id: string;
  item_id: string;
  title: string;
  details: string | null;
  next_due_on: string | null;
}

/** Probability per option for one lens. */
export type Facet = Record<string, number>;
export type Facets = Partial<Record<Lens, Facet>>;

export interface FacetRow {
  subject: Subject;
  id: string;
  lens: Lens;
  value: string;
  p: number;
}

/** The options for a lens in this household ("whose" gets one per child). */
export function lensOptions(lens: Lens, children: AtlasChild[] = []): Record<string, string> {
  if (lens !== "whose") return LENSES[lens].options;
  const out: Record<string, string> = { ...LENSES.whose.options };
  if (children.length === 0) {
    out.child = "A baby or child: their car seat, crib, monitor, stroller or toys.";
  }
  for (const c of children) {
    out[`child:${c.id}`] =
      `${c.nickname.slice(0, 40)}, a child here: their own car seat, crib, monitor or gear.`;
  }
  return out;
}

/** Short names for the tiles and tool replies. */
const LABELS: Record<string, string> = {
  kitchen: "Kitchen",
  laundry: "Laundry",
  nursery: "Nursery",
  bathroom: "Bathroom",
  bedroom: "Bedroom",
  living: "Living room",
  basement: "Basement",
  garage: "Garage",
  outdoors: "Outdoors",
  car: "Car",
  whole_house: "Whole house",
  water: "Water",
  air_heat: "Air and heat",
  power: "Power",
  safety: "Safety",
  child: "Child gear",
  none: "Other",
  anyone: "Anyone",
  adult: "Grown-ups",
  five_minutes: "5 minutes",
  fifteen_minutes: "15 minutes",
  afternoon: "An afternoon",
  pro: "Call a pro",
  any_time: "Any time",
  before_winter: "Before winter",
  before_summer: "Before summer",
  after_storms: "After storms",
};

/** A plain label for an option, for tiles and tool replies. */
export function optionLabel(lens: Lens, value: string, children: AtlasChild[] = []): string {
  if (value.startsWith("child:")) {
    return children.find((c) => `child:${c.id}` === value)?.nickname ?? "A child";
  }
  if (lens === "whose" && value === "child") return "A child";
  return LABELS[value] ?? value;
}

function describeItem(item: AtlasItem, tasks: AtlasTask[] = []): string {
  const make = [item.brand, item.model].filter(Boolean).join(" ");
  const parts = [
    make ? `${item.nickname} (${make})` : item.nickname,
    item.category ? `a ${item.category.replace(/_/g, " ")}` : null,
    item.kind === "baby_gear" ? "baby gear" : item.kind === "vehicle" ? "a vehicle" : null,
    item.notes ? `notes: ${item.notes}` : null,
    tasks.length
      ? `upkeep: ${tasks
          .slice(0, 6)
          .map((t) => t.title)
          .join("; ")}`
      : null,
  ];
  return parts.filter(Boolean).join(", ").slice(0, 500);
}

function describeTask(task: AtlasTask, item: AtlasItem | undefined): string {
  return `${item?.nickname ?? "A thing"}: ${task.title}. ${task.details ?? ""}`
    .trim()
    .slice(0, 500);
}

interface Ask {
  subject: Subject;
  id: string;
  key: string;
  text: string;
  lenses: Lens[];
}

/** Turns one Jev answer into kept probabilities. */
function keep(answer: unknown, options: Record<string, string>): Facet | null {
  const a = answer as
    | { choice?: string; confidence?: number; probabilities?: Record<string, number> }
    | undefined;
  if (!a) return null;
  let probs: Record<string, number> = {};
  if (a.probabilities && typeof a.probabilities === "object") probs = a.probabilities;
  else if (a.choice && typeof a.confidence === "number") probs = { [a.choice]: a.confidence };
  const entries = Object.entries(probs).filter(
    ([k, p]) => k in options && typeof p === "number" && Number.isFinite(p),
  );
  if (!entries.length) return null;
  entries.sort((x, y) => y[1] - x[1]);
  const out: Facet = {};
  entries.forEach(([k, p], i) => {
    if (i === 0 || p >= KEEP_P) out[k] = Math.round(Math.min(1, Math.max(0, p)) * 1000) / 1000;
  });
  return out;
}

export interface SortResult {
  rows: FacetRow[];
  /** Subjects Jev answered for, so the rest can fall back to a guess. */
  sorted: Set<string>;
  tokens_in: number;
  /** Calls sent, and how many of them failed (an error, a timeout or a non-2xx). */
  calls: number;
  failed: number;
}

/**
 * Sorts things and tasks along every lens that applies to them. One Jev call
 * per QUESTIONS_PER_CALL questions, all sent at once. A call that fails leaves
 * its subjects unsorted (the caller guesses for those and tries again later).
 */
export async function sortFacets(
  env: Env,
  input: { items: AtlasItem[]; tasks: AtlasTask[]; children: AtlasChild[]; all: AtlasItem[] },
  fetchImpl: typeof fetch = fetch,
): Promise<SortResult> {
  const router = env.router;
  const out: SortResult = { rows: [], sorted: new Set(), tokens_in: 0, calls: 0, failed: 0 };
  if (!router) return out;
  const byId = new Map(input.all.map((i) => [i.id, i]));
  const asks: Ask[] = [
    ...input.items.map((item, n) => ({
      subject: "item" as const,
      id: item.id,
      key: `i${n}`,
      text: describeItem(
        item,
        input.tasks.filter((t) => t.item_id === item.id),
      ),
      lenses: ITEM_LENSES,
    })),
    ...input.tasks.map((task, n) => ({
      subject: "task" as const,
      id: task.id,
      key: `t${n}`,
      text: describeTask(task, byId.get(task.item_id)),
      lenses: TASK_LENSES,
    })),
  ];
  const chunks: Ask[][] = [];
  let current: Ask[] = [];
  let count = 0;
  for (const ask of asks) {
    if (count + ask.lenses.length > QUESTIONS_PER_CALL && current.length) {
      chunks.push(current);
      current = [];
      count = 0;
    }
    current.push(ask);
    count += ask.lenses.length;
  }
  if (current.length) chunks.push(current);
  const options = Object.fromEntries(
    LENS_KEYS.map((l) => [l, lensOptions(l, input.children)]),
  ) as Record<Lens, Record<string, string>>;

  out.calls = chunks.length;
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${router.apiKey}`,
          },
          body: JSON.stringify({
            model: router.model,
            state: {
              home: "A family home. Each entry is a thing they own or an upkeep task for one.",
              things: Object.fromEntries(
                chunk.filter((a) => a.subject === "item").map((a) => [a.key, a.text]),
              ),
              tasks: Object.fromEntries(
                chunk.filter((a) => a.subject === "task").map((a) => [a.key, a.text]),
              ),
            },
            questions: Object.fromEntries(
              chunk.flatMap((a) =>
                a.lenses.map((lens) => [
                  `${a.key}_${lens}`,
                  {
                    type: "choice",
                    instructions: LENSES[lens].question.replace("{id}", a.key),
                    criteria: options[lens],
                  },
                ]),
              ),
            ),
          }),
          signal: AbortSignal.timeout(SORT_TIMEOUT_MS),
        });
        if (!res.ok) {
          out.failed++;
          return;
        }
        const body = (await res.json()) as {
          answers?: Record<string, unknown>;
          usage?: { input_tokens?: number };
        };
        out.tokens_in += body.usage?.input_tokens ?? 0;
        for (const a of chunk) {
          const got: FacetRow[] = [];
          for (const lens of a.lenses) {
            const facet = keep(body.answers?.[`${a.key}_${lens}`], options[lens]);
            if (!facet) break;
            for (const [value, p] of Object.entries(facet)) {
              got.push({ subject: a.subject, id: a.id, lens, value, p });
            }
          }
          // Only a subject with every lens answered counts as sorted.
          if (got.length && new Set(got.map((g) => g.lens)).size === a.lenses.length) {
            out.rows.push(...got);
            out.sorted.add(a.id);
          }
        }
      } catch {
        out.failed++;
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Keyword guesses, for when Jev is unset, down, or hasn't sorted a thing yet
// ---------------------------------------------------------------------------

const ROOM_WORDS: [string, RegExp][] = [
  [
    "whole_house",
    /\b(smoke|carbon monoxide|co (detector|alarm)|thermostat|router|mesh (wi-?fi|router|system))\b/,
  ],
  ["car", /\b(car ?seat|booster|vehicle|car|truck|suv|minivan)\b/],
  ["laundry", /\b(washer|washing machine|dryer|iron)\b/],
  [
    "kitchen",
    /\b(dish ?washer|fridge|refrigerator|freezer|microwave|oven|range|stove|cooktop|toaster|kettle|coffee|espresso|blender|mixer|air fryer|instant pot|pressure cooker|disposal|high chair|bottle)\b/,
  ],
  ["nursery", /\b(crib|bassinet|monitor|changing|glider|bouncer|swing|sound machine|play ?yard)\b/],
  ["basement", /\b(water heater|furnace|boiler|sump|softener|dehumidifier)\b/],
  ["garage", /\b(mower|drill|saw|generator|snow ?blower|tool|bike|bicycle|stroller|wagon)\b/],
  ["outdoors", /\b(grill|sprinkler|pool|hose|trampoline|patio)\b/],
  ["bathroom", /\b(toothbrush|hair ?dryer|shaver|scale|shower|toilet|bath)\b/],
  ["bedroom", /\b(air conditioner|window ac|ac unit|mattress|bed)\b/],
  ["living", /\b(tv|television|speaker|modem|vacuum|robot|purifier|console|printer|laptop)\b/],
];

const SYSTEM_WORDS: [string, RegExp][] = [
  ["safety", /\b(smoke|carbon monoxide|alarm|detector|extinguisher|car ?seat|booster|gate)\b/],
  [
    "water",
    /\b(washer|dish ?washer|fridge|refrigerator|water|humidifier|softener|sump|faucet|toilet|sprinkler|kettle|coffee|espresso)\b/,
  ],
  [
    "air_heat",
    /\b(furnace|boiler|air conditioner|ac|heater|dryer|fan|purifier|dehumidifier|thermostat|hood|oven|range|stove)\b/,
  ],
  ["child", /\b(crib|bassinet|stroller|high chair|bouncer|swing|monitor|bottle|play ?yard)\b/],
];

function itemWords(item: AtlasItem): string {
  return [item.nickname, item.category?.replace(/_/g, " "), item.brand, item.model]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function firstMatch(table: [string, RegExp][], text: string): string | null {
  for (const [value, re] of table) if (re.test(text)) return value;
  return null;
}

export function guessItem(item: AtlasItem, children: AtlasChild[] = []): Facets {
  const words = itemWords(item);
  const room =
    firstMatch(ROOM_WORDS, words) ?? (item.kind === "vehicle" ? "car" : null) ?? "living";
  const system =
    firstMatch(SYSTEM_WORDS, words) ??
    (item.kind === "baby_gear" ? "child" : null) ??
    (item.kind === "vehicle" ? "none" : "power");
  let whose = item.kind === "vehicle" ? "adult" : "anyone";
  if (item.child_id && children.some((c) => c.id === item.child_id))
    whose = `child:${item.child_id}`;
  else if (item.kind === "baby_gear") {
    whose =
      children.length === 1 ? `child:${children[0]?.id}` : children.length ? "anyone" : "child";
  }
  return { room: { [room]: 0.5 }, system: { [system]: 0.5 }, whose: { [whose]: 0.5 } };
}

export function guessTask(task: AtlasTask): Facets {
  const words = `${task.title} ${task.details ?? ""}`.toLowerCase();
  let effort = "fifteen_minutes";
  if (/\b(technician|professional|qualified|service (center|centre)|dealer|licensed)\b/.test(words))
    effort = "pro";
  else if (
    /\b(flush|drain the tank|deep clean|disassembl|take apart|remove the (door|panel))/.test(words)
  )
    effort = "afternoon";
  else if (/^(test|check|wipe|rinse|replace the (battery|water filter)|press|look)\b/.test(words))
    effort = "five_minutes";
  let season = "any_time";
  if (
    /\b(winter|freez|frost|cold weather|heating season|store .* (indoors|for the season))/.test(
      words,
    )
  )
    season = "before_winter";
  else if (/\b(summer|cooling season|first use of the season|spring|hot weather)\b/.test(words))
    season = "before_summer";
  else if (/\b(storm|flood|power (cut|outage|failure))\b/.test(words)) season = "after_storms";
  return { effort: { [effort]: 0.5 }, season: { [season]: 0.5 } };
}

// ---------------------------------------------------------------------------
// Views in the household's own words
// ---------------------------------------------------------------------------

export interface ViewScores {
  scores: Record<string, number>;
  mode: "jev" | "text";
  tokens_in: number;
}

const STOP = new Set(
  "the a an and or of to in on for with that this things thing stuff which what my our we use uses used can could would before after any all every from".split(
    " ",
  ),
);

/** Without Jev: a thing fits when one of the phrase's words is in its name or tasks. */
export function textScores(
  phrase: string,
  items: AtlasItem[],
  tasks: AtlasTask[] = [],
): Record<string, number> {
  const words = phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => w.slice(0, Math.max(4, w.length - 2)));
  const out: Record<string, number> = {};
  for (const item of items) {
    const hay = `${itemWords(item)} ${item.notes ?? ""} ${tasks
      .filter((t) => t.item_id === item.id)
      .map((t) => t.title)
      .join(" ")}`.toLowerCase();
    out[item.id] = words.length && words.some((w) => hay.includes(w)) ? 1 : 0;
  }
  return out;
}

/** One yes/no per thing: does it fit the view? Falls back to a word match. */
export async function scoreView(
  env: Env,
  phrase: string,
  items: AtlasItem[],
  tasks: AtlasTask[] = [],
  fetchImpl: typeof fetch = fetch,
): Promise<ViewScores> {
  const router = env.router;
  const fallback = (): ViewScores => ({
    scores: textScores(phrase, items, tasks),
    mode: "text",
    tokens_in: 0,
  });
  if (!router || !items.length) return fallback();
  const clean = phrase.trim().slice(0, 120);
  const chunks: AtlasItem[][] = [];
  for (let i = 0; i < items.length; i += 100) chunks.push(items.slice(i, i + 100));
  try {
    const answers = await Promise.all(
      chunks.map(async (chunk) => {
        const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${router.apiKey}`,
          },
          body: JSON.stringify({
            model: router.model,
            state: {
              view: clean,
              things: Object.fromEntries(
                chunk.map((item, n) => [
                  `i${n}`,
                  describeItem(
                    item,
                    tasks.filter((t) => t.item_id === item.id),
                  ),
                ]),
              ),
            },
            questions: Object.fromEntries(
              chunk.map((_, n) => [
                `i${n}`,
                {
                  type: "noul",
                  instructions: `The household asked to see: "${clean}". Does thing i${n} belong in that view?`,
                  criteria: {
                    true: "Yes: the thing plainly fits what they asked to see.",
                    false: "No: it doesn't fit, or only by a stretch.",
                  },
                },
              ]),
            ),
          }),
          signal: AbortSignal.timeout(SORT_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Jev answered ${res.status}.`);
        const body = (await res.json()) as {
          answers?: Record<string, { noul?: number }>;
          usage?: { input_tokens?: number };
        };
        return { chunk, body };
      }),
    );
    const scores: Record<string, number> = {};
    let tokens = 0;
    for (const { chunk, body } of answers) {
      tokens += body.usage?.input_tokens ?? 0;
      chunk.forEach((item, n) => {
        const p = body.answers?.[`i${n}`]?.noul;
        if (typeof p === "number" && Number.isFinite(p)) {
          scores[item.id] = Math.round(Math.min(1, Math.max(0, p)) * 1000) / 1000;
        }
      });
    }
    // A reply missing most answers is no better than a word match.
    if (Object.keys(scores).length < items.length / 2) return fallback();
    // The few Jev skipped get a word match, so a saved view covers every thing
    // and doesn't look stale (and get rescored) on every visit.
    const missing = items.filter((i) => !(i.id in scores));
    if (missing.length) Object.assign(scores, textScores(phrase, missing, tasks));
    return { scores, mode: "jev", tokens_in: tokens };
  } catch {
    return fallback();
  }
}

// ---------------------------------------------------------------------------
// The map: groups, health and placement
// ---------------------------------------------------------------------------

export type DueState = "late" | "soon" | "ok" | "none";

export function dueState(day: string | null, today: string): DueState {
  if (!day) return "none";
  if (day < today) return "late";
  const soon = new Date(Date.parse(today) + SOON_DAYS * 86_400_000).toISOString().slice(0, 10);
  return day <= soon ? "soon" : "ok";
}

const RANK: Record<DueState, number> = { late: 3, soon: 2, ok: 1, none: 0 };

export interface AtlasEntry {
  type: Subject;
  id: string;
  /** The thing's id (for a task, the thing it belongs to). */
  item_id: string;
  name: string;
  /** A task's title, or a thing's next task. */
  task: string | null;
  due_on: string | null;
  state: DueState;
  /** How sure the lens is that this entry belongs in this group. */
  p: number;
  /** True when the lens is a keyword guess, not Jev's. */
  guess: boolean;
  /** The view's probability for the thing, when a view is on. */
  view_p?: number;
  /** True when a view is on and the thing is in the faded "maybe" band. */
  maybe?: boolean;
  icon?: string | null;
  tint?: string | null;
}

export interface AtlasGroup {
  value: string;
  label: string;
  late: number;
  soon: number;
  entries: AtlasEntry[];
}

export interface AtlasInput {
  items: (AtlasItem & { facets: Facets; guess: boolean })[];
  tasks: (AtlasTask & { facets: Facets; guess: boolean })[];
  children: AtlasChild[];
  today: string;
}

/** Where an entry goes: its top pick, plus any other option at ALSO_P or more. */
export function placements(facet: Facet | undefined): [string, number][] {
  const entries = Object.entries(facet ?? {}).sort((a, b) => b[1] - a[1]);
  return entries.filter(([, p], i) => i === 0 || p >= ALSO_P);
}

export function buildAtlas(
  lens: Lens,
  input: AtlasInput,
  view?: { scores: Record<string, number>; bar?: number },
): AtlasGroup[] {
  const bar = view?.bar ?? VIEW_BAR;
  const floor = Math.min(MAYBE_P, bar);
  const items = new Map(input.items.map((i) => [i.id, i]));
  const tasksOf = new Map<string, AtlasTask[]>();
  for (const t of input.tasks) tasksOf.set(t.item_id, [...(tasksOf.get(t.item_id) ?? []), t]);
  const groups = new Map<string, AtlasEntry[]>();
  const add = (value: string, entry: AtlasEntry) => {
    groups.set(value, [...(groups.get(value) ?? []), entry]);
  };
  const viewOf = (itemId: string) => {
    if (!view) return {};
    const p = view.scores[itemId] ?? 0;
    return { view_p: p, maybe: p < bar };
  };
  const shown = (itemId: string) => !view || (view.scores[itemId] ?? 0) >= floor;

  if (LENSES[lens].subject === "item") {
    for (const item of input.items) {
      if (!shown(item.id)) continue;
      const own = (tasksOf.get(item.id) ?? [])
        .filter((t) => t.next_due_on)
        .sort((a, b) => (a.next_due_on ?? "").localeCompare(b.next_due_on ?? ""));
      const worst = own.reduce<DueState>((w, t) => {
        const s = dueState(t.next_due_on, input.today);
        return RANK[s] > RANK[w] ? s : w;
      }, "none");
      for (const [value, p] of placements(item.facets[lens])) {
        add(value, {
          type: "item",
          id: item.id,
          item_id: item.id,
          name: item.nickname,
          task: own[0]?.title ?? null,
          due_on: own[0]?.next_due_on ?? null,
          state: worst,
          p,
          guess: item.guess,
          ...viewOf(item.id),
          icon: item.icon ?? null,
          tint: item.tint ?? null,
        });
      }
    }
  } else {
    for (const task of input.tasks) {
      const item = items.get(task.item_id);
      if (!item || !shown(item.id)) continue;
      for (const [value, p] of placements(task.facets[lens])) {
        add(value, {
          type: "task",
          id: task.id,
          item_id: task.item_id,
          name: item.nickname,
          task: task.title,
          due_on: task.next_due_on,
          state: dueState(task.next_due_on, input.today),
          p,
          guess: task.guess,
          ...viewOf(item.id),
          icon: item.icon ?? null,
          tint: item.tint ?? null,
        });
      }
    }
  }

  const order = Object.keys(lensOptions(lens, input.children));
  return [...groups.entries()]
    .sort((a, b) => {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    })
    .map(([value, entries]) => {
      entries.sort(
        (a, b) =>
          (view ? (b.view_p ?? 0) - (a.view_p ?? 0) : 0) ||
          RANK[b.state] - RANK[a.state] ||
          (a.due_on ?? "9999").localeCompare(b.due_on ?? "9999") ||
          a.name.localeCompare(b.name),
      );
      return {
        value,
        label: optionLabel(lens, value, input.children),
        late: entries.filter((e) => e.state === "late").length,
        soon: entries.filter((e) => e.state === "soon").length,
        entries,
      };
    });
}

/** Rows from the database, folded into facets per subject. */
export function foldFacets(
  rows: { id: string; lens: string; value: string; p: number }[],
): Map<string, Facets> {
  const out = new Map<string, Facets>();
  for (const r of rows) {
    if (!(r.lens in LENSES)) continue;
    const f = out.get(r.id) ?? {};
    const lens = r.lens as Lens;
    f[lens] = { ...(f[lens] ?? {}), [r.value]: Number(r.p) };
    out.set(r.id, f);
  }
  return out;
}

/** True when a subject has every lens that applies to it. */
export function complete(facets: Facets | undefined, subject: Subject): boolean {
  const need = subject === "item" ? ITEM_LENSES : TASK_LENSES;
  return !!facets && need.every((l) => facets[l] && Object.keys(facets[l] ?? {}).length > 0);
}
