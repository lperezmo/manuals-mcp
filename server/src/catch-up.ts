import { z } from "zod";
import type { Db, ItemRow, TaskRow } from "./db.js";
import type { Env } from "./env.js";
import { cut } from "./finder/knowledge.js";
import { addDays, describeInterval, today as todayIs } from "./lib/schedule.js";

// Back history for things that aren't new (issue #1). A washer used for years
// with no upkeep, or an AC out of two years in storage, shouldn't start its
// schedule as if it was serviced the day it was added. After the manual is
// read, one small call to Muse (the reader model) takes the saved tasks, what
// the owner says about the thing's history and the manual's storage and
// startup pages, and returns a plan. The manual read itself stays as it was,
// so it can be shared and re-read without knowing anyone's history.

// --- History -----------------------------------------------------------------

export const CONDITIONS = ["new", "used", "stored"] as const;
export const GOALS = ["keep_running", "like_new", "bare_minimum"] as const;

/** What the owner says about a thing's past. The same fields for add_item, catch_up and the website. */
export const historySchema = z.object({
  condition: z
    .enum(CONDITIONS)
    .describe("new, used (in service a while) or stored (coming out of storage)."),
  age_years: z.number().min(0).max(100).optional().describe("Roughly how old it is, in years."),
  idle_months: z
    .number()
    .int()
    .min(0)
    .max(1200)
    .optional()
    .describe("Months since it was last used; 0 if it's in use now."),
  done: z
    .string()
    .max(1000)
    .optional()
    .describe(
      'What has been done, in the user\'s words: "in storage two years, never touched", "I clean the lint trap but nothing else", "no idea".',
    ),
  goal: z
    .enum(GOALS)
    .optional()
    .describe(
      "keep_running (default), like_new (deep clean, replace worn parts) or bare_minimum (safety only).",
    ),
});

export type History = z.infer<typeof historySchema>;

/** The history's columns on items; added by the 20261101100000 migration. */
const HISTORY_COLUMNS =
  "condition, age_years, idle_months, history_note, upkeep_goal, caught_up_at, catch_up_summary";

export interface SavedHistory extends History {
  caught_up_at: string | null;
  catch_up_summary: string | null;
}

/**
 * Saves the history on the item. False when the database doesn't have the
 * columns yet (the migration isn't applied): the plan still runs from what
 * was passed in, it just isn't remembered.
 */
export async function saveHistory(db: Db, itemId: string, h: History): Promise<boolean> {
  const { error } = await db
    .from("items")
    .update({
      condition: h.condition,
      age_years: h.age_years ?? null,
      idle_months: h.idle_months ?? null,
      history_note: h.done ?? null,
      upkeep_goal: h.goal ?? null,
    })
    .eq("id", itemId);
  return !error;
}

/** The saved history, or null when there is none (or no columns for it yet). */
export async function loadHistory(db: Db, itemId: string): Promise<SavedHistory | null> {
  const { data, error } = await db
    .from("items")
    .select(HISTORY_COLUMNS)
    .eq("id", itemId)
    .maybeSingle();
  if (error || !data?.condition) return null;
  return {
    condition: data.condition,
    age_years: data.age_years === null ? undefined : Number(data.age_years),
    idle_months: data.idle_months ?? undefined,
    done: data.history_note ?? undefined,
    goal: data.upkeep_goal ?? undefined,
    caught_up_at: data.caught_up_at,
    catch_up_summary: data.catch_up_summary,
  };
}

/** One plain line about the history, for the model and for replies. */
export function describeHistory(h: History): string {
  const state = {
    new: "New.",
    used: "Used, in service for a while.",
    stored: "Coming out of storage.",
  }[h.condition];
  const idle =
    h.idle_months === undefined
      ? ""
      : h.idle_months === 0
        ? "In use now."
        : `Last used about ${h.idle_months} ${h.idle_months === 1 ? "month" : "months"} ago.`;
  const goal = {
    keep_running: "Goal: just keep it running.",
    like_new: "Goal: get it back to like new.",
    bare_minimum: "Goal: the bare minimum.",
  }[h.goal ?? "keep_running"];
  return [
    state,
    h.age_years === undefined ? "" : `About ${h.age_years} years old.`,
    idle,
    h.done ? `What has been done, in the owner's words: "${h.done}"` : "No word on past upkeep.",
    goal,
  ]
    .filter(Boolean)
    .join(" ");
}

// --- The model call ----------------------------------------------------------

const PAGE_BUDGET = 12_000;
/** Pages about storage, startup and first use: where a manual covers recommissioning. */
const PAGE_QUERY =
  'storage OR store OR winter OR winterize OR vacation OR "long period" OR unused OR idle OR "first use" OR "before using" OR "before first" OR installation OR startup OR "start up" OR restart OR "not used"';
const PAGE_WORDS =
  /stor(e|age|ing)|winter|vacation|long period|unused|idle|first use|before (first )?us|install|start.?up|restart|not (been )?used|drain|recommission/gi;

export const PLAN_LIMITS = { title: 160, details: 600, summary: 600, steps: 8 } as const;

export const PLAN_INSTRUCTIONS = `You plan catch-up upkeep for a household thing that isn't new: it has been in use for a while, or is coming out of storage, and its upkeep history is patchy or unknown.
You get the thing, what the owner says about its history, its saved upkeep tasks (each with a ref like T3, how often, and its manual page), and the manual's pages about storage, startup and first use.
Return JSON:
- "summary": one or two plain sentences for the owner: where the thing stands and what to do first.
- "tasks": one entry per saved task you can say something about: "ref", "state" (done|never|unknown|skip), and for done, "days_ago" (whole days since it was last done, your best estimate from what the owner said; 0 if they do it all the time).
  done: the owner says they do it, or did it at a time they gave. never: the owner says it was never done, or it sat long enough that it's overdue. unknown: no way to tell. skip: a one-time step that no longer applies (unpacking, first install of something already installed).
- "catch_up": one-time steps to do before the normal schedule makes sense, most important first, at most ${PLAN_LIMITS.steps}. Each has "title" (short imperative), "details" (one or two sentences), "source_page" when one of the pages given here says it, and "from_manual" (true only when that page says it). General advice that isn't on these pages gets no source_page and from_manual false; a person will check it.
Goal: keep_running means what it takes to run it safely and keep it working; like_new adds deep cleaning and replacing worn parts; bare_minimum means only safety and what stops damage.
Don't repeat a saved task as a catch-up step; mark it never so it comes due now. Keep "title" at most ${PLAN_LIMITS.title} characters and "details" at most ${PLAN_LIMITS.details}. Return only JSON.`;

export interface PlanPage {
  page_number: number;
  content: string;
}

/** The pages most about storage and startup, within a small budget, in page order. */
export function pickPages(pages: PlanPage[], budget = PAGE_BUDGET): PlanPage[] {
  const scored = pages
    .map((p) => ({ p, score: p.content.match(PAGE_WORDS)?.length ?? 0 }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const chosen: PlanPage[] = [];
  let used = 0;
  for (const { p } of scored) {
    const text = p.content.slice(0, 3_000);
    if (used + text.length > budget) continue;
    chosen.push({ page_number: p.page_number, content: text });
    used += text.length;
  }
  return chosen.sort((a, b) => a.page_number - b.page_number);
}

export type PlanTask = Pick<
  TaskRow,
  | "id"
  | "title"
  | "details"
  | "interval_unit"
  | "interval_value"
  | "source_page"
  | "last_done_on"
  | "next_due_on"
>;

const stepSchema = z.object({
  title: z.string().min(1).max(PLAN_LIMITS.title),
  details: z.string().max(PLAN_LIMITS.details).optional(),
  source_page: z.number().int().positive().nullish(),
  from_manual: z.boolean().optional(),
});

const taskStateSchema = z.object({
  ref: z.string(),
  state: z.enum(["done", "never", "unknown", "skip"]),
  days_ago: z.number().min(0).max(36_500).nullish(),
});

export interface CatchUpStep {
  title: string;
  details: string | null;
  /** Only when the page was sent with the plan or is already cited by a saved task. */
  source_page: number | null;
  /** True when the manual says it; anything else is flagged for a person to check. */
  cited: boolean;
}

export interface Plan {
  summary: string;
  /** Saved tasks the owner already does, with when they were last done. */
  done: { id: string; done_on: string }[];
  /** Saved tasks never done: due now. */
  never: string[];
  /** Saved tasks nobody knows about (or the model didn't mention): due soon. */
  unknown: string[];
  steps: CatchUpStep[];
}

/**
 * Turns the model's JSON into a plan over the real task ids. Anything that
 * doesn't fit is left out rather than failing the whole plan, and a page the
 * model didn't see is never kept as a citation.
 */
export function readPlan(
  raw: unknown,
  tasks: PlanTask[],
  pagesSeen: number[],
  today: string = todayIs(),
): Plan {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("the answer wasn't a JSON object");
  }
  const body = raw as Record<string, unknown>;
  const byRef = new Map(tasks.map((t, i) => [`T${i + 1}`, t]));
  const said = new Map<string, z.infer<typeof taskStateSchema>>();
  for (const entry of Array.isArray(body.tasks) ? body.tasks : []) {
    const parsed = taskStateSchema.safeParse(entry);
    const ref = parsed.success ? parsed.data.ref.trim().toUpperCase() : "";
    if (parsed.success && byRef.has(ref) && !said.has(ref)) said.set(ref, parsed.data);
  }
  const plan: Plan = {
    summary: typeof body.summary === "string" ? cut(body.summary.trim(), PLAN_LIMITS.summary) : "",
    done: [],
    never: [],
    unknown: [],
    steps: [],
  };
  for (const [ref, task] of byRef) {
    // "As needed" tasks have no schedule to catch up on.
    if (task.interval_unit === "as_needed") continue;
    const s = said.get(ref);
    if (s?.state === "skip") continue;
    if (s?.state === "done" && typeof s.days_ago === "number") {
      plan.done.push({ id: task.id, done_on: addDays(today, -Math.round(s.days_ago)) });
    } else if (s?.state === "never") plan.never.push(task.id);
    else plan.unknown.push(task.id);
  }
  const citable = new Set([
    ...pagesSeen,
    ...tasks.map((t) => t.source_page).filter((p): p is number => !!p),
  ]);
  for (const entry of Array.isArray(body.catch_up) ? body.catch_up : []) {
    if (plan.steps.length >= PLAN_LIMITS.steps) break;
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const parsed = stepSchema.safeParse({
      ...e,
      title: typeof e.title === "string" ? cut(e.title.trim(), PLAN_LIMITS.title) : e.title,
      details:
        typeof e.details === "string" ? cut(e.details.trim(), PLAN_LIMITS.details) : undefined,
    });
    if (!parsed.success) continue;
    const page = parsed.data.source_page ?? null;
    const known = page !== null && citable.has(page);
    plan.steps.push({
      title: parsed.data.title,
      details: parsed.data.details || null,
      source_page: known ? page : null,
      cited: known && parsed.data.from_manual === true,
    });
  }
  return plan;
}

export interface PlanUsage {
  model: string;
  tokens_in: number | null;
  tokens_out: number | null;
}

/** A failed plan that still knows what came back, for the model_runs log. */
export class PlanError extends Error {
  constructor(
    message: string,
    readonly raw: string | null,
    readonly usage: PlanUsage | null,
  ) {
    super(message);
  }
}

export async function askForPlan(
  env: Env,
  args: { itemLabel: string; history: History; tasks: PlanTask[]; pages: PlanPage[] },
  fetchImpl: typeof fetch = fetch,
): Promise<{ plan: Plan; usage: PlanUsage; raw: string }> {
  const reader = env.reader;
  if (!reader) throw new Error("Muse isn't set up here (READER_* settings), so it can't plan.");
  const taskLines = args.tasks.map((t, i) =>
    [
      `T${i + 1}: ${t.title} (${describeInterval(t.interval_unit, t.interval_value)}`,
      t.source_page ? `, manual p. ${t.source_page}` : "",
      t.last_done_on ? `, last logged ${t.last_done_on}` : "",
      ")",
      t.details ? ` ${t.details.slice(0, 200)}` : "",
    ].join(""),
  );
  const pageText = args.pages
    .map((p) => `--- page ${p.page_number} ---\n${p.content}`)
    .join("\n\n");
  const res = await fetchImpl(`${reader.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(reader.apiKey ? { authorization: `Bearer ${reader.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: reader.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PLAN_INSTRUCTIONS },
        {
          role: "user",
          content: [
            `Thing: ${args.itemLabel}`,
            `History: ${describeHistory(args.history)}`,
            `Today: ${todayIs()}`,
            `Saved upkeep tasks:\n${taskLines.join("\n") || "(none yet: no manual has been read)"}`,
            `Manual pages about storage, startup and first use:\n${pageText || "(none found)"}`,
          ].join("\n\n"),
        },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 2_000) || null;
    throw new PlanError(`Muse answered ${res.status}`, text, null);
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const raw = body.choices?.[0]?.message?.content ?? "";
  const usage: PlanUsage = {
    model: reader.model,
    tokens_in: body.usage?.prompt_tokens ?? null,
    tokens_out: body.usage?.completion_tokens ?? null,
  };
  try {
    const json = raw.replace(/^```(?:json)?\s*|\s*```$/g, "");
    const plan = readPlan(
      JSON.parse(json),
      args.tasks,
      args.pages.map((p) => p.page_number),
    );
    return { plan, usage, raw };
  } catch (err) {
    throw new PlanError(
      `Muse's plan didn't fit: ${(err as Error).message.slice(0, 300)}`,
      raw,
      usage,
    );
  }
}

// --- Seeding the schedule ----------------------------------------------------

/** How many catch-up items come due on one day, and the days between those batches. */
export const STAGGER = { perDay: 2, gapDays: 3 } as const;

/**
 * Due dates for a queue of catch-up work: the first two today, the next two
 * a few days later, and so on, so nobody gets ten alerts on day one.
 */
export function staggerDates(count: number, today: string = todayIs()): string[] {
  return Array.from({ length: count }, (_, i) =>
    addDays(today, Math.floor(i / STAGGER.perDay) * STAGGER.gapDays),
  );
}

export interface Seeded {
  summary: string;
  steps: { id: string; title: string; next_due_on: string; cited: boolean }[];
  /** Tasks the owner already does, now dated from when they last did them. */
  done: number;
  /** Tasks that are due now or within the next few weeks. */
  due: number;
  /** The last day the staggered work runs to. */
  through: string | null;
  /** False when the database doesn't have the migration's columns yet. */
  remembered: boolean;
}

const MISSING_COLUMN = /catch_up|column|schema cache/i;

/**
 * Writes the plan: dates for tasks already done (logged, so the history shows
 * them), due dates for the rest, and the catch-up steps as one-time tasks.
 * A second plan replaces the first one's steps that aren't done yet.
 */
export async function applyPlan(args: {
  db: Db;
  householdId: string;
  item: Pick<ItemRow, "id">;
  manualId: string | null;
  plan: Plan;
  today?: string;
}): Promise<Seeded> {
  const { db, householdId, item, manualId, plan } = args;
  const today = args.today ?? todayIs();
  let remembered = true;

  const old = await db
    .from("tasks")
    .delete()
    .eq("item_id", item.id)
    .eq("catch_up", true)
    .is("last_done_on", null);
  if (old.error) remembered = false;

  // Tasks the owner does: logged on the day they last did it, which starts
  // the next interval from there. One that's overdue anyway joins the queue.
  const overdue: string[] = [];
  for (const d of plan.done) {
    const { data, error } = await db.rpc("log_task_done", {
      p_task: d.id,
      p_done_on: d.done_on,
      p_note: "From its history, an estimate.",
    });
    if (error) throw new Error(`Couldn't date a task you already do: ${error.message}`);
    const t = data as TaskRow | null;
    if (t?.active && t.next_due_on && t.next_due_on < today) overdue.push(t.id);
  }

  const queue = [...plan.never, ...overdue, ...plan.unknown];
  const dates = staggerDates(plan.steps.length + queue.length, today);
  const stepDates = dates.slice(0, plan.steps.length);
  const taskDates = dates.slice(plan.steps.length);

  const rows = plan.steps.map((s, i) => ({
    household_id: householdId,
    item_id: item.id,
    title: s.title,
    details: s.cited
      ? s.details
      : [s.details, "General advice, not from the manual."].filter(Boolean).join(" "),
    interval_unit: "once",
    next_due_on: stepDates[i],
    source_manual_id: s.source_page ? manualId : null,
    source_page: s.source_page,
    source: "reader",
    status: s.cited ? "extracted" : "needs_review",
    catch_up: true,
  }));
  let inserted: { id: string; title: string; next_due_on: string }[] = [];
  if (rows.length) {
    let res = await db.from("tasks").insert(rows).select("id, title, next_due_on");
    if (res.error && MISSING_COLUMN.test(res.error.message)) {
      remembered = false;
      res = await db
        .from("tasks")
        .insert(rows.map(({ catch_up: _, ...r }) => r))
        .select("id, title, next_due_on");
    }
    if (res.error) throw new Error(`Couldn't save the catch-up steps: ${res.error.message}`);
    inserted = (res.data ?? []) as typeof inserted;
  }

  const updates = await Promise.all(
    queue.map((id, i) => db.from("tasks").update({ next_due_on: taskDates[i] }).eq("id", id)),
  );
  const failed = updates.find((u) => u.error);
  if (failed?.error) throw new Error(`Couldn't set the due dates: ${failed.error.message}`);

  const stamp = await db
    .from("items")
    .update({ caught_up_at: new Date().toISOString(), catch_up_summary: plan.summary || null })
    .eq("id", item.id);
  if (stamp.error) remembered = false;

  return {
    summary: plan.summary,
    steps: inserted.map((r, i) => ({ ...r, cited: plan.steps[i]?.cited ?? false })),
    done: plan.done.length - overdue.length,
    due: queue.length + inserted.length,
    through: dates.at(-1) ?? null,
    remembered,
  };
}

// --- Gathering what the plan needs ---------------------------------------------

/** The item's active tasks that aren't catch-up steps, and its storage and startup pages. */
export async function planInputs(
  db: Db,
  itemId: string,
): Promise<{ tasks: PlanTask[]; pages: PlanPage[]; manualId: string | null }> {
  const { data: tasks, error } = await db
    .from("tasks")
    .select(
      "id, title, details, interval_unit, interval_value, source_page, last_done_on, next_due_on, source_manual_id",
    )
    .eq("item_id", itemId)
    .eq("active", true)
    .order("created_at");
  if (error) throw new Error(`Couldn't read its upkeep: ${error.message}`);
  let steps = new Set<string>();
  const marked = await db.from("tasks").select("id").eq("item_id", itemId).eq("catch_up", true);
  if (!marked.error) steps = new Set((marked.data ?? []).map((t) => t.id as string));
  const own = ((tasks ?? []) as (PlanTask & { source_manual_id: string | null })[]).filter(
    (t) => !steps.has(t.id),
  );

  const { data: manuals } = await db
    .from("manuals")
    .select("id")
    .eq("item_id", itemId)
    .order("created_at");
  const manualIds = (manuals ?? []).map((m) => m.id as string);
  let pages: PlanPage[] = [];
  if (manualIds.length) {
    const found = await db
      .from("manual_pages")
      .select("page_number, content")
      .in("manual_id", manualIds)
      .textSearch("fts", PAGE_QUERY, { type: "websearch", config: "english" })
      .limit(40);
    if (!found.error) pages = pickPages((found.data ?? []) as PlanPage[]);
  }
  return {
    tasks: own.slice(0, 60).map(({ source_manual_id: _, ...t }) => t),
    pages,
    manualId: manualIds[0] ?? null,
  };
}
