import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Db, TaskRow } from "../db.js";
import type { Env } from "../env.js";
import { answerFrom, loadSnapshot, quickAnswer } from "../fastlane.js";
import { findLine, LINE_PAGES, type LineFinding } from "../finder/find-line.js";
import { PAGE_KIND_KEYS, type PageKind, pageStrip } from "../finder/page-kinds.js";
import { describeInterval, relativeDay } from "../lib/schedule.js";
import { latestReceipts, warrantyStatus } from "../receipt.js";
import { findItem, guarded, itemLabel, reply, session } from "./context.js";

const FACT_COLUMNS = "id, item_id, kind, label, value, source_page, source, status";
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
        "Pass the person's whole question as question too: when one saved fact or task answers it outright, it comes back first as best_match (a quick check, no reading).",
        "When the search finds pages, answer_line is the exact line that answers the question, with its page: quote it. covered: false means the pages searched don't answer it: say the manual doesn't seem to cover it rather than guessing.",
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
          const { data, error } = await db
            .from("manual_pages")
            .select("page_number, content, manuals!inner(item_id)")
            .eq("manuals.item_id", target.id)
            .eq("page_number", page)
            .limit(1);
          if (error) throw new Error(error.message);
          const hit = data?.[0];
          out.page = hit
            ? { page: hit.page_number, text: hit.content.slice(0, MAX_PAGE_CHARS) }
            : `No text saved for page ${page}.`;
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
          if (exact.data?.length) out.exact_facts = exact.data;
          const hits = (search.data ?? []) as Hit[];
          // Jev reads the top pages for the line that answers, or finds none does.
          const finding = hits.length ? await lineFor(env, db, question ?? term, hits) : null;
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
            out.covered = false;
            out.searched = hits.map((h) => ({ item: h.item_name, page: h.page_number }));
          } else if (hits.length) {
            out.passages = hits.map((h) => ({
              item: h.item_name,
              page: h.page_number,
              text: h.snippet,
            }));
          }
        }

        if (target) {
          const [facts, tasks, seats, receipts, kinds] = await Promise.all([
            db
              .from("manual_facts")
              .select(FACT_COLUMNS)
              .eq("item_id", target.id)
              .neq("status", "not_applicable")
              .limit(100),
            db
              .from("tasks")
              .select(
                "id, title, details, interval_unit, interval_value, next_due_on, last_done_on, source_page, source, status, active",
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
          ]);
          // A saved receipt rides along, so a question about a fault also learns the warranty.
          const receipt = receipts?.get(target.id);
          out.item = {
            id: target.id,
            name: itemLabel(target),
            ...(receipt ? { warranty: warrantyStatus(receipt).summary } : {}),
          };
          if (facts.data?.length) out.facts = facts.data;
          if (tasks.data?.length) {
            out.schedule = (tasks.data as (TaskRow & { source: string; status: string })[]).map(
              (t) => ({
                id: t.id,
                title: t.title,
                how_often: describeInterval(t.interval_unit, t.interval_value),
                details: t.details,
                next_due: t.next_due_on ? relativeDay(t.next_due_on) : null,
                next_due_on: t.next_due_on,
                last_done_on: t.last_done_on,
                page: t.source_page,
                source: t.source,
                status: t.status,
                active: t.active,
              }),
            );
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
              ? "The manual doesn't seem to cover this. Say so plainly instead of stretching related pages into an answer."
              : "Here's what the manuals say. Cite the page numbers.",
          out,
        );
      }),
  );
}

interface Hit {
  manual_id: string;
  item_name: string;
  page_number: number;
  snippet: string;
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
      return row ? [{ item: h.item_name, page: h.page_number, text: row.content }] : [];
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
