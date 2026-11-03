import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Db, TaskRow } from "../db.js";
import type { Env } from "../env.js";
import { answerFrom, loadSnapshot, quickAnswer } from "../fastlane.js";
import { findLine, LINE_PAGES, type LineFinding } from "../finder/find-line.js";
import { type GuideRow, guideName, primaryManual } from "../finder/guides.js";
import { PAGE_KIND_KEYS, type PageKind, pageStrip } from "../finder/page-kinds.js";
import { describeInterval, relativeDay } from "../lib/schedule.js";
import { latestReceipts, warrantyStatus } from "../receipt.js";
import { findItem, guarded, itemLabel, reply, session } from "./context.js";

const FACT_COLUMNS = "id, item_id, manual_id, kind, label, value, source_page, source, status";
const MAX_PAGE_CHARS = 20_000;

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "ask_manual",
    {
      title: "Look something up in the manuals",
      description: [
        'Answers from the household\'s manuals, always with page numbers. Use it for "what does E4 mean", "how do I descale", "how often do I clean the filter", "what\'s the max load".',
        "Searches the manual text and also returns matching facts (error codes, parts, specs, safety) exactly. With an item, it adds that item's facts and upkeep schedule.",
        'Search with the manual\'s likely wording ("descale", "error code"), not the whole question.',
        "To check a fact against its source, pass item and page to get that page's full text; if the fact is wrong, fix it with revise_fact.",
        'For a fault, pass kind "fix" to search only the troubleshooting pages (it falls back to every page when none match). With an item, manual_atlas lists its pages by kind (safety, setup, use, care, fix, parts, warranty) for jump links.',
        "Quote the page in your answer. Mention when a fact's status is needs_review.",
        'When a thing has several guides, each page, fact and task carries guide: cite it as "Quick start, p. 6".',
        "Pass the person's whole question as question too: when one saved fact or task answers it outright, it comes back first as best_match (a quick check, no reading).",
        "When the search finds pages, answer_line is the exact line that answers the question, with its page: quote it. covered: false means no line answers it in words; mentioned_on lists the pages that name it. For where a part is, its drawing on one of those pages may answer it (show_diagram); otherwise say the manual doesn't spell it out rather than guessing.",
      ].join(" "),
      inputSchema: z.object({
        query: z.string().min(1).max(200).optional(),
        question: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe("The person's question, word for word, for a quick best_match."),
        item: z.string().optional().describe("Item id or name, to focus on its manual."),
        page: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Return this page's full text (needs item)."),
        max_results: z.number().int().min(1).max(10).default(5),
        kind: z
          .enum(PAGE_KIND_KEYS as [PageKind, ...PageKind[]])
          .optional()
          .describe('Search only pages of this kind, like "fix" for troubleshooting.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, question, item: ref, page, max_results, kind }, ctx) =>
      guarded(async () => {
        if (!query && !ref && !question) throw new Error("Give a query, a question or an item.");
        const { db } = await session(env, ctx);
        const target = ref ? await findItem(db, ref) : null;
        const out: Record<string, unknown> = {};

        // The fast lane's pick, when one saved line answers the whole question.
        if (question) {
          const match = await bestMatch(env, db, question, target?.id);
          if (match) out.best_match = match;
        }

        if (page) {
          if (!target) throw new Error("Pass item with page, so I know which manual.");
          const [{ data, error }, guides] = await Promise.all([
            db
              .from("manual_pages")
              .select("manual_id, page_number, content, manuals!inner(item_id)")
              .eq("manuals.item_id", target.id)
              .eq("page_number", page)
              .limit(5),
            guidesOf(db, [target.id]),
          ]);
          if (error) throw new Error(error.message);
          // Several guides can each have this page: the primary guide's comes first.
          const primary = guides.primary.get(target.id);
          const rows = [...(data ?? [])].sort(
            (a, b) => Number(b.manual_id === primary) - Number(a.manual_id === primary),
          );
          const [hit, ...more] = rows;
          const shown = (r: { manual_id: string; page_number: number; content: string }) => ({
            ...guides.label(r.manual_id),
            page: r.page_number,
            text: r.content.slice(0, MAX_PAGE_CHARS),
          });
          out.page = hit ? shown(hit) : `No text saved for page ${page}.`;
          if (more.length) out.same_page_in_other_guides = more.map(shown);
        }

        if (query) {
          const term = query.trim();
          // Case-insensitive exact label match, so "e4" finds the fact "E4".
          const literal = term.replace(/[\\%_]/g, (c) => `\\${c}`);
          let facts = db
            .from("manual_facts")
            .select(FACT_COLUMNS)
            .ilike("label", literal)
            .neq("status", "not_applicable")
            .limit(10);
          if (target) facts = facts.eq("item_id", target.id);
          const everyPage = () =>
            db.rpc("search_manual_pages", {
              query: term,
              p_item: target?.id ?? null,
              max_results,
            });
          const [exact, first] = await Promise.all([
            facts,
            kind
              ? db.rpc("search_manual_pages_of_kind", {
                  query: term,
                  p_kind: kind,
                  p_item: target?.id ?? null,
                  max_results,
                })
              : everyPage(),
          ]);
          // Pages not sorted by kind yet (or no match among them) are searched as usual.
          let search = first;
          if (kind && (first.error || !first.data?.length)) {
            search = await everyPage();
            if (!search.error && search.data?.length)
              out.kind_note = `No ${kind} pages matched, so every page was searched.`;
          }
          if (search.error) throw new Error(`Search failed: ${search.error.message}`);
          // A misspelled word ("flote", "overfil") finds nothing either: swap it for the
          // closest word the manual really uses, and search again.
          if (!search.data?.length) {
            const fixed = await correctWords(db, term, target?.id ?? null);
            if (fixed) {
              const again = await db.rpc("search_manual_pages", {
                query: fixed.query,
                p_item: target?.id ?? null,
                max_results,
              });
              if (!again.error && again.data?.length) {
                search = again;
                out.spelling = fixed.note;
              }
            }
          }
          // Every word must match, so one extra word ("overfill float location") finds
          // nothing. Then any of the words will do, best-ranked pages first.
          const loose = anyWords(term);
          if (!search.data?.length && loose) {
            const wider = await db.rpc("search_manual_pages", {
              query: loose,
              p_item: target?.id ?? null,
              max_results,
            });
            if (!wider.error && wider.data?.length) search = wider;
          }
          // A different name for it ("flood switch" for the overfill float): Jev picks
          // which of the thing's own parts and tasks the question means.
          if (!search.data?.length && target) {
            const named = await synonymFor(env, db, question ?? term, target.id);
            if (named) {
              const again = await db.rpc("search_manual_pages", {
                query: anyWords(named) ?? named,
                p_item: target.id,
                max_results,
              });
              if (!again.error && again.data?.length) {
                search = again;
                out.read_as = `Read as "${named}", the manual's name for it.`;
              }
            }
          }
          if (exact.data?.length) out.exact_facts = exact.data;
          const hits = (search.data ?? []) as Hit[];
          // Which guide each page is from, for things that have more than one.
          const guides = await guidesOf(db, [...new Set(hits.map((h) => h.item_id))]);
          const where = (h: Hit) => ({
            item: h.item_name,
            ...guides.label(h.manual_id),
            page: h.page_number,
            text: h.snippet,
          });
          // Jev reads the top pages for the line that answers, or finds none does.
          const finding = hits.length
            ? await lineFor(env, db, question ?? term, hits, guides)
            : null;
          const line = finding?.line;
          if (finding?.verdict === "found" && line) {
            out.answer_line = {
              item: line.item,
              page: line.page,
              line: line.line,
              text: line.text,
              confidence: finding.confidence,
            };
          }
          // Only for the person's own question (a bare keyword is too thin to rule a
          // manual out), when Jev read every page the search found, and no saved
          // fact matched either. Otherwise the passages go out as before.
          const uncovered =
            finding?.verdict === "absent" &&
            !!question &&
            hits.length <= LINE_PAGES &&
            !out.best_match &&
            !out.exact_facts;
          if (uncovered) {
            // No line answers it in words, but these pages name it: "where is the
            // overfill float" is answered by page 13's drawing, not by a sentence.
            out.covered = false;
            out.mentioned_on = hits.map(where);
          } else if (hits.length) {
            out.passages = hits.map(where);
          }
        }

        if (target) {
          const [facts, tasks, seats, receipts, kinds, guides] = await Promise.all([
            db
              .from("manual_facts")
              .select(FACT_COLUMNS)
              .eq("item_id", target.id)
              .neq("status", "not_applicable")
              .limit(100),
            db
              .from("tasks")
              .select(
                "id, title, details, interval_unit, interval_value, next_due_on, last_done_on, source_page, source_manual_id, source, status, active",
              )
              .eq("item_id", target.id)
              .order("next_due_on", { ascending: true, nullsFirst: false }),
            db
              .from("seat_modes")
              .select(
                "id, mode, min_weight_kg, max_weight_kg, min_height_cm, max_height_cm, fit_note, source_page, source, status",
              )
              .eq("item_id", target.id)
              .neq("status", "not_applicable"),
            latestReceipts(db, [target.id]),
            db
              .from("manual_pages")
              .select("page_number, kind, manuals!inner(item_id)")
              .eq("manuals.item_id", target.id)
              .not("kind", "is", null)
              .order("page_number")
              .limit(500),
            guidesOf(db, [target.id]),
          ]);
          // A saved receipt rides along, so a question about a fault also learns the warranty.
          const receipt = receipts?.get(target.id);
          out.item = {
            id: target.id,
            name: itemLabel(target),
            ...(receipt ? { warranty: warrantyStatus(receipt).summary } : {}),
          };
          if (facts.data?.length)
            out.facts = facts.data.map(({ manual_id, ...f }) => ({
              ...f,
              ...guides.label(manual_id),
            }));
          if (tasks.data?.length) {
            out.schedule = (
              tasks.data as (TaskRow & {
                source: string;
                status: string;
                source_manual_id: string | null;
              })[]
            ).map((t) => ({
              id: t.id,
              title: t.title,
              how_often: describeInterval(t.interval_unit, t.interval_value),
              details: t.details,
              next_due: t.next_due_on ? relativeDay(t.next_due_on) : null,
              next_due_on: t.next_due_on,
              last_done_on: t.last_done_on,
              page: t.source_page,
              ...guides.label(t.source_manual_id),
              source: t.source,
              status: t.status,
              active: t.active,
            }));
          }
          if (seats.data?.length) out.seat_limits = seats.data;
          // Fails quietly on a database without page kinds: no strip, same answer.
          const strip = kinds.error ? [] : pageStrip(kinds.data ?? []);
          if (strip.length) out.manual_atlas = strip;
        }

        const found = Object.keys(out).filter((k) => k !== "item").length;
        if (!found) {
          // A question alone only asks the fast lane: the manual pages weren't searched.
          return reply(
            query
              ? `Nothing in the saved manuals matches "${query}". Try the manual's own wording.`
              : question && !ref
                ? "No saved fact or task answers that outright, and the manual pages weren't searched. Search them with query, in the manual's likely wording."
                : `${target ? itemLabel(target) : "That item"} has no manual yet. Attach one with add_item (attach_to, pdf_url).`,
          );
        }
        return reply(
          out.answer_line
            ? "Here's the line in the manual that answers it. Quote it with its page."
            : out.covered === false
              ? "No line answers this in words, but mentioned_on lists the pages that name it. If they asked where a part is, what it looks like or how to reach it, call show_diagram with the page that names it: its drawing may show it. Otherwise say the manual doesn't spell it out, instead of stretching related pages into an answer."
              : "Here's what the manuals say. Cite the page numbers.",
          out,
        );
      }),
  );
}

interface Hit {
  manual_id: string;
  item_id: string;
  item_name: string;
  page_number: number;
  snippet: string;
}

interface Guides {
  /** `{ guide: "Quick start" }` for a line from a thing with several guides, else nothing. */
  label: (manualId: string | null | undefined) => { guide?: string };
  /** Each thing's primary guide (its owner's manual, else its first). */
  primary: Map<string, string>;
}

/**
 * The guides of these things, so a line from a thing with more than one can
 * say which guide it's from. Reads every column, so the kind comes along once
 * it exists; on any error, lines simply carry no guide.
 */
export async function guidesOf(db: Db, itemIds: string[]): Promise<Guides> {
  const none: Guides = { label: () => ({}), primary: new Map() };
  if (!itemIds.length) return none;
  try {
    const { data, error } = await db.from("manuals").select("*").in("item_id", itemIds);
    if (error || !Array.isArray(data)) return none;
    return guideLabels(data as (GuideRow & { item_id: string })[]);
  } catch {
    return none;
  }
}

/** Builds the guide labels from a list of manuals (pure, for tests). */
export function guideLabels(manuals: (GuideRow & { item_id: string })[]): Guides {
  const byItem = new Map<string, (GuideRow & { item_id: string })[]>();
  for (const m of manuals) byItem.set(m.item_id, [...(byItem.get(m.item_id) ?? []), m]);
  const names = new Map<string, string>();
  const primary = new Map<string, string>();
  for (const [item, list] of byItem) {
    const first = primaryManual(list);
    if (first) primary.set(item, first.id);
    if (list.length < 2) continue;
    for (const m of list) names.set(m.id, guideName(m));
  }
  return {
    label: (id) => {
      const name = id ? names.get(id) : undefined;
      return name ? { guide: name } : {};
    },
    primary,
  };
}

/**
 * Reads the top search hits' pages in full and asks Jev for the line that
 * answers `question`. Null with Jev unset, or on any error: the passages go
 * out as before.
 */
async function lineFor(
  env: Env,
  db: Db,
  question: string,
  hits: Hit[],
  guides: Guides,
): Promise<LineFinding | null> {
  if (!env.router) return null;
  try {
    const top = hits.slice(0, LINE_PAGES);
    const { data, error } = await db
      .from("manual_pages")
      .select("manual_id, page_number, content")
      .in("manual_id", [...new Set(top.map((h) => h.manual_id))])
      .in("page_number", [...new Set(top.map((h) => h.page_number))]);
    if (error) return null;
    const rows = (data ?? []) as { manual_id: string; page_number: number; content: string }[];
    const pages = top.flatMap((h) => {
      const row = rows.find((r) => r.manual_id === h.manual_id && r.page_number === h.page_number);
      // "Air fryer, Quick start" when the thing has several guides, so the answer names it.
      const guide = guides.label(h.manual_id).guide;
      const item = guide ? `${h.item_name}, ${guide}` : h.item_name;
      return row ? [{ item, page: h.page_number, text: row.content }] : [];
    });
    return pages.length ? await findLine(env, question, pages) : null;
  } catch {
    return null;
  }
}

/**
 * The fast lane inside ask_manual: one Jev call over the saved facts and tasks.
 * Returns the line only when Jev is sure it holds the whole answer and it isn't
 * about safety or a car seat; anything else (or Jev unset or down) returns null.
 */
async function bestMatch(env: Env, db: Db, question: string, itemId?: string) {
  if (!env.router) return null;
  try {
    const snapshot = await loadSnapshot(db);
    const scoped = itemId
      ? { ...snapshot, rows: snapshot.rows.filter((r) => r.item_id === itemId) }
      : snapshot;
    const lane = await quickAnswer(env, scoped, { message: question });
    const pick = lane?.answer?.pick;
    if (!lane?.answer || !pick) return null;
    return {
      answer: answerFrom(pick.row, pick.item),
      item: { id: pick.item.id, name: pick.item.nickname },
      [pick.row.type]: { id: pick.row.id, label: pick.row.label, value: pick.row.value },
      page: pick.row.page,
      confidence: Math.round(pick.p * 100) / 100,
    };
  } catch {
    return null;
  }
}

/** Words people add to a search that no manual page needs ("where is the ... location"). */
const FILLER = new Set(
  "a an and are can do does for from how i in is it its location locate me my of on or out the this to what where which with find show".split(
    " ",
  ),
);

/** The query's words joined with "or" for websearch_to_tsquery, or null when there's only one. */
export function anyWords(term: string): string | null {
  const words = [...new Set(term.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(
    (w) => w.length > 1 && !FILLER.has(w),
  );
  return words.length > 1 ? words.join(" or ") : null;
}

interface Closest {
  word: string;
  closest: string;
  edits: number;
}

/**
 * The query with each word the manual doesn't use swapped for the closest one
 * it does (closest_manual_words: sounds alike, fewest edits, most used). When
 * two candidates tie ("filtre" beside "filter" in a bilingual manual), both are
 * tried. Null when nothing needed fixing.
 */
export async function correctWords(
  db: { rpc: (fn: string, args: object) => PromiseLike<{ data: unknown; error: unknown }> },
  term: string,
  item: string | null,
): Promise<{ query: string; note: string } | null> {
  const words = [...new Set(term.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(
    (w) => w.length > 2 && !FILLER.has(w),
  );
  if (!words.length) return null;
  const { data, error } = await db.rpc("closest_manual_words", { p_item: item, p_words: words });
  if (error || !Array.isArray(data)) return null;
  return fixQuery(words, data as Closest[]);
}

/** Builds the corrected query from closest_manual_words' rows (best first per word). */
export function fixQuery(words: string[], rows: Closest[]): { query: string; note: string } | null {
  const parts: string[] = [];
  const fixes: string[] = [];
  let tie = false;
  for (const w of words) {
    const [first, second] = rows.filter((r) => r.word === w);
    // Not in the manual and nothing close (more than 2 edits, or 1 on a short word): keep it.
    if (!first || first.edits === 0 || first.edits > (w.length <= 4 ? 1 : 2)) {
      parts.push(w);
      continue;
    }
    const alike =
      second &&
      second.edits === first.edits &&
      second.closest.slice(0, 4) === first.closest.slice(0, 4);
    if (alike) tie = true;
    const picks = alike ? [first.closest, second.closest] : [first.closest];
    parts.push(...picks);
    fixes.push(`"${w}" as ${picks.map((x) => `"${x}"`).join(" or ")}`);
  }
  if (!fixes.length) return null;
  return {
    query: tie ? parts.join(" or ") : parts.join(" "),
    note: `Read ${fixes.join(", ")}.`,
  };
}

/**
 * The pick's own probability needed, and it must beat "none of these". Not
 * Jev's confidence, which measures how spread out the answer is rather than
 * whether it's right; "drain strainer" got the filters right at 0.39.
 */
export const SYNONYM_AT = 0.35;

/**
 * The manual's own name for what the question means, from the thing's saved
 * part and fact labels and task titles, in one Jev choice question. Null when
 * Jev is unset, unsure, or none of them fits.
 */
export async function synonymFor(
  env: Env,
  db: Db,
  question: string,
  itemId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const router = env.router;
  if (!router) return null;
  const [facts, tasks] = await Promise.all([
    db
      .from("manual_facts")
      .select("label")
      .eq("item_id", itemId)
      .in("kind", ["part", "other", "safety"])
      .limit(40),
    db.from("tasks").select("title").eq("item_id", itemId).eq("active", true).limit(40),
  ]);
  const names = [
    ...new Set([
      ...(facts.data ?? []).map((f) => f.label as string),
      ...(tasks.data ?? []).map((t) => t.title as string),
    ]),
  ].slice(0, 40);
  if (!names.length) return null;
  const criteria: Record<string, string> = Object.fromEntries(
    names.map((n, i) => [`n${i}`, n.slice(0, 120)]),
  );
  criteria.none = "None of these: the question is about something else.";
  try {
    const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${router.apiKey}` },
      body: JSON.stringify({
        model: router.model,
        state: { question: question.slice(0, 300) },
        questions: {
          means: {
            type: "choice",
            instructions:
              "Which of the manual's parts or tasks is `question` asking about, even if it calls it by another name?",
            criteria,
          },
        },
      }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      answers?: { means?: { choice?: string; probabilities?: Record<string, number> } };
    };
    const pick = body.answers?.means;
    if (!pick?.choice || pick.choice === "none") return null;
    const p = pick.probabilities?.[pick.choice] ?? 0;
    if (p < SYNONYM_AT || p <= (pick.probabilities?.none ?? 0)) return null;
    return criteria[pick.choice] ?? null;
  } catch {
    return null;
  }
}
