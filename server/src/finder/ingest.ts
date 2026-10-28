import type { Db, ItemRow, ManualRow } from "../db.js";
import type { Env } from "../env.js";
import { itemLabel } from "../tools/context.js";
import { saveKnowledge } from "./knowledge.js";
import { type PageText, pdfPages } from "./pdf-text.js";
import { distill } from "./reader.js";

// Turns a manual PDF into raw pages (searchable) and, when a server reader
// is configured, distilled tasks and facts. Without a reader the manual is
// left at "text_ready": searchable, but with no schedule.

export const BUCKET = "manuals";
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

/** Creates a manual for an item from PDF bytes, then processes it. */
export async function ingestPdf(args: {
  env: Env;
  db: Db;
  householdId: string;
  item: ItemRow;
  bytes: Uint8Array;
  source: "pdf_upload" | "url";
  sourceUrl?: string;
  official?: boolean;
  title?: string;
}): Promise<IngestOutcome> {
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

  return processPdf({
    env: args.env,
    db,
    householdId,
    item,
    manualId: manual.id,
    bytes: args.bytes,
  });
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

  try {
    const knowledge = await distill(env, { itemLabel: itemLabel(item), pages });
    outcome.distilled = await saveKnowledge({
      db,
      householdId,
      itemId: item.id,
      manualId,
      knowledge,
      replace: true,
    });
    outcome.status = "distilled";
  } catch (err) {
    outcome.note = `The server reader couldn't distill it (${(err as Error).message}); the text is still searchable.`;
    await db.from("manuals").update({ status_detail: outcome.note }).eq("id", manualId);
  }
  return outcome;
}
