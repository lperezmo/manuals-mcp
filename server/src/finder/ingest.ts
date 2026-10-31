import type { Db, ItemRow, ManualRow } from "../db.js";
import type { Env } from "../env.js";
import { BUDGET_USED, logRun, modelRunsTodayAll } from "../runs.js";
import { itemLabel } from "../tools/context.js";
import { saveKnowledge } from "./knowledge.js";
import { type PageText, pdfPages } from "./pdf-text.js";
import { distill, ReaderError } from "./reader.js";
import { verifyKnowledge } from "./verify.js";

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

/** Processes a manual whose PDF is already in storage (the app's upload path). */
export async function processStoredManual(args: {
  env: Env;
  db: Db;
  householdId: string;
  manualId: string;
}): Promise<IngestOutcome> {
  const { db } = args;
  const { data, error } = await db
    .from("manuals")
    .select(
      "id, storage_path, items(id, household_id, kind, category, nickname, brand, model, serial, purchased_on, uses_per_week, child_id, notes)",
    )
    .eq("id", args.manualId)
    .single();
  if (error || !data) throw new Error("No manual with that id in this household.");
  if (!data.storage_path) throw new Error("That manual has no PDF uploaded yet.");
  const item = (Array.isArray(data.items) ? data.items[0] : data.items) as ItemRow | undefined;
  if (!item) throw new Error("That manual isn't attached to an item.");
  const file = await db.storage.from(BUCKET).download(data.storage_path);
  if (file.error || !file.data) throw new Error(`Couldn't read the PDF: ${file.error?.message}`);
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  return processPdf({ ...args, item, bytes });
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

  for (let i = 0; i < pages.length; i += PAGE_BATCH) {
    const rows = pages.slice(i, i + PAGE_BATCH).map((p) => ({
      household_id: householdId,
      manual_id: manualId,
      page_number: p.page_number,
      content: p.content,
      extracted_by: "pdf_text",
    }));
    const { error } = await db
      .from("manual_pages")
      .upsert(rows, { onConflict: "manual_id,page_number" });
    if (error) throw new Error(`Couldn't save pages: ${error.message}`);
  }

  const scanned = pages.length < Math.max(1, pageCount * 0.2);
  await db
    .from("manuals")
    .update({
      page_count: pageCount,
      status: "text_ready",
      status_detail: scanned
        ? "Mostly scanned pages with no text layer; a model needs to read the images."
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
    const verified = await verifyKnowledge(env, knowledge, pages);
    if (env.router) {
      await logRun(db, {
        kind: "read",
        ok: true,
        model: env.router.model,
        ms: verified.ms,
        tokens_in: verified.tokens_in,
        tokens_out: 0,
        item_id: item.id,
        manual_id: manualId,
        raw_output: JSON.stringify({ checked: verified.checked, flagged: verified.flagged }),
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
