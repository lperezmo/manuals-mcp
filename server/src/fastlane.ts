import type { Db } from "./db.js";
import type { Env } from "./env.js";
import { describeInterval, relativeDay } from "./lib/schedule.js";
import { MIN_CONFIDENCE, ROUTES, type Route, type RouteDecision } from "./router.js";

// The fast lane: Jev answers the easy questions before Muse is asked.
//
// Most chat questions have an exact answer already saved: "what does E4
// mean", "what filter does the fridge take", "when is the furnace filter due".
// One Jev call reads the household's saved facts and tasks as numbered lines
// and answers, all at once (speculative fan-out): what kind of turn it is
// (the router's question), which thing it's about, which line answers it,
// whether that line holds the whole answer, and whether it needs judgment or
// is about safety. A confident, complete, harmless answer is sent straight
// from the line, with its page, in a fraction of a second and without Muse.
// Anything else goes to Muse as before, with Jev's picks as a hint.
//
// Patterns from TypeSafe's docs: semantic find (a Choice over line ids plus an
// "exists" Noul), speculative fan-out, and the SDE cascade (cheap path first,
// escalate what's flagged). Any error, a missing key or an empty household
// fails open: the caller goes on as if the fast lane weren't there. Car seats
// and anything that reads as safety always go to Muse, like verify.ts.

/** Jev's Choice takes at most 255 options. */
const MAX_ROWS = 250;
const MAX_ITEMS = 254;
const MAX_LINE_CHARS = 160;

/** The top line must be at least this likely, and the answer this surely in it. */
export const ROW_FOUND = 0.7;
export const EXISTS_FOUND = 0.7;
/** Above these, the question goes to Muse whatever line Jev picked. */
export const JUDGMENT_MAX = 0.35;
export const SAFETY_MAX = 0.35;
/** A hint names the thing only when Jev is this sure of it. */
export const THING_HINT = 0.6;
/** Type-ahead shows lines at least this likely, when the answer looks saved. */
export const SUGGEST_ROW = 0.15;
export const SUGGEST_EXISTS = 0.4;
/** Fast lane calls per user a minute (type-ahead, and chat turns), so a stuck key can't run up Jev calls. */
export const FAST_PER_MINUTE = 60;

export interface SnapshotItem {
  id: string;
  nickname: string;
  brand: string | null;
  model: string | null;
  kind: string;
  category: string | null;
  /** Has car seat limits saved (seat_modes), whatever it's called. */
  car_seat?: boolean;
}

export interface SnapshotRow {
  /** "fact" or "task", with the database id. */
  type: "fact" | "task";
  id: string;
  item_id: string;
  /** Error code, part, spec, safety or other, for facts; "task" for tasks. */
  kind: string;
  label: string;
  value: string;
  page: number | null;
  /** extracted, needs_review, revised or confirmed. */
  status: string;
  /** reader, assistant or user. */
  source: string;
  next_due_on?: string | null;
}

export interface Snapshot {
  items: SnapshotItem[];
  rows: SnapshotRow[];
  loaded_at: number;
}

/** Reads the household's things, facts and active tasks as the user (RLS applies). */
export async function loadSnapshot(db: Db): Promise<Snapshot> {
  const [items, facts, tasks, seats] = await Promise.all([
    db
      .from("items")
      .select("id, nickname, brand, model, kind, category")
      .is("archived_at", null)
      .order("created_at")
      .limit(MAX_ITEMS),
    db
      .from("manual_facts")
      .select("id, item_id, kind, label, value, source_page, source, status")
      .neq("status", "not_applicable")
      .limit(2_000),
    db
      .from("tasks")
      .select(
        "id, item_id, title, details, interval_unit, interval_value, next_due_on, source_page, source, status",
      )
      .eq("active", true)
      .limit(2_000),
    // A seat with limits saved is a car seat even when its name doesn't say so.
    db.from("seat_modes").select("item_id").limit(2_000),
  ]);
  for (const r of [items, facts, tasks, seats]) {
    if (r.error) throw new Error(r.error.message);
  }
  const seated = new Set(((seats.data ?? []) as { item_id: string }[]).map((s) => s.item_id));
  const list = ((items.data ?? []) as SnapshotItem[]).map((i) =>
    seated.has(i.id) ? { ...i, car_seat: true } : i,
  );
  const live = new Set(list.map((i) => i.id));
  const rows: SnapshotRow[] = [];
  for (const f of (facts.data ?? []) as Record<string, unknown>[]) {
    if (!live.has(f.item_id as string)) continue;
    rows.push({
      type: "fact",
      id: f.id as string,
      item_id: f.item_id as string,
      kind: f.kind as string,
      label: f.label as string,
      value: f.value as string,
      page: (f.source_page as number | null) ?? null,
      status: f.status as string,
      source: f.source as string,
    });
  }
  for (const t of (tasks.data ?? []) as Record<string, unknown>[]) {
    if (!live.has(t.item_id as string)) continue;
    const how = describeInterval(
      t.interval_unit as Parameters<typeof describeInterval>[0],
      (t.interval_value as number | null) ?? null,
    );
    const due = t.next_due_on ? `, next due ${t.next_due_on}` : "";
    rows.push({
      type: "task",
      id: t.id as string,
      item_id: t.item_id as string,
      kind: "task",
      label: t.title as string,
      value: `${how}${due}${t.details ? `. ${t.details}` : ""}`,
      page: (t.source_page as number | null) ?? null,
      status: t.status as string,
      source: t.source as string,
      next_due_on: (t.next_due_on as string | null) ?? null,
    });
  }
  return { items: list, rows, loaded_at: Date.now() };
}

// Type-ahead asks again on almost every keystroke, so its snapshot is kept for
// a minute per user (a household's facts change rarely). A chat turn always
// reads a fresh one, and a turn that changed something drops the cached one.
const SNAPSHOT_TTL_MS = 60_000;
const snapshots = new Map<string, Snapshot>();

export async function cachedSnapshot(db: Db, userId: string): Promise<Snapshot> {
  const hit = snapshots.get(userId);
  if (hit && Date.now() - hit.loaded_at < SNAPSHOT_TTL_MS) return hit;
  const fresh = await loadSnapshot(db);
  snapshots.set(userId, fresh);
  if (snapshots.size > 500) snapshots.delete(snapshots.keys().next().value as string);
  return fresh;
}

export function rememberSnapshot(userId: string, snapshot: Snapshot): void {
  snapshots.set(userId, snapshot);
}

export function forgetSnapshot(userId: string): void {
  snapshots.delete(userId);
}

export function isCarSeat(
  item: Pick<SnapshotItem, "category" | "nickname"> & { car_seat?: boolean },
): boolean {
  return (
    item.car_seat === true || /car.?seat|booster/i.test(`${item.category ?? ""} ${item.nickname}`)
  );
}

// Per-user call times for the last minute, by key ("suggest:<user>", "chat:<user>").
const recentCalls = new Map<string, number[]>();

/** True when `key` has made fewer than FAST_PER_MINUTE fast lane calls in the last minute; counts this one. */
export function fastAllowed(key: string, now = Date.now()): boolean {
  const recent = (recentCalls.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= FAST_PER_MINUTE) {
    recentCalls.set(key, recent);
    return false;
  }
  recent.push(now);
  recentCalls.set(key, recent);
  if (recentCalls.size > 2_000) recentCalls.delete(recentCalls.keys().next().value as string);
  return true;
}

/** Forgets every caller's recent fast lane calls. For tests, so one file's calls don't use up the next file's minute. */
export function resetFastLimits(): void {
  recentCalls.clear();
}

function itemName(item: SnapshotItem): string {
  const make = [item.brand, item.model].filter(Boolean).join(" ");
  return make ? `${item.nickname} (${make})` : item.nickname;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1);
}

/** At most MAX_ROWS lines: all of them, or the ones sharing the most words with the question. */
function candidates(snapshot: Snapshot, message: string): SnapshotRow[] {
  if (snapshot.rows.length <= MAX_ROWS) return snapshot.rows;
  const asked = new Set(words(message));
  const names = new Map(snapshot.items.map((i) => [i.id, itemName(i)]));
  return snapshot.rows
    .map((row, i) => ({
      row,
      i,
      score: words(`${names.get(row.item_id) ?? ""} ${row.label} ${row.value}`).filter((w) =>
        asked.has(w),
      ).length,
    }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, MAX_ROWS)
    .map((s) => s.row);
}

function kindWord(row: SnapshotRow): string {
  if (row.type === "task") return "upkeep task";
  return (
    { error_code: "error code", part: "part", spec: "spec", safety: "safety" }[row.kind] ?? "fact"
  );
}

function line(row: SnapshotRow, item: SnapshotItem | undefined): string {
  const page = row.page ? ` (p. ${row.page})` : "";
  const text = `${item?.nickname ?? "?"} · ${kindWord(row)} · ${row.label}: ${row.value}`;
  return `${text.replace(/\s+/g, " ").slice(0, MAX_LINE_CHARS)}${page}`;
}

/** What the server says when it answers from a saved line. */
export function answerFrom(row: SnapshotRow, item: SnapshotItem, now: string = today()): string {
  const page = row.page
    ? ` Manual page ${row.page}.`
    : row.source === "user"
      ? " You saved this yourself."
      : "";
  if (row.type === "task") {
    const how = row.value.split(/, next due |\. /)[0] ?? row.value;
    const due = row.next_due_on
      ? `, next due ${relativeDay(row.next_due_on, now)} (${row.next_due_on})`
      : "";
    return `${row.label} (${item.nickname}): ${how}${due}.${page}`;
  }
  const value = row.value.trim().replace(/[.\s]+$/, "");
  if (row.kind === "error_code") return `${row.label} on the ${item.nickname}: ${value}.${page}`;
  return `${item.nickname}, ${row.label}: ${value}.${page}`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface FastPick {
  row: SnapshotRow;
  item: SnapshotItem;
  /** Jev's probability that this line answers the question. */
  p: number;
}

export interface FastLane {
  /** The router's answer, from the same call; null when Jev didn't give one. */
  route: RouteDecision | null;
  /** Set when the server can answer from a saved line without Muse. */
  answer: { text: string; pick: FastPick } | null;
  /** Why not, when it can't: shown in the model log. */
  reason: string | null;
  /** The thing Jev thinks it's about, when it's sure enough to tell Muse. */
  thing: SnapshotItem | null;
  /** The likeliest lines, best first, for Muse's hint or for type-ahead. */
  top: FastPick[];
  scores: {
    row: number;
    exists: number;
    judgment: number;
    safety: number;
    thing: number;
    /** "States a lasting fact about the household" (memory.ts); 0 in suggest mode. */
    remember: number;
  };
  ms: number;
  tokens_in: number | null;
}

interface JevAnswers {
  answers?: Record<
    string,
    { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }
  >;
  usage?: { input_tokens?: number };
}

/**
 * One Jev call over the household's saved lines. `mode: "suggest"` asks only
 * which line and whether it's there (type-ahead); "chat" asks everything.
 */
export async function quickAnswer(
  env: Env,
  snapshot: Snapshot,
  turn: { message: string; previous?: string; image?: boolean; mode?: "chat" | "suggest" },
  fetchImpl: typeof fetch = fetch,
): Promise<FastLane | null> {
  const router = env.router;
  const message = turn.message.trim();
  if (!router || !message || !snapshot.rows.length) return null;
  const mode = turn.mode ?? "chat";
  const rows = candidates(snapshot, message);
  const items = new Map(snapshot.items.map((i) => [i.id, i]));
  const rowIds = rows.map((_, i) => `r${i + 1}`);
  const itemIds = snapshot.items.map((_, i) => `i${i + 1}`);
  const questions: Record<string, unknown> = {
    row: {
      type: "choice",
      instructions:
        "Which line of `saved` best answers `question`, or is what `question` is looking for?",
      criteria: Object.fromEntries(rowIds.map((id) => [id, null])),
    },
    exists: {
      type: "noul",
      instructions:
        "Does one line of `saved` state the whole answer to `question`, so nothing else needs to be looked up?",
      criteria: {
        true: "One line states or directly gives the answer",
        false: "No line answers it, or the answer needs more than one line or the manual's text",
      },
    },
  };
  if (mode === "chat") {
    Object.assign(questions, {
      intent: {
        type: "choice",
        instructions: "What is the user's message doing?",
        criteria: ROUTES,
      },
      thing: {
        type: "choice",
        instructions: "Which line of `things` is `question` about?",
        criteria: {
          ...Object.fromEntries(itemIds.map((id) => [id, null])),
          none: "None of them, several of them, or the whole house",
        },
      },
      judgment: {
        type: "noul",
        instructions:
          "Does a good answer to `question` need steps, troubleshooting, a judgment call or advice, rather than reading back one saved value?",
      },
      safety: {
        type: "noul",
        instructions:
          "Is `question` about safety: a child's car seat or its limits, gas, electrical or fire hazards, burns, chemicals, or anything where a wrong answer could hurt someone?",
      },
      // House memory (memory.ts): reads only the person's words, never Muse's.
      remember: {
        type: "noul",
        instructions:
          "Judging only `question`, the person's own words (ignore `muse_said_last`): do they state a lasting fact about their home or household, one worth remembering next time? For example: the water is hard, how or where a thing is installed, how often they use it, who lives there, a habit that won't change soon.",
        criteria: {
          true: "States a lasting fact about the home, its things or the people in it that makes sense on its own",
          false:
            "A question, a request, greetings, something happening right now, a one-off event, upkeep just done, a new reading or measurement, or a fact quoted from a manual",
        },
      },
    });
  }
  const started = Date.now();
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
          app: "Household manuals and upkeep: appliances, baby gear, car seats.",
          ...(mode === "chat" ? { muse_said_last: turn.previous?.slice(0, 800) ?? null } : {}),
          question: message.slice(0, 2_000),
          things: snapshot.items.map((i, n) => `i${n + 1}| ${itemName(i)}`).join("\n"),
          saved: rows.map((r, n) => `r${n + 1}| ${line(r, items.get(r.item_id))}`).join("\n"),
        },
        questions,
      }),
      signal: AbortSignal.timeout(mode === "suggest" ? 2_500 : 4_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as JevAnswers;
    const a = body.answers ?? {};
    const probs = a.row?.probabilities ?? {};
    const top: FastPick[] = rowIds
      .map((id, n) => ({
        id,
        n,
        p: probs[id] ?? (a.row?.choice === id ? (a.row?.confidence ?? 0) : 0),
      }))
      .filter((x) => x.p > 0)
      .sort((x, y) => y.p - x.p)
      .slice(0, 5)
      .flatMap(({ n, p }) => {
        const row = rows[n];
        const item = row && items.get(row.item_id);
        return row && item ? [{ row, item, p }] : [];
      });
    const intent = a.intent;
    const route: RouteDecision | null =
      intent?.choice && intent.choice in ROUTES && typeof intent.confidence === "number"
        ? {
            route: intent.choice as Route,
            confidence: intent.confidence,
            ms: Date.now() - started,
            tokens_in: body.usage?.input_tokens ?? null,
          }
        : null;
    const thingId = a.thing?.choice;
    const thingIndex = thingId?.startsWith("i") ? Number(thingId.slice(1)) - 1 : -1;
    const thingP = a.thing?.confidence ?? 0;
    // Jev's top pick, however sure: a line on another thing is never answered.
    const named = thingIndex >= 0 ? (snapshot.items[thingIndex] ?? null) : null;
    const thing = named && thingP >= THING_HINT ? named : null;
    const scores = {
      row: top[0]?.p ?? 0,
      exists: a.exists?.noul ?? 0,
      judgment: a.judgment?.noul ?? 1,
      safety: a.safety?.noul ?? 1,
      thing: thingP,
      remember: a.remember?.noul ?? 0,
    };
    const lane: FastLane = {
      route,
      answer: null,
      reason: null,
      thing,
      top,
      scores,
      ms: Date.now() - started,
      tokens_in: body.usage?.input_tokens ?? null,
    };
    if (mode === "chat") {
      lane.reason = refuse(lane, turn.image === true, named, snapshot.rows);
      const best = top[0];
      if (!lane.reason && best) lane.answer = { text: answerFrom(best.row, best.item), pick: best };
    }
    return lane;
  } catch {
    return null;
  }
}

function sameLabel(a: SnapshotRow, b: SnapshotRow): boolean {
  return a.label.trim().toLowerCase() === b.label.trim().toLowerCase();
}

/** Why the fast lane can't answer this turn by itself, or null when it can. */
function refuse(
  lane: FastLane,
  image: boolean,
  named: SnapshotItem | null,
  rows: SnapshotRow[],
): string | null {
  const best = lane.top[0];
  if (image) return "photo";
  if (!best) return "no_line";
  if (lane.route?.route !== "ask" || lane.route.confidence < MIN_CONFIDENCE)
    return "not_a_question";
  if (lane.scores.safety > SAFETY_MAX) return "safety";
  if (best.row.kind === "safety" || isCarSeat(best.item)) return "safety";
  if (lane.scores.judgment > JUDGMENT_MAX) return "needs_judgment";
  if (lane.scores.row < ROW_FOUND) return "unsure_line";
  if (lane.scores.exists < EXISTS_FOUND) return "not_saved";
  if (best.row.status === "needs_review") return "needs_review";
  // Jev named a different thing than the line it picked, even unsurely: let Muse sort it out.
  if (named && named.id !== best.item.id) return "thing_mismatch";
  // The same label is saved on another thing too (E4 on the washer and the
  // dryer): answer only when Jev is sure which thing the question means.
  const twin = rows.some(
    (r) => r.item_id !== best.item.id && r.type === best.row.type && sameLabel(r, best.row),
  );
  if (twin && lane.thing?.id !== best.item.id) return "same_label_elsewhere";
  return null;
}

/** The note Muse reads under the user's message: the likely thing and lines, so it calls fewer tools. */
export function hintFor(lane: FastLane): string | null {
  const lines = lane.top
    .filter((t) => t.p >= 0.1 && (!lane.thing || t.item.id === lane.thing.id))
    .slice(0, 3)
    .map((t) => `${line(t.row, t.item)} [${t.row.type} ${t.row.id}]`);
  if (!lane.thing && !lines.length) return null;
  const about = lane.thing
    ? `probably about ${itemName(lane.thing)}, item id ${lane.thing.id}. `
    : "";
  const saved = lines.length ? `Saved lines that may answer it: ${lines.join("; ")}` : "";
  return `[jev hint: ${about}${saved}]`.replace(/\s+\]$/, "]");
}

/** Type-ahead results: the likeliest saved lines, when the answer looks saved. */
export function suggestions(lane: FastLane | null): Suggestion[] {
  if (!lane || lane.scores.exists < SUGGEST_EXISTS) return [];
  return lane.top
    .filter((t) => t.p >= SUGGEST_ROW)
    .slice(0, 3)
    .map(({ row, item, p }) => ({
      id: row.id,
      type: row.type,
      item_id: item.id,
      item: item.nickname,
      label: row.label,
      text: row.type === "task" ? (row.value.split(". ")[0] ?? row.value) : row.value,
      page: row.page,
      p: Math.round(p * 100) / 100,
      // Read from the manual but not checked yet: the page says so next to it.
      unchecked: row.status === "needs_review",
    }));
}

export interface Suggestion {
  id: string;
  type: "fact" | "task";
  item_id: string;
  item: string;
  label: string;
  text: string;
  page: number | null;
  p: number;
  unchecked: boolean;
}

/** The model log's tag for a turn: what the fast lane decided and how sure it was. */
export function fastTag(lane: FastLane): string {
  const s = lane.scores;
  const what = lane.answer ? "answered" : `muse:${lane.reason ?? "?"}`;
  return `fast:${what} line ${s.row.toFixed(2)} saved ${s.exists.toFixed(2)}`;
}
