import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  type AtlasChild,
  type AtlasInput,
  type AtlasItem,
  type AtlasTask,
  buildAtlas,
  complete,
  type FacetRow,
  type Facets,
  foldFacets,
  guessItem,
  guessTask,
  LENS_KEYS,
  LENSES,
  type Lens,
  scoreView,
  sortFacets,
  textScores,
  VIEW_BAR,
} from "../atlas.js";
import type { Db } from "../db.js";
import type { Env } from "../env.js";
import { today } from "../lib/schedule.js";
import { guarded, reply, session } from "./context.js";

// The atlas tools: house_atlas draws the overview map for one lens (and an
// optional view in the household's own words), save_view keeps a view so it
// can be a chip on the website. The website's Atlas page calls the same tools
// through /api/tool.

/** Most things or tasks sorted in one go, so a first visit stays quick; the rest wait for the next. */
const SORT_PER_LOAD = 150;
/** After every sort call failed, pages skip Jev for this long and show guesses right away. */
const SORT_PAUSE_MS = 5 * 60_000;
let sortPausedUntil = 0;

/** Lets sorting run again at once (tests, or after Jev is known to be back). */
export function resumeSorting(): void {
  sortPausedUntil = 0;
}

type ItemRowA = AtlasItem & { household_id: string; updated_at: string };
type TaskRowA = AtlasTask & { household_id: string };

export interface SavedView {
  id: string;
  /** The household the view belongs to; its scores only cover that household's things. */
  household_id?: string;
  phrase: string;
  scores: Record<string, number>;
  mode: "jev" | "text";
  computed_at: string;
}

export interface Loaded {
  input: AtlasInput;
  views: SavedView[];
  sorted_now: number;
  guessed: number;
  latest_change: string | null;
}

/** PostgREST hands back at most this many rows per request (Supabase's default max_rows). */
const ROWS_PER_READ = 1000;

/**
 * Every row of a query, a page at a time. A household with many upkeep tasks
 * has more facet rows than one read returns, and a cut-off read would look
 * unsorted and send those tasks to Jev again on every visit.
 */
async function allRows<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const out: T[] = [];
  for (let from = 0; from < 50 * ROWS_PER_READ; from += ROWS_PER_READ) {
    const { data, error } = await page(from, from + ROWS_PER_READ - 1);
    if (error) return { data: out, error };
    out.push(...(data ?? []));
    if ((data ?? []).length < ROWS_PER_READ) break;
  }
  return { data: out, error: null };
}

/** Reads the household, sorts whatever hasn't been sorted yet, and saves those sorts. */
export async function loadAtlas(
  env: Env,
  db: Db,
  fetchImpl: typeof fetch = fetch,
): Promise<Loaded> {
  const [itemsRes, childrenRes, itemFacetsRes, taskFacetsRes, viewsRes] = await Promise.all([
    db
      .from("items")
      .select(
        "id, household_id, kind, category, nickname, brand, model, child_id, notes, icon, tint, updated_at, tasks(id, household_id, item_id, title, details, next_due_on, active)",
      )
      .is("archived_at", null)
      .order("created_at"),
    db.from("children").select("id, nickname").order("created_at"),
    allRows((from, to) =>
      db
        .from("item_facets")
        .select("item_id, lens, value, p")
        .order("item_id")
        .order("lens")
        .order("value")
        .range(from, to),
    ),
    allRows((from, to) =>
      db
        .from("task_facets")
        .select("task_id, lens, value, p")
        .order("task_id")
        .order("lens")
        .order("value")
        .range(from, to),
    ),
    db
      .from("saved_views")
      .select("id, household_id, phrase, scores, mode, computed_at")
      .order("created_at"),
  ]);
  for (const r of [itemsRes, childrenRes, itemFacetsRes, taskFacetsRes, viewsRes]) {
    if (r.error) throw new Error(`Couldn't read the atlas: ${r.error.message}`);
  }
  const children = (childrenRes.data ?? []) as AtlasChild[];
  const items: ItemRowA[] = [];
  const tasks: TaskRowA[] = [];
  for (const row of (itemsRes.data ?? []) as (ItemRowA & {
    tasks?: (TaskRowA & { active: boolean })[];
  })[]) {
    const { tasks: own, ...item } = row;
    items.push(item);
    for (const t of own ?? []) {
      if (!t.active) continue;
      const { active: _active, ...task } = t;
      tasks.push(task);
    }
  }
  const itemFacets = foldFacets(
    (
      (itemFacetsRes.data ?? []) as { item_id: string; lens: string; value: string; p: number }[]
    ).map((r) => ({ ...r, id: r.item_id })),
  );
  const taskFacets = foldFacets(
    (
      (taskFacetsRes.data ?? []) as { task_id: string; lens: string; value: string; p: number }[]
    ).map((r) => ({ ...r, id: r.task_id })),
  );

  const unsortedItems = items.filter((i) => !complete(itemFacets.get(i.id), "item"));
  const unsortedTasks = tasks.filter((t) => !complete(taskFacets.get(t.id), "task"));
  let sortedNow = 0;
  if (
    env.router &&
    Date.now() >= sortPausedUntil &&
    (unsortedItems.length || unsortedTasks.length)
  ) {
    const pickItems = unsortedItems.slice(0, SORT_PER_LOAD);
    const pickTasks = unsortedTasks.slice(0, Math.max(0, SORT_PER_LOAD - pickItems.length));
    const result = await sortFacets(
      env,
      { items: pickItems, tasks: pickTasks, children, all: items },
      fetchImpl,
    );
    sortedNow = result.sorted.size;
    // Jev is down or timing out: don't make every page load wait for it again.
    if (result.calls && result.failed === result.calls) {
      sortPausedUntil = Date.now() + SORT_PAUSE_MS;
    }
    // Fresh answers replace whatever partial sort was there.
    for (const id of result.sorted) {
      itemFacets.delete(id);
      taskFacets.delete(id);
    }
    for (const row of result.rows) {
      const map = row.subject === "item" ? itemFacets : taskFacets;
      const f = map.get(row.id) ?? {};
      f[row.lens] = { ...(f[row.lens] ?? {}), [row.value]: row.p };
      map.set(row.id, f);
    }
    await saveFacets(db, result.rows, items, tasks);
  }

  let guessed = 0;
  const input: AtlasInput = {
    children,
    today: today(),
    items: items.map((i) => {
      const f = itemFacets.get(i.id);
      if (complete(f, "item")) return { ...i, facets: f as Facets, guess: false };
      guessed++;
      return { ...i, facets: guessItem(i, children), guess: true };
    }),
    tasks: tasks.map((t) => {
      const f = taskFacets.get(t.id);
      if (complete(f, "task")) return { ...t, facets: f as Facets, guess: false };
      guessed++;
      return { ...t, facets: guessTask(t), guess: true };
    }),
  };
  const latest = items.reduce<string | null>(
    (m, i) => (!m || i.updated_at > m ? i.updated_at : m),
    null,
  );
  return {
    input,
    views: (viewsRes.data ?? []) as SavedView[],
    sorted_now: sortedNow,
    guessed,
    latest_change: latest,
  };
}

/** Keeps Jev's sorts. A failed write only means sorting again next time. */
async function saveFacets(
  db: Db,
  rows: FacetRow[],
  items: ItemRowA[],
  tasks: TaskRowA[],
): Promise<void> {
  if (!rows.length) return;
  const homeOfItem = new Map(items.map((i) => [i.id, i.household_id]));
  const homeOfTask = new Map(tasks.map((t) => [t.id, t.household_id]));
  const itemRows = rows.filter((r) => r.subject === "item");
  const taskRows = rows.filter((r) => r.subject === "task");
  try {
    if (itemRows.length) {
      const ids = [...new Set(itemRows.map((r) => r.id))];
      await db.from("item_facets").delete().in("item_id", ids);
      await db.from("item_facets").insert(
        itemRows.map((r) => ({
          household_id: homeOfItem.get(r.id),
          item_id: r.id,
          lens: r.lens,
          value: r.value,
          p: r.p,
        })),
      );
    }
    if (taskRows.length) {
      const ids = [...new Set(taskRows.map((r) => r.id))];
      await db.from("task_facets").delete().in("task_id", ids);
      await db.from("task_facets").insert(
        taskRows.map((r) => ({
          household_id: homeOfTask.get(r.id),
          task_id: r.id,
          lens: r.lens,
          value: r.value,
          p: r.p,
        })),
      );
    }
  } catch {}
}

/** A saved view is stale when a thing changed after it was scored, or it predates one. */
export function viewIsStale(
  view: SavedView,
  input: AtlasInput,
  latestChange: string | null,
  jevOn: boolean,
): boolean {
  if (jevOn && view.mode === "text") return true;
  const own = ownItems(input.items, view.household_id);
  if (own.some((i) => !(i.id in (view.scores ?? {})))) return true;
  // Only a change to the view's own household's things makes it stale.
  const latest = view.household_id ? (latestOf(own) ?? latestChange) : latestChange;
  return !!latest && Date.parse(latest) > Date.parse(view.computed_at);
}

/** The newest updated_at among things that carry one. */
function latestOf(items: { updated_at?: string }[]): string | null {
  return items.reduce<string | null>(
    (m, i) => (i.updated_at && (!m || i.updated_at > m) ? i.updated_at : m),
    null,
  );
}

/** The things of one household (all of them when it isn't known). */
function ownItems<T extends { household_id?: string }>(items: T[], householdId?: string): T[] {
  return householdId
    ? items.filter((i) => !i.household_id || i.household_id === householdId)
    : items;
}

/**
 * The scores a saved view keeps: only its own household's things, so a person
 * in two homes never writes one home's things into the other's view.
 */
export function scoresFor(
  scores: Record<string, number>,
  items: { id: string; household_id?: string }[],
  householdId?: string,
): Record<string, number> {
  const keep = new Set(ownItems(items, householdId).map((i) => i.id));
  return Object.fromEntries(Object.entries(scores).filter(([id]) => keep.has(id)));
}

export interface ViewResult {
  phrase: string;
  scores: Record<string, number>;
  mode: "jev" | "text";
  saved: SavedView | null;
}

/** Scores a phrase, reusing a saved view when it is still fresh and refreshing it when not. */
export async function resolveView(
  env: Env,
  db: Db,
  loaded: Loaded,
  ref: { phrase?: string; id?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ViewResult> {
  const saved =
    loaded.views.find((v) => v.id === ref.id) ??
    loaded.views.find(
      (v) => ref.phrase && v.phrase.toLowerCase() === ref.phrase.trim().toLowerCase(),
    ) ??
    null;
  const phrase = saved?.phrase ?? ref.phrase?.trim() ?? "";
  if (!phrase) throw new Error("Say what the view should show, like things that use water.");
  // While Jev is known to be down, a view doesn't wait on it either: a saved
  // view keeps its last scores, a new phrase gets a word match.
  const paused = Date.now() < sortPausedUntil;
  if (saved && (paused || !viewIsStale(saved, loaded.input, loaded.latest_change, !!env.router))) {
    return { phrase, scores: saved.scores, mode: saved.mode, saved };
  }
  // A saved view only scores (and pays for) its own household's things, so it
  // shows the same things whether it was just rescored or read back.
  const items = saved ? ownItems(loaded.input.items, saved.household_id) : loaded.input.items;
  const ids = new Set(items.map((i) => i.id));
  const tasks = loaded.input.tasks.filter((t) => ids.has(t.item_id));
  const scored = paused
    ? { scores: textScores(phrase, items, tasks), mode: "text" as const }
    : await scoreView(env, phrase, items, tasks, fetchImpl);
  if (!paused && env.router && items.length && scored.mode === "text") {
    sortPausedUntil = Date.now() + SORT_PAUSE_MS;
  }
  if (saved) {
    const computed_at = new Date().toISOString();
    const kept = scoresFor(scored.scores, items, saved.household_id);
    await db
      .from("saved_views")
      .update({ scores: kept, mode: scored.mode, computed_at })
      .eq("id", saved.id);
    return {
      phrase,
      scores: kept,
      mode: scored.mode,
      saved: { ...saved, scores: kept, mode: scored.mode, computed_at },
    };
  }
  return { phrase, scores: scored.scores, mode: scored.mode, saved: null };
}

const lensEnum = z.enum(LENS_KEYS as [Lens, ...Lens[]]);

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "house_atlas",
    {
      title: "House atlas",
      description: [
        "An overview map of the household: every thing (or, for effort and season, every upkeep task) grouped by one lens, with how many are late or due soon in each group.",
        "Lenses: room (kitchen, laundry, nursery, garage, car...), system (water, air and heat, power, safety, child gear), whose (anyone, adults, each child), effort (5 minutes, 15 minutes, an afternoon, call a pro) and season (any time, before winter, before summer, after storms).",
        'Use it for "what\'s in the nursery?", "what uses water?", "what can I do in five minutes?" or "what needs doing before winter?".',
        'Pass view with the user\'s own words ("things that could flood the floor") to keep only the things that fit; view_p is how sure that a thing fits and maybe marks the unsure ones.',
        "Groups come from Jev's sort; guess true means a keyword guess while Jev hasn't sorted that one yet.",
      ].join(" "),
      inputSchema: z.object({
        lens: lensEnum.default("room").describe("How to group the household."),
        view: z
          .string()
          .trim()
          .min(2)
          .max(120)
          .optional()
          .describe("A view in the user's words, or the phrase of a saved view."),
        view_id: z.string().uuid().optional().describe("A saved view's id, instead of view."),
        bar: z
          .number()
          .min(0.3)
          .max(0.95)
          .optional()
          .describe("How sure a view must be to count a thing in (default 0.6)."),
        all_lenses: z
          .boolean()
          .default(false)
          .describe(
            "Also return every lens's groups at once (by_lens), to switch without asking again.",
          ),
      }),
      // It only caches Jev's sort of what is already there; nothing the user made changes.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ lens, view, view_id, bar, all_lenses }, ctx) =>
      guarded(async () => {
        const { db } = await session(env, ctx);
        const loaded = await loadAtlas(env, db);
        if (!loaded.input.items.length) {
          return reply(
            "Nothing is registered yet, so there's no map to draw. Offer to add things with add_item.",
          );
        }
        const picked =
          view || view_id
            ? await resolveView(env, db, loaded, { phrase: view, id: view_id })
            : null;
        const viewArg = picked ? { scores: picked.scores, bar: bar ?? VIEW_BAR } : undefined;
        const groups = buildAtlas(lens, loaded.input, viewArg);
        const def = LENSES[lens];
        const sortedBy =
          loaded.guessed === 0
            ? "jev"
            : loaded.guessed === loaded.input.items.length + loaded.input.tasks.length
              ? "guess"
              : "mixed";
        const parts = groups.map(
          (g) =>
            `${g.label} ${g.entries.length}${g.late ? ` (${g.late} late)` : g.soon ? ` (${g.soon} due soon)` : ""}`,
        );
        const what = def.subject === "task" ? "upkeep tasks" : "things";
        const head = picked
          ? `${def.label}, only ${what} that fit "${picked.phrase}"`
          : `${def.label} for the household's ${what}`;
        const summary = groups.length
          ? `${head}: ${parts.join(", ")}.${picked?.mode === "text" ? " Jev was away, so the view is a plain word match." : ""}`
          : `${head}: nothing fits. Try other words, or a lower bar.`;
        return reply(summary, {
          lens,
          label: def.label,
          subject: def.subject,
          lenses: LENS_KEYS.map((k) => ({
            key: k,
            label: LENSES[k].label,
            subject: LENSES[k].subject,
          })),
          sorted_by: sortedBy,
          view: picked
            ? {
                phrase: picked.phrase,
                mode: picked.mode,
                bar: bar ?? VIEW_BAR,
                saved_id: picked.saved?.id ?? null,
              }
            : null,
          views: loaded.views.map((v) => ({ id: v.id, phrase: v.phrase })),
          groups,
          by_lens: all_lenses
            ? Object.fromEntries(LENS_KEYS.map((k) => [k, buildAtlas(k, loaded.input, viewArg)]))
            : undefined,
        });
      }),
  );
}
