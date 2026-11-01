import type { Db, ItemRow, ManualRow } from "../db.js";
import type { Env } from "../env.js";
import { BUDGET_USED, logRun, modelRunsTodayAll } from "../runs.js";
import { itemLabel } from "../tools/context.js";
import { saveKnowledge } from "./knowledge.js";
import { pageKinds } from "./page-kinds.js";
import { type PageText, pdfPages } from "./pdf-text.js";
import { distill, ReaderError } from "./reader.js";
import { trimTrivia } from "./trim.js";
import { verifyKnowledge } from "./verify.js";
import { englishPages, MAX_VISION_PAGES, renderPages, transcribePages } from "./vision.js";

// Turns a manual PDF into raw pages (searchable) and, when a server reader
// is configured, distilled tasks and facts. Without a reader the manual is
// left at "text_ready": searchable, but with no schedule.

export const BUCKET = "manuals";

/** What the page shows when the reader failed. The page offers "Read it again" on it. */
export const READ_FAILED =
  "Muse couldn't turn it into a schedule this time. The text is still searchable, and you can read it again.";
const PAGE_BATCH = 50;

export function storagePath(householdId: string, manualId: string): string {
  return `${householdId}/${manualId}.pdf`;
}

export interface IngestOutcome {
  manual_id: string;
  status: ManualRow["status"];
  page_count: number | null;
  pages_with_text: number;
  distilled: { tasks: number; facts: number; seat_modes: number; needs_review: number } | null;
  note?: string;
}

interface StoreArgs {
  db: Db;
  householdId: string;
  item: ItemRow;
  bytes: Uint8Array;
  source: "pdf_upload" | "url";
  sourceUrl?: string;
  official?: boolean;
  title?: string;
}

/** Creates a manual for an item from PDF bytes, then processes it. */
export async function ingestPdf(args: StoreArgs & { env: Env }): Promise<IngestOutcome> {
  const manualId = await storeManual(args);
  return processPdf({
    env: args.env,
    db: args.db,
    householdId: args.householdId,
    item: args.item,
    manualId,
    bytes: args.bytes,
  });
}

/**
 * Saves the PDF and its manual row, without reading it. The website attaches
 * a manual in two calls (store, then /api/ingest), so a slow maker's site and
 * Muse's read each get their own time limit.
 */
export async function storeManual(args: StoreArgs): Promise<string> {
  const { db, householdId, item } = args;
  const { data: manual, error } = await db
    .from("manuals")
    .insert({
      household_id: householdId,
      item_id: item.id,
      title: args.title ?? `${itemLabel(item)} manual`,
      source: args.source,
      source_url: args.sourceUrl ?? null,
      official: args.official ?? null,
      status: "pending",
    })
    .select("id")
    .single();
  if (error || !manual) throw new Error(`Couldn't create the manual: ${error?.message}`);

  const path = storagePath(householdId, manual.id);
  const upload = await db.storage
    .from(BUCKET)
    .upload(path, args.bytes, { contentType: "application/pdf", upsert: true });
  if (upload.error) throw new Error(`Couldn't store the PDF: ${upload.error.message}`);
  await db.from("manuals").update({ storage_path: path }).eq("id", manual.id);
  return manual.id as string;
}

/** A read past this is taken as dead (the function limit is 300 s), so the lock frees itself. */
export const READING_STALE_MS = 6 * 60_000;
/** "Read it again" right after a read is refused: the same pages give the same answer. */
export const REREAD_COOLDOWN_MS = 2 * 60_000;

/** Another read of this manual is running, or one just finished. Nothing was sent to Muse. */
export class ReadingBusyError extends Error {}

/**
 * Processes a manual whose PDF is already in storage (the app's upload path).
 * A manual that is already read comes back as it is unless `reread` is set,
 * and only one read of a manual runs at a time, so repeated taps cost one read.
 */
export async function processStoredManual(args: {
  env: Env;
  db: Db;
  householdId: string;
  manualId: string;
  reread?: boolean;
}): Promise<IngestOutcome> {
  const { db } = args;
  const { data, error } = await db
    .from("manuals")
    .select(
      "id, storage_path, status, page_count, reader_at, items(id, household_id, kind, category, nickname, brand, model, serial, purchased_on, uses_per_week, child_id, notes)",
    )
    .eq("id", args.manualId)
    .single();
  if (error || !data) throw new Error("No manual with that id in this household.");
  if (!data.storage_path) throw new Error("That manual has no PDF uploaded yet.");
  const item = (Array.isArray(data.items) ? data.items[0] : data.items) as ItemRow | undefined;
  if (!item) throw new Error("That manual isn't attached to an item.");
  if (data.status === "distilled" && !args.reread) {
    return {
      manual_id: data.id,
      status: "distilled",
      page_count: data.page_count,
      pages_with_text: 0,
      distilled: null,
      note: "Already read.",
    };
  }
  if (
    args.reread &&
    data.reader_at &&
    Date.now() - Date.parse(data.reader_at) < REREAD_COOLDOWN_MS
  ) {
    throw new ReadingBusyError(
      "Muse just read this manual. Give it a couple of minutes before reading it again.",
    );
  }

  // One UPDATE claims the manual: a second caller's row no longer matches the filter.
  const now = new Date();
  const stale = new Date(now.getTime() - READING_STALE_MS).toISOString();
  const { data: claimed, error: claimError } = await db
    .from("manuals")
    .update({ reading_since: now.toISOString() })
    .eq("id", data.id)
    .or(`reading_since.is.null,reading_since.lt.${stale}`)
    .select("id");
  if (claimError) throw new Error(`Couldn't start the read: ${claimError.message}`);
  if (!claimed?.length) {
    throw new ReadingBusyError(
      "Muse is already reading this manual. It shows up here when it's done.",
    );
  }
  try {
    const file = await db.storage.from(BUCKET).download(data.storage_path);
    if (file.error || !file.data) throw new Error(`Couldn't read the PDF: ${file.error?.message}`);
    const bytes = new Uint8Array(await file.data.arrayBuffer());
    return await processPdf({ ...args, item, bytes });
  } finally {
    await db.from("manuals").update({ reading_since: null }).eq("id", data.id);
  }
}

/** Whether the household's daily manual reads and the site's model budget both have room. */
async function readsLeft(env: Env, db: Db): Promise<boolean> {
  if (!env.reader) return false;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await db
    .from("manuals")
    .select("id", { count: "exact", head: true })
    .gte("reader_at", since);
  if ((count ?? 0) >= env.reader.dailyLimit) return false;
  return (await modelRunsTodayAll(db)) < env.globalDailyLimit;
}

/**
 * Manual atlas: Jev sorts the pages by kind (safety, setup, use, care, fix...).
 * Written on its own after the pages, so a failed call, or a database without
 * the kind columns yet, only means no jump links for this manual.
 */
export async function savePageKinds(
  env: Env,
  db: Db,
  manualId: string,
  pages: PageText[],
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (!env.router || !pages.length) return 0;
  const { kinds } = await pageKinds(env, pages, fetchImpl);
  if (!kinds.size) return 0;
  // One update per kind and rounded sureness, so a 200-page manual is a few dozen small writes.
  const groups = new Map<string, number[]>();
  for (const [page, { kind, p }] of kinds) {
    const key = `${kind}|${Math.round(p * 20) / 20}`;
    groups.set(key, [...(groups.get(key) ?? []), page]);
  }
  try {
    const results = await Promise.all(
      [...groups].map(([key, pageNumbers]) => {
        const [kind, p] = key.split("|");
        return db
          .from("manual_pages")
          .update({ kind, kind_p: Number(p) })
          .eq("manual_id", manualId)
          .in("page_number", pageNumbers);
      }),
    );
    if (results.some((r) => r.error)) return 0;
  } catch {
    return 0;
  }
  return kinds.size;
}

async function processPdf(args: {
  env: Env;
  db: Db;
  householdId: string;
  item: ItemRow;
  manualId: string;
  bytes: Uint8Array;
}): Promise<IngestOutcome> {
  const { env, db, householdId, item, manualId } = args;
  let pages: PageText[];
  let pageCount: number;
  try {
    ({ pages, pageCount } = await pdfPages(args.bytes));
  } catch (err) {
    await db
      .from("manuals")
      .update({
        status: "failed",
        status_detail: `Couldn't open the PDF: ${(err as Error).message}`,
      })
      .eq("id", manualId);
    throw new Error("Couldn't open that PDF.");
  }

  // No text layer on most pages (a scan, or text drawn as outlines): render
  // them and let Muse transcribe the English ones, when there's budget for it.
  const visionPages = new Set<number>();
  const textless = pages.length < Math.max(1, pageCount * 0.2);
  if (textless && env.reader && (await readsLeft(env, db))) {
    const started = Date.now();
    const have = new Set(pages.map((p) => p.page_number));
    const missing = Array.from({ length: pageCount }, (_, i) => i + 1).filter((n) => !have.has(n));
    try {
      const images = await renderPages(args.bytes, missing);
      const { english, tokens_in: jevTokens } = await englishPages(env, images);
      const { pages: read, usage } = await transcribePages(env, english.slice(0, MAX_VISION_PAGES));
      for (const p of read) visionPages.add(p.page_number);
      pages = [...pages, ...read].sort((a, b) => a.page_number - b.page_number);
      await logRun(db, {
        kind: "read",
        ok: read.length > 0,
        model: env.chatModel ?? env.reader.model,
        ms: Date.now() - started,
        tokens_in: usage.tokens_in,
        tokens_out: usage.tokens_out,
        item_id: item.id,
        manual_id: manualId,
        pages_sent: read.map((p) => p.page_number),
        raw_output: JSON.stringify({
          step: "transcribe page images",
          rendered: images.length,
          english: english.length,
          calls: usage.calls,
          failed_calls: usage.failed,
          jev_tokens: jevTokens,
        }),
      });
    } catch (err) {
      await logRun(db, {
        kind: "read",
        ok: false,
        model: env.chatModel ?? env.reader.model,
        error: `Couldn't transcribe the page images: ${(err as Error).message}`,
        ms: Date.now() - started,
        item_id: item.id,
        manual_id: manualId,
      });
    }
  }

  for (let i = 0; i < pages.length; i += PAGE_BATCH) {
    const rows = pages.slice(i, i + PAGE_BATCH).map((p) => ({
      household_id: householdId,
      manual_id: manualId,
      page_number: p.page_number,
      content: p.content,
      extracted_by: visionPages.has(p.page_number) ? "server_model" : "pdf_text",
    }));
    const { error } = await db
      .from("manual_pages")
      .upsert(rows, { onConflict: "manual_id,page_number" });
    if (error) throw new Error(`Couldn't save pages: ${error.message}`);
  }
  await savePageKinds(env, db, manualId, pages);

  const scanned = pages.length < Math.max(1, pageCount * 0.2);
  const transcribed = visionPages.size;
  await db
    .from("manuals")
    .update({
      page_count: pageCount,
      status: "text_ready",
      status_detail: scanned
        ? "Mostly scanned pages with no text layer; a model needs to read the images."
        : transcribed
          ? `No text layer, so Muse read ${transcribed} page ${transcribed === 1 ? "image" : "images"}.`
          : null,
    })
    .eq("id", manualId);

  const outcome: IngestOutcome = {
    manual_id: manualId,
    status: "text_ready",
    page_count: pageCount,
    pages_with_text: pages.length,
    distilled: null,
  };

  if (!env.reader || pages.length === 0) {
    outcome.note = env.reader
      ? "No text layer to read."
      : "Text is saved and searchable with ask_manual. No reader is configured, so there's no schedule yet.";
    return outcome;
  }

  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await db
    .from("manuals")
    .select("id", { count: "exact", head: true })
    .gte("reader_at", since);
  if ((count ?? 0) >= env.reader.dailyLimit) {
    outcome.note = `Saved and searchable. The daily limit of ${env.reader.dailyLimit} manual reads is used up, so it wasn't read yet; try again tomorrow.`;
    await db.from("manuals").update({ status_detail: outcome.note }).eq("id", manualId);
    return outcome;
  }
  if ((await modelRunsTodayAll(db)) >= env.globalDailyLimit) {
    outcome.note = `Saved and searchable, but not read yet. ${BUDGET_USED}`;
    await db.from("manuals").update({ status_detail: outcome.note }).eq("id", manualId);
    return outcome;
  }

  const started = Date.now();
  try {
    const { knowledge, usage, trace, trimmed, dropped } = await distill(env, {
      itemLabel: itemLabel(item),
      pages,
    });
    await logRun(db, {
      kind: "read",
      ok: true,
      model: usage.model,
      ms: Date.now() - started,
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      item_id: item.id,
      manual_id: manualId,
      pages_sent: trace.pages_sent,
      chars_sent: trace.chars_sent,
      raw_output: trace.raw_output,
    });
    await db
      .from("manuals")
      .update({
        reader_at: new Date().toISOString(),
        reader_model: usage.model,
        reader_tokens_in: usage.tokens_in,
        reader_tokens_out: usage.tokens_out,
      })
      .eq("id", manualId);
    // Each entry checked against its own page; misses are flagged, never dropped.
    const lean = await trimTrivia(env, knowledge, { label: itemLabel(item), kind: item.kind });
    const verified = await verifyKnowledge(env, lean.knowledge, pages);
    if (env.router) {
      await logRun(db, {
        kind: "read",
        ok: true,
        model: env.router.model,
        ms: verified.ms,
        tokens_in: verified.tokens_in + lean.tokens_in,
        tokens_out: 0,
        item_id: item.id,
        manual_id: manualId,
        raw_output: JSON.stringify({
          checked: verified.checked,
          flagged: verified.flagged,
          dropped_as_common_sense: lean.dropped,
        }),
      });
    }
    outcome.distilled = await saveKnowledge({
      db,
      householdId,
      itemId: item.id,
      manualId,
      knowledge: verified.knowledge,
      replace: true,
    });
    outcome.status = "distilled";
    if (trimmed || dropped || verified.flagged.length) {
      const doubted = verified.flagged.length;
      outcome.note = [
        doubted
          ? `${doubted} ${doubted === 1 ? "entry didn't" : "entries didn't"} match ${doubted === 1 ? "its" : "their"} page and ${doubted === 1 ? "is" : "are"} flagged for you to check`
          : "",
        trimmed
          ? `${trimmed} long ${trimmed === 1 ? "entry was" : "entries were"} shortened and flagged for you to check`
          : "",
        dropped
          ? `${dropped} ${dropped === 1 ? "entry" : "entries"} didn't fit and ${dropped === 1 ? "was" : "were"} left out`
          : "",
      ]
        .filter(Boolean)
        .join("; ")
        .replace(/^./, (c) => c.toUpperCase())
        .concat(".");
    }
  } catch (err) {
    const trace = err instanceof ReaderError ? err.trace : undefined;
    await logRun(db, {
      kind: "read",
      ok: false,
      model: trace?.usage?.model ?? env.reader.model,
      error: (err as Error).message,
      ms: Date.now() - started,
      tokens_in: trace?.usage?.tokens_in,
      tokens_out: trace?.usage?.tokens_out,
      item_id: item.id,
      manual_id: manualId,
      pages_sent: trace?.pages_sent,
      chars_sent: trace?.chars_sent,
      raw_output: trace?.raw_output,
    });
    // The full error stays in model_runs; the page gets a sentence a person can use.
    outcome.note = READ_FAILED;
    await db.from("manuals").update({ status_detail: outcome.note }).eq("id", manualId);
  }
  return outcome;
}
