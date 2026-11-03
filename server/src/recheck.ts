import type { Db } from "./db.js";
import type { Env } from "./env.js";
import { primaryManual } from "./finder/guides.js";
import { formatPages } from "./finder/reader.js";
import { logRun } from "./runs.js";
import {
  applyRevision,
  changesSchema,
  type Kind,
  type RevisionChanges,
} from "./tools/revise-fact.js";

// The second read. The first read (Muse turning a manual into tasks and facts)
// flags lines it wasn't sure of, and Jev flags lines that don't match their
// page. Here a separate Muse call takes each flagged line on its own, with
// only its page and the pages around it, and says: the page confirms it, the
// page says something else (and what), it doesn't apply to this model, or
// it's still unsure. A verdict only counts if it quotes the page word for
// word: a quote that isn't on the page makes it "unsure". Lines it can't
// settle stay flagged for a person, through the site or any MCP client.

/** Most flagged lines looked at in one go, and how many Muse calls run at once. */
export const RECHECK_MAX = 12;
const AT_ONCE = 6;
/** Per line; the whole pass has to stay under the 45 s some MCP clients allow. */
const LINE_TIMEOUT_MS = 22_000;

export type Verdict = "confirm" | "fix" | "not_applicable" | "unsure";

export interface Flagged {
  id: string;
  type: Kind;
  item_id: string;
  item: string;
  page: number | null;
  /** The manual the line cites; null falls back to the thing's primary guide. */
  manual_id?: string | null;
  /** Another guide says otherwise (its value and page), so a person decides. */
  note?: string | null;
  /** The line as saved, in the fields Muse may change. */
  line: Record<string, unknown>;
}

export interface Check {
  id: string;
  type: Kind;
  item: string;
  page: number | null;
  what: string;
  verdict: Verdict;
  reason: string;
  quote?: string;
  changes?: RevisionChanges;
  /** Flagged because two guides disagree: shown, never saved without a yes. */
  disagrees?: boolean;
}

export const RECHECK_INSTRUCTIONS = `You double-check one line that a first read pulled out of a product manual, against the manual's own pages. Another reader wasn't sure of it. Judge it only from the pages given; never from what's usual for products like this.
Return JSON: {"verdict": "confirm" | "fix" | "not_applicable" | "unsure", "quote": "...", "reason": "...", "changes": {...}}.
- "confirm": the pages say what the line says.
- "fix": the pages say something different. Put only the fields to change in "changes", using the line's own field names. For car seat limits use min_weight, max_weight with weight_unit (lb|kg), min_height, max_height with height_unit (in|cm), and fit_note.
- "not_applicable": the pages say plainly that it's only for other models, or that this model doesn't have the part. A line that only says "if your product has X" is "unsure", not this.
- "unsure": the pages don't settle it, they contradict themselves, or the page isn't there.
"quote": the exact words from the pages that settle it, copied character for character, under 200 characters. Required unless the verdict is "unsure".
"reason": one short plain sentence for the owner, citing the page number, in English.
Keep error codes, part numbers and numbers exactly as printed. Return only JSON.`;

/** Lowercase letters and digits only, so a quote matches however the PDF broke its lines. */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Whether the quote really is on one of the pages. */
export function quoteFound(quote: string | undefined, pages: { content: string }[]): boolean {
  const q = squash(quote ?? "");
  if (q.length < 12) return false;
  return pages.some((p) => squash(p.content).includes(q));
}

/** A line as one sentence, for the owner and for the verdict list. */
export function describeLine(f: Flagged): string {
  const l = f.line as Record<string, string | number | null>;
  if (f.type === "fact") return `${l.label}: ${l.value}${f.note ? ` (${f.note})` : ""}`;
  if (f.type === "task") return l.details ? `${l.title}: ${l.details}` : String(l.title);
  const range = (lo: unknown, hi: unknown, unit: string) =>
    hi ? `${lo ?? 0} to ${hi} ${unit}` : "";
  return [
    `${String(l.mode).replace(/_/g, " ")} limits`,
    range(l.min_weight_kg, l.max_weight_kg, "kg"),
    range(l.min_height_cm, l.max_height_cm, "cm"),
    l.fit_note ? `(${l.fit_note})` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

type Named = { nickname: string } | { nickname: string }[] | null;
const nameOf = (i: Named) => (Array.isArray(i) ? i[0]?.nickname : i?.nickname) ?? "the thing";
const itemIdOf = (i: unknown) =>
  ((Array.isArray(i) ? i[0] : i) as { id?: string } | null)?.id ?? "";

/** Every line still flagged in the household (RLS keeps it to theirs), or one thing's. */
export async function loadFlagged(db: Db, itemId?: string): Promise<Flagged[]> {
  // Typed loosely on purpose: the query builder's generics run too deep across three tables.
  const flagged = (table: string, columns: string) => {
    let q = db
      .from(table)
      .select(`${columns}, items!inner(id, nickname, archived_at)`)
      .eq("status", "needs_review")
      .is("items.archived_at", null);
    if (itemId) q = q.eq("item_id", itemId);
    return q as unknown as Promise<{
      data: Record<string, unknown>[] | null;
      error: { message: string } | null;
    }>;
  };
  const [facts, tasks, seats] = await Promise.all([
    flagged("manual_facts", "id, kind, label, value, source_page, manual_id"),
    flagged(
      "tasks",
      "id, title, details, interval_unit, interval_value, source_page, source_manual_id",
    ),
    flagged(
      "seat_modes",
      "id, mode, min_weight_kg, max_weight_kg, min_height_cm, max_height_cm, fit_note, source_page, manual_id",
    ),
  ]);
  for (const r of [facts, tasks, seats]) if (r.error) throw new Error(r.error.message);
  const notes = await factNotes(
    db,
    (facts.data ?? []).map((f) => f.id as string),
  );
  const rows = (type: Kind, data: Record<string, unknown>[] | null): Flagged[] =>
    (data ?? []).map(({ id, items: owner, source_page, manual_id, source_manual_id, ...line }) => ({
      id: id as string,
      type,
      item_id: itemIdOf(owner),
      item: nameOf(owner as Named),
      page: (source_page as number | null) ?? null,
      manual_id: ((manual_id ?? source_manual_id) as string | null | undefined) ?? null,
      ...(type === "fact" && notes.get(id as string) ? { note: notes.get(id as string) } : {}),
      line,
    }));
  return [
    ...rows("fact", facts.data),
    ...rows("task", tasks.data),
    ...rows("seat_limit", seats.data),
  ];
}

/**
 * The notes on flagged facts (another guide says otherwise). Read on their
 * own, so the check still runs on a database without the note column yet.
 */
async function factNotes(db: Db, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  try {
    const { data, error } = await db
      .from("manual_facts")
      .select("id, note")
      .in("id", ids)
      .not("note", "is", null);
    if (error || !Array.isArray(data)) return new Map();
    return new Map(
      (data as { id: string; note: string | null }[]).flatMap((r) =>
        r.note ? [[r.id, r.note] as [string, string]] : [],
      ),
    );
  } catch {
    return new Map();
  }
}

/** The cited page and its neighbors, from the manual the line cites, else the thing's primary guide. */
async function pagesFor(db: Db, itemId: string, page: number, manualId?: string | null) {
  let id = manualId ?? null;
  if (!id) {
    // Every column, so the kind comes along once it exists: the owner's manual is the primary one.
    const { data: manuals } = await db
      .from("manuals")
      .select("*")
      .eq("item_id", itemId)
      .order("created_at", { ascending: true });
    id = primaryManual((manuals ?? []) as { id: string; kind?: string | null }[])?.id ?? null;
  }
  if (!id) return [];
  const { data } = await db
    .from("manual_pages")
    .select("page_number, content")
    .eq("manual_id", id)
    .gte("page_number", Math.max(1, page - 1))
    .lte("page_number", page + 1)
    .order("page_number");
  return (data ?? []) as { page_number: number; content: string }[];
}

interface Usage {
  tokens_in: number;
  tokens_out: number;
}

/** One flagged line, one Muse call, one verdict. Anything that goes wrong is "unsure". */
export async function checkLine(
  env: Env,
  f: Flagged,
  pages: { page_number: number; content: string }[],
  usage: Usage,
  fetchImpl: typeof fetch = fetch,
): Promise<Check> {
  const base = {
    id: f.id,
    type: f.type,
    item: f.item,
    page: f.page,
    what: describeLine(f),
    ...(f.note ? { disagrees: true } : {}),
  };
  const unsure = (reason: string): Check => ({ ...base, verdict: "unsure", reason });
  const reader = env.reader;
  if (!reader) return unsure("No reader is set up here.");
  if (!pages.length) return unsure("Its page isn't saved, so there's nothing to check it against.");
  try {
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
          { role: "system", content: RECHECK_INSTRUCTIONS },
          {
            role: "user",
            content: `Thing: ${f.item}\nThe line (a ${f.type.replace("_", " ")}, cited to page ${f.page}):\n${JSON.stringify(f.line)}\n\n${formatPages(pages)}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(LINE_TIMEOUT_MS),
    });
    if (!res.ok) return unsure("The second read didn't answer.");
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    usage.tokens_in += body.usage?.prompt_tokens ?? 0;
    usage.tokens_out += body.usage?.completion_tokens ?? 0;
    const text = (body.choices?.[0]?.message?.content ?? "").replace(
      /^```(?:json)?\s*|\s*```$/g,
      "",
    );
    const out = JSON.parse(text) as {
      verdict?: string;
      quote?: string;
      reason?: string;
      changes?: RevisionChanges;
    };
    const verdict = (["confirm", "fix", "not_applicable", "unsure"] as const).find(
      (v) => v === out.verdict,
    );
    const reason = String(out.reason ?? "").slice(0, 300);
    if (!verdict || verdict === "unsure") return unsure(reason || "The pages don't settle it.");
    // The safeguard: a verdict has to stand on words that really are on the page.
    if (!quoteFound(out.quote, pages))
      return unsure("The second read couldn't quote the page for it, so it stays flagged.");
    // Muse's fields go through the same schema as revise_fact's, so a stray type can't be saved.
    const parsed = verdict === "fix" ? changesSchema.safeParse(out.changes ?? {}) : null;
    // Only the fields Muse gave: the schema's default units don't count as changes.
    const given = new Set(Object.keys(out.changes ?? {}));
    const changes = parsed?.success
      ? (Object.fromEntries(
          Object.entries(parsed.data).filter(([k]) => given.has(k)),
        ) as RevisionChanges)
      : undefined;
    if (verdict === "fix" && (!changes || !Object.keys(changes).length))
      return unsure(reason || "The page differs, but the fix wasn't clear.");
    return { ...base, verdict, reason, quote: String(out.quote).slice(0, 240), changes };
  } catch {
    return unsure("The second read didn't finish.");
  }
}

/** Runs `work` over `list`, a few at a time. */
async function pooled<T, R>(list: T[], size: number, work: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, list.length) }, async () => {
      while (next < list.length) {
        const i = next++;
        out[i] = await work(list[i] as T);
      }
    }),
  );
  return out;
}

export interface RecheckResult {
  checks: Check[];
  /** The model_runs row that holds these verdicts, for applying them later. */
  run_id: string | null;
  /** Flagged lines left out because one pass takes at most RECHECK_MAX. */
  more: number;
}

/** The second read over a household's (or one thing's) flagged lines. Saves nothing but the log. */
export async function recheckFlagged(
  env: Env,
  db: Db,
  opts: { itemId?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<RecheckResult> {
  const all = await loadFlagged(db, opts.itemId);
  const flagged = all.slice(0, RECHECK_MAX);
  const started = Date.now();
  const usage: Usage = { tokens_in: 0, tokens_out: 0 };
  const cache = new Map<string, Promise<{ page_number: number; content: string }[]>>();
  const checks = await pooled(flagged, AT_ONCE, async (f) => {
    if (f.page == null) return checkLine(env, f, [], usage, fetchImpl);
    const key = `${f.item_id}:${f.manual_id ?? ""}:${f.page}`;
    if (!cache.has(key)) cache.set(key, pagesFor(db, f.item_id, f.page, f.manual_id));
    return checkLine(env, f, await (cache.get(key) as Promise<never>), usage, fetchImpl);
  });
  let runId: string | null = null;
  if (checks.length) {
    const { data } = await db
      .from("model_runs")
      .insert({
        kind: "recheck",
        ok: true,
        model: env.reader?.model ?? null,
        ms: Date.now() - started,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        ...(opts.itemId ? { item_id: opts.itemId } : {}),
        raw_output: JSON.stringify({ checks }).slice(0, 20_000),
      })
      .select("id")
      .maybeSingle();
    runId = (data?.id as string | undefined) ?? null;
  }
  return { checks, run_id: runId, more: Math.max(0, all.length - flagged.length) };
}

/** Which verdicts the automatic pass after a read may save without asking. */
export function autoApplies(c: Check): boolean {
  // Two guides disagree: its own page agreeing doesn't settle which one fits, so a person says.
  if (c.disagrees) return false;
  if (c.verdict === "confirm") return true;
  // A changed car seat limit is a safety number: a person says yes to that.
  if (c.verdict === "fix" || c.verdict === "not_applicable") return c.type !== "seat_limit";
  return false;
}

/** Saves verdicts as revisions, citing the second read's quote. Returns how many were saved. */
export async function applyChecks(
  db: Db,
  householdId: string,
  checks: Check[],
): Promise<{ applied: Check[]; skipped: { check: Check; why: string }[] }> {
  const applied: Check[] = [];
  const skipped: { check: Check; why: string }[] = [];
  for (const c of checks) {
    if (c.verdict === "unsure") continue;
    try {
      const out = await applyRevision(db, householdId, {
        id: c.id,
        type: c.type,
        changes: c.verdict === "fix" ? c.changes : undefined,
        not_applicable: c.verdict === "not_applicable",
        reason: `Second read${c.page ? `, p. ${c.page}` : ""}: "${c.quote}". ${c.reason}`.slice(
          0,
          1000,
        ),
        source: "assistant",
      });
      if (out.ok) applied.push(c);
      else skipped.push({ check: c, why: out.message });
    } catch (err) {
      skipped.push({ check: c, why: (err as Error).message });
    }
  }
  return { applied, skipped };
}

/** After a manual is read: the second read on its flagged lines, saving the ones it can quote. */
export async function recheckAfterRead(
  env: Env,
  db: Db,
  householdId: string,
  itemId: string,
): Promise<void> {
  try {
    const { checks } = await recheckFlagged(env, db, { itemId });
    await applyChecks(db, householdId, checks.filter(autoApplies));
  } catch (err) {
    await logRun(db, {
      kind: "recheck",
      ok: false,
      item_id: itemId,
      error: (err as Error).message.slice(0, 500),
    });
  }
}
