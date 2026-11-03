import type { Env } from "../env.js";

// A thing can have several guides: a Ninja air fryer comes with an owner's
// manual, a quick start sheet and a recipe book. Each manual gets a kind
// (null until it's known), guessed from its title and cover page when it's
// read, with Jev asked only when the words don't say. The owner's manual is
// the primary one: it wins for safety rules and limits.
//
// The second guide repeats much of the first. A task it repeats isn't saved
// twice: the existing task gets "Also in the Quick start, p. 4." instead. A
// fact it states differently is saved flagged, with a note naming the other
// guide's value and page, so the second read and the owner look at both.

export const GUIDE_KINDS = ["owner", "quick_start", "recipes", "other"] as const;
export type GuideKind = (typeof GUIDE_KINDS)[number];

export const GUIDE_LABELS: Record<GuideKind, string> = {
  owner: "Owner's manual",
  quick_start: "Quick start",
  recipes: "Recipe book",
  other: "Guide",
};

export interface GuideRow {
  id: string;
  title?: string | null;
  kind?: string | null;
  created_at?: string | null;
}

const isKind = (k: unknown): k is GuideKind => GUIDE_KINDS.includes(k as GuideKind);

/** "AF101_QSG_EN.pdf" as "AF101 QSG EN": a file name read as words. */
export function cleanTitle(title: string | null | undefined): string {
  return (title ?? "")
    .replace(/\.pdf$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** What to call a guide: its kind, else its title, else "another guide". */
export function guideName(m: GuideRow | null | undefined): string {
  if (!m) return "another guide";
  if (isKind(m.kind) && m.kind !== "other") return GUIDE_LABELS[m.kind];
  return cleanTitle(m.title) || "another guide";
}

/** The owner's manual if there is one, else the first guide added. */
export function primaryManual<T extends GuideRow>(manuals: T[] | null | undefined): T | null {
  const list = [...(manuals ?? [])].sort((a, b) =>
    (a.created_at ?? "").localeCompare(b.created_at ?? ""),
  );
  return list.find((m) => m.kind === "owner") ?? list[0] ?? null;
}

// Words that name each kind, as they show on a cover or in a file name.
const KIND_WORDS: [GuideKind, RegExp][] = [
  [
    "recipes",
    /\brecipes?\b|\brecipe book\b|\binspiration guide\b|\bcook ?book\b|\bcooking guide\b|\bcooking chart\b/,
  ],
  [
    "quick_start",
    /\bquick ?start\b|\bgetting started\b|\bquick (reference|guide|setup)\b|\bstart here\b|\bset ?up guide\b/,
  ],
  [
    "owner",
    /\bowner'?s (manual|guide)\b|\buse (and|&) care\b|\buser'?s? (manual|guide)\b|\binstruction (manual|book(let)?)\b|\boperating instructions\b|\binstructions( for use)?\b|\bowners? manual\b/,
  ],
];
/** File-name shorthands, only trusted in a title: "AF101_QSG_EN.pdf", "AF101_IB_EN.pdf". */
const TITLE_WORDS: [GuideKind, RegExp][] = [
  ["quick_start", /\bqsg\b/],
  ["owner", /\bib\b/],
];

/** The kind whose words come first in `text`, or null when none show up. */
function firstKind(text: string, patterns = KIND_WORDS): GuideKind | null {
  let best: { kind: GuideKind; at: number } | null = null;
  for (const [kind, re] of patterns) {
    const at = text.search(re);
    if (at >= 0 && (!best || at < best.at)) best = { kind, at };
  }
  return best?.kind ?? null;
}

/** How much of the cover is looked at: the type of a guide is printed near the top. */
const COVER_CHARS = 800;

/**
 * The guide's kind from its title, else from its cover page: whichever kind's
 * words come first ("Quick Start Guide ... read the owner's guide" is a quick
 * start). Null when neither says.
 */
export function guessGuideKind(
  title: string | null | undefined,
  cover: string | null | undefined,
): GuideKind | null {
  const words = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/’/g, "'");
  const named = words(cleanTitle(title));
  return (
    firstKind(named) ??
    firstKind(named, TITLE_WORDS) ??
    firstKind(words((cover ?? "").slice(0, COVER_CHARS)))
  );
}

const JEV_KINDS: Record<GuideKind, string> = {
  owner:
    "The full owner's manual or use and care guide: safety, setup, everyday use, cleaning, troubleshooting.",
  quick_start: "A short quick start or setup sheet: only the first steps to get going.",
  recipes: "A recipe book or inspiration guide: recipes, cooking charts and ideas.",
  other: "Something else: a spec sheet, installation guide, warranty card or parts list.",
};
/** Jev's pick has to be at least this likely to count. */
export const GUIDE_KIND_AT = 0.5;

/**
 * Jev's guess at the kind, for a guide whose title and cover don't say. One
 * choice question; null with Jev unset, unsure or down.
 */
export async function guideKindFromJev(
  env: Env,
  guide: { title: string | null | undefined; cover: string; page_count: number | null },
  fetchImpl: typeof fetch = fetch,
): Promise<GuideKind | null> {
  const router = env.router;
  if (!router) return null;
  try {
    const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${router.apiKey}` },
      body: JSON.stringify({
        model: router.model,
        state: {
          title: cleanTitle(guide.title).slice(0, 160),
          pages: guide.page_count,
          first_pages: guide.cover.slice(0, 1500),
        },
        questions: {
          kind: {
            type: "choice",
            instructions: "What kind of product guide is this, from its title and first pages?",
            criteria: JEV_KINDS,
          },
        },
      }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      answers?: { kind?: { choice?: string; probabilities?: Record<string, number> } };
    };
    const pick = body.answers?.kind;
    if (!pick?.choice || !isKind(pick.choice)) return null;
    const p = pick.probabilities?.[pick.choice] ?? 0;
    return p >= GUIDE_KIND_AT ? pick.choice : null;
  } catch {
    return null;
  }
}

// --- The same task in two guides ----------------------------------------------

/** Words that don't tell two tasks apart, including how often ("after every use"). */
const STOP = new Set(
  (
    "a an and or of to the your you for in on with at by from as is it its this that be " +
    "all any into up out off then if when every each after before during daily weekly monthly " +
    "yearly once month months week weeks day days year years time times use uses used regularly " +
    "periodically as needed necessary"
  ).split(" "),
);

/** Verbs guides use for the same job ("wash the plate", "clean the plate"). */
const SAME_WORD: Record<string, string> = {
  wash: "clean",
  washing: "clean",
  cleaning: "clean",
  cleaned: "clean",
  change: "replace",
  changing: "replace",
  replacing: "replace",
  inspect: "check",
  inspecting: "check",
  checking: "check",
  descaling: "descale",
  emptying: "empty",
};

/** One word in its singular-ish form, so "filters" and "filter" are the same word. */
function stem(w: string): string {
  const same = SAME_WORD[w];
  if (same) return same;
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** A title's meaningful words: lowercase, no punctuation, no stop words. */
export function titleWords(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/['’]/g, "")
    .match(/[a-z0-9]+/g);
  return new Set((words ?? []).filter((w) => !STOP.has(w)).map(stem));
}

/** Shared words over all words, 0 to 1. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Two titles this alike are the same task. */
export const SAME_TASK_AT = 0.6;

export interface TaskLike {
  title: string;
  interval_unit?: string | null;
}

/** "As needed" says nothing about how often, so it never rules a match out. */
const unitOf = (t: TaskLike) =>
  t.interval_unit && t.interval_unit !== "as_needed" ? t.interval_unit : null;

/** Whether two tasks are the same: alike titles, and the same interval unit when both have one. */
export function sameTask(a: TaskLike, b: TaskLike): boolean {
  const ua = unitOf(a);
  const ub = unitOf(b);
  if (ua && ub && ua !== ub) return false;
  return jaccard(titleWords(a.title), titleWords(b.title)) >= SAME_TASK_AT;
}

/** The existing task a new one repeats (the most alike), or null. */
export function findSameTask<T extends TaskLike>(task: TaskLike, existing: T[]): T | null {
  let best: { t: T; score: number } | null = null;
  const words = titleWords(task.title);
  for (const t of existing) {
    if (!sameTask(task, t)) continue;
    const score = jaccard(words, titleWords(t.title));
    if (!best || score > best.score) best = { t, score };
  }
  return best?.t ?? null;
}

/** The line added to a task another guide repeats: "Also in the Quick start, p. 4." */
export function alsoInLine(guide: string, page: number | null | undefined): string {
  return `Also in the ${guide}${page ? `, p. ${page}` : ""}.`;
}

/**
 * The task's details with the extra citation added, or null when it's already
 * there or wouldn't fit.
 */
export function withAlsoIn(details: string | null | undefined, line: string, max = 1000) {
  const now = details?.trim() ?? "";
  if (now.includes(line)) return null;
  const next = now ? `${now}\n${line}` : line;
  return next.length <= max ? next : null;
}

// --- The same fact, said differently -----------------------------------------

/** A fact label as a key: lowercase words, "maximum" as "max". */
export function labelKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bmaximum\b/g, "max")
    .replace(/\bminimum\b/g, "min")
    .replace(/^the /, "")
    .trim();
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const numbersIn = (s: string) =>
  new Set((s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => String(Number(n.replace(",", ".")))));
const subset = (a: Set<string>, b: Set<string>) => [...a].every((x) => b.has(x));

/**
 * Whether two values for the same label say the same thing. Numbers decide
 * when both have them ("400°F" agrees with "400°F (205°C)", not with "350°F").
 * Words only: they agree unless they share no word at all. One with numbers
 * and one without can't be told apart, so they count as agreeing.
 */
export function valuesAgree(a: string, b: string): boolean {
  const sa = squash(a);
  const sb = squash(b);
  if (sa === sb || (sa && sb.includes(sa)) || (sb && sa.includes(sb))) return true;
  const na = numbersIn(a);
  const nb = numbersIn(b);
  if (na.size && nb.size) return subset(na, nb) || subset(nb, na);
  if (na.size || nb.size) return true;
  const wa = titleWords(a);
  const wb = titleWords(b);
  return !wa.size || !wb.size || jaccard(wa, wb) > 0;
}

export interface FactLike {
  label: string;
  value: string;
  source_page?: number | null;
}

/** An existing fact with the same label that says something else, or null. */
export function findDisagreement<T extends FactLike>(fact: FactLike, existing: T[]): T | null {
  const key = labelKey(fact.label);
  if (!key) return null;
  return (
    existing.find((f) => labelKey(f.label) === key && !valuesAgree(f.value, fact.value)) ?? null
  );
}

/** The note on a fact another guide states differently. */
export function disagreementNote(guide: string, other: FactLike, max = 600): string {
  const page = other.source_page ? ` on p. ${other.source_page}` : "";
  const head = `The ${guide} says "`;
  const tail = `"${page}. Check which one fits yours.`;
  const room = max - head.length - tail.length;
  const value = other.value.length > room ? `${other.value.slice(0, room - 1)}…` : other.value;
  return `${head}${value}${tail}`;
}
