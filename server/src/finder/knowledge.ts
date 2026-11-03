import { z } from "zod";
import type { Db } from "../db.js";
import { toCm, toKg } from "../lib/units.js";
import {
  alsoInLine,
  disagreementNote,
  findDisagreement,
  findSameTask,
  type GuideRow,
  guideName,
  withAlsoIn,
} from "./guides.js";

// The distilled layer of a manual: upkeep tasks with intervals, typed facts,
// and car seat limits, each pointing back to its page. The server's reader
// (Muse Spark) produces this shape; anything it isn't sure of is flagged for
// review instead of guessed (D6).

/** Longest text each field takes. The reader is told these, and over-long answers are trimmed. */
export const LIMITS = {
  task_title: 160,
  task_details: 1000,
  fact_label: 120,
  fact_value: 1000,
  fit_note: 600,
  tasks: 60,
  facts: 120,
  seat_modes: 4,
} as const;

const page = z.number().int().positive().optional().describe("Manual page the fact comes from.");
const unsure = z
  .boolean()
  .optional()
  .describe("True when the manual is unclear or hard to read here, so a person should check it.");

export const taskSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(LIMITS.task_title)
    .describe('Short imperative, e.g. "Run the Tub Clean cycle".'),
  details: z
    .string()
    .max(LIMITS.task_details)
    .optional()
    .describe("How to do it, briefly, in the manual's terms."),
  interval_unit: z.enum(["days", "weeks", "months", "cycles", "once", "as_needed"]),
  interval_value: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Required unless interval_unit is "once" or "as_needed". "every 30 washes" = cycles, 30.',
    ),
  source_page: page,
  unsure,
});

export const factSchema = z.object({
  kind: z.enum(["error_code", "part", "spec", "safety", "other"]).default("other"),
  label: z
    .string()
    .min(1)
    .max(LIMITS.fact_label)
    .describe('e.g. "E4", "Drain pump filter", "Max load".'),
  value: z.string().min(1).max(LIMITS.fact_value),
  source_page: page,
  unsure,
});

export const seatModeSchema = z.object({
  mode: z.enum(["rear_facing", "forward_facing", "booster_high_back", "booster_backless"]),
  weight_unit: z.enum(["kg", "lb"]).default("lb").describe("Unit the limits below are written in."),
  height_unit: z.enum(["cm", "in"]).default("in"),
  min_weight: z.number().positive().optional(),
  max_weight: z.number().positive().optional(),
  min_height: z.number().positive().optional(),
  max_height: z.number().positive().optional(),
  min_age_months: z.number().int().nonnegative().optional(),
  fit_note: z
    .string()
    .max(LIMITS.fit_note)
    .optional()
    .describe('Limits that aren\'t a number, e.g. "head 1 inch below the top of the shell".'),
  source_page: page,
  unsure,
});

export const knowledgeSchema = z.object({
  tasks: z.array(taskSchema).max(LIMITS.tasks).default([]),
  facts: z.array(factSchema).max(LIMITS.facts).default([]),
  seat_modes: z.array(seatModeSchema).max(LIMITS.seat_modes).default([]),
});

export type Knowledge = z.infer<typeof knowledgeSchema>;

export interface ReadKnowledge {
  knowledge: Knowledge;
  /** Entries with text cut to fit; each is flagged unsure so a person checks it. */
  trimmed: number;
  /** Entries left out because they still didn't fit after trimming, or past a list's cap. */
  dropped: number;
}

/**
 * Takes the reader's parsed JSON and keeps everything that fits, one entry at
 * a time. A long manual can produce a note or a value longer than a field
 * takes; that text is cut at a word and the entry is flagged unsure, so one
 * wordy entry never throws away the rest of the read.
 */
export function readKnowledge(raw: unknown): ReadKnowledge {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("the answer wasn't a JSON object");
  }
  const lists = raw as Record<string, unknown>;
  let trimmed = 0;
  let dropped = 0;
  const keep = <T>(list: unknown, schema: z.ZodType<T>, cap: number): T[] => {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) {
      dropped++;
      return [];
    }
    const out: T[] = [];
    for (const entry of list) {
      if (out.length >= cap) {
        dropped++;
        continue;
      }
      const fit = fitEntry(entry, schema);
      if (!fit) {
        dropped++;
        continue;
      }
      if (fit.trimmed) trimmed++;
      out.push(fit.value);
    }
    return out;
  };
  const knowledge: Knowledge = {
    tasks: keep(lists.tasks, taskSchema, LIMITS.tasks),
    facts: keep(lists.facts, factSchema, LIMITS.facts),
    seat_modes: keep(lists.seat_modes, seatModeSchema, LIMITS.seat_modes),
  };
  return { knowledge, trimmed, dropped };
}

/** Parses one entry, cutting any string that is too long; null when it can't fit. */
function fitEntry<T>(entry: unknown, schema: z.ZodType<T>): { value: T; trimmed: boolean } | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const draft: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  let trimmed = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    const parsed = schema.safeParse(draft);
    if (parsed.success) {
      return { value: parsed.data, trimmed };
    }
    const long = parsed.error.issues.filter(
      (i) => i.code === "too_big" && i.origin === "string" && i.path.length === 1,
    );
    if (long.length === 0 || long.length !== parsed.error.issues.length) return null;
    for (const issue of long) {
      const key = String(issue.path[0]);
      const text = draft[key];
      if (typeof text !== "string" || issue.code !== "too_big") return null;
      draft[key] = cut(text, Number(issue.maximum));
    }
    draft.unsure = true;
    trimmed = true;
  }
  return null;
}

/** Shortens text to at most max characters, at a word where one is close, ending with an ellipsis. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, Math.max(0, max - 1));
  const space = room.lastIndexOf(" ");
  const head = space >= room.length * 0.8 ? room.slice(0, space) : room;
  return `${head.trimEnd()}\u2026`;
}

export interface SaveKnowledgeArgs {
  db: Db;
  householdId: string;
  itemId: string;
  manualId: string | null;
  knowledge: Knowledge;
  /** Drop what earlier reads of this manual saved (tasks nobody has done yet, facts, seat limits). */
  replace?: boolean;
}

export async function saveKnowledge(args: SaveKnowledgeArgs) {
  const { db, householdId, itemId, manualId, knowledge } = args;
  const status = (x: { unsure?: boolean }) => (x.unsure ? "needs_review" : "extracted");

  if (args.replace && manualId) {
    // A re-read replaces only what the reader wrote: anything a person or an
    // assistant checked or rewrote stays, and so does a task already done.
    await check(
      db
        .from("tasks")
        .delete()
        .eq("source_manual_id", manualId)
        .eq("source", "reader")
        .is("last_done_on", null),
      "clear old tasks",
    );
    await check(
      db.from("manual_facts").delete().eq("manual_id", manualId).eq("source", "reader"),
      "clear old facts",
    );
  }

  // Another guide for the same thing (a quick start beside the owner's manual)
  // repeats much of it: a task it repeats gets a second citation instead of a
  // second copy, and a fact it states differently is flagged with a note.
  const others = manualId ? await otherGuides(db, itemId, manualId) : null;
  const thisGuide = guideName(others?.self);

  const kept = knowledge.tasks.filter(
    (t) => t.interval_value || t.interval_unit === "once" || t.interval_unit === "as_needed",
  );
  let repeated = 0;
  const fresh: typeof kept = [];
  for (const t of kept) {
    const same = others ? findSameTask(t, others.tasks) : null;
    if (!same) {
      fresh.push(t);
      continue;
    }
    repeated++;
    // Only the reader's own lines get the extra citation; a person's or an assistant's stay as they are.
    if (same.source !== "reader" || !same.source_manual_id) continue;
    const details = withAlsoIn(
      same.details,
      alsoInLine(thisGuide, t.source_page),
      LIMITS.task_details,
    );
    if (details === null) continue;
    same.details = details;
    await check(db.from("tasks").update({ details }).eq("id", same.id), "add a citation");
  }

  const tasks = fresh.map((t) => ({
    household_id: householdId,
    item_id: itemId,
    title: t.title,
    details: t.details ?? null,
    interval_unit: t.interval_unit,
    interval_value: t.interval_value ?? null,
    source_manual_id: manualId,
    source_page: t.source_page ?? null,
    source: "reader",
    status: status(t),
  }));
  if (tasks.length) await check(db.from("tasks").insert(tasks), "save tasks");

  let disagreements = 0;
  const facts = knowledge.facts.map((f) => {
    const other = others ? findDisagreement(f, others.facts) : null;
    if (other) disagreements++;
    return {
      household_id: householdId,
      item_id: itemId,
      manual_id: manualId,
      kind: f.kind,
      label: f.label,
      value: f.value,
      source_page: f.source_page ?? null,
      source: "reader",
      status: other ? "needs_review" : status(f),
      ...(other
        ? {
            note: disagreementNote(
              guideName(others?.manuals.find((m) => m.id === other.manual_id)),
              other,
              LIMITS.fit_note,
            ),
          }
        : {}),
    };
  });
  // Facts with a note go in on their own: before the note column exists, they're saved without it.
  const plain = facts.filter((f) => !("note" in f));
  const noted = facts.filter((f) => "note" in f);
  if (plain.length) await check(db.from("manual_facts").insert(plain), "save facts");
  if (noted.length) {
    const { error } = await db.from("manual_facts").insert(noted);
    if (error) {
      await check(
        db.from("manual_facts").insert(noted.map(({ note: _note, ...f }) => f)),
        "save facts",
      );
    }
  }

  const seats = knowledge.seat_modes.map((s) => ({
    household_id: householdId,
    item_id: itemId,
    manual_id: manualId,
    mode: s.mode,
    min_weight_kg: s.min_weight === undefined ? null : round2(toKg(s.min_weight, s.weight_unit)),
    max_weight_kg: s.max_weight === undefined ? null : round2(toKg(s.max_weight, s.weight_unit)),
    min_height_cm: s.min_height === undefined ? null : round1(toCm(s.min_height, s.height_unit)),
    max_height_cm: s.max_height === undefined ? null : round1(toCm(s.max_height, s.height_unit)),
    min_age_months: s.min_age_months ?? null,
    fit_note: s.fit_note ?? null,
    source_page: s.source_page ?? null,
    source: "reader",
    status: status(s),
  }));
  if (seats.length) {
    await check(
      db.from("seat_modes").upsert(seats, { onConflict: "item_id,mode" }),
      "save seat limits",
    );
  }

  if (manualId) {
    await check(
      db
        .from("manuals")
        .update({ status: "distilled", read_by: "server", status_detail: null })
        .eq("id", manualId),
      "update manual",
    );
  }
  // A fact flagged only because another guide says otherwise counts too: it starts the second read.
  const flaggedByGuide = knowledge.facts.filter((f, i) => !f.unsure && "note" in (facts[i] ?? {}));
  const needsReview =
    [...knowledge.tasks, ...knowledge.facts, ...knowledge.seat_modes].filter((x) => x.unsure)
      .length + flaggedByGuide.length;
  return {
    tasks: tasks.length,
    facts: facts.length,
    seat_modes: seats.length,
    needs_review: needsReview,
    ...(others ? { repeated, disagreements } : {}),
  };
}

interface OtherTask {
  id: string;
  title: string;
  details: string | null;
  interval_unit: string | null;
  source: string;
  source_manual_id: string | null;
}
interface OtherFact {
  label: string;
  value: string;
  source_page: number | null;
  manual_id: string | null;
}

/**
 * The thing's other guides, and what they already saved: active tasks not
 * from this manual and facts from another manual. Null when this is its only
 * guide, or nothing came from another one yet.
 */
async function otherGuides(db: Db, itemId: string, manualId: string) {
  // Every column, so the kind comes along once it exists and nothing breaks before.
  const { data: manuals, error } = await db.from("manuals").select("*").eq("item_id", itemId);
  if (error || !manuals) return null;
  const list = manuals as GuideRow[];
  if (!list.some((m) => m.id !== manualId)) return null;
  const [tasks, facts] = await Promise.all([
    db
      .from("tasks")
      .select("id, title, details, interval_unit, source, source_manual_id")
      .eq("item_id", itemId)
      .eq("active", true),
    db
      .from("manual_facts")
      .select("label, value, source_page, manual_id, status")
      .eq("item_id", itemId)
      .neq("status", "not_applicable"),
  ]);
  const otherTasks = ((tasks.data ?? []) as OtherTask[]).filter(
    (t) => t.source_manual_id !== manualId,
  );
  const otherFacts = ((facts.data ?? []) as OtherFact[]).filter(
    (f) => f.manual_id && f.manual_id !== manualId,
  );
  // Only what another guide saved makes this a second read; a thing with just its own lines is as before.
  if (!otherTasks.some((t) => t.source_manual_id) && !otherFacts.length) return null;
  return {
    self: list.find((m) => m.id === manualId) ?? null,
    manuals: list,
    tasks: otherTasks,
    facts: otherFacts,
  };
}

async function check(op: PromiseLike<{ error: { message: string } | null }>, what: string) {
  const { error } = await op;
  if (error) throw new Error(`Couldn't ${what}: ${error.message}`);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
