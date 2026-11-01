import { z } from "zod";
import type { Db } from "./db.js";
import type { Env } from "./env.js";
import { daysBetween, today } from "./lib/schedule.js";

// Reads a store receipt or warranty card from a photo with the reader model
// (Muse Spark): purchase date, store, price and warranty length. The app then
// knows when the warranty ends, and Muse can say a repair is likely covered.

/** Within this many days of the end, the warranty is "ending soon". */
export const ENDING_SOON_DAYS = 60;

const day = z.iso.date().nullish().catch(null);

export const receiptSchema = z.object({
  found: z.boolean().catch(false).default(false),
  kind: z.enum(["receipt", "warranty_card", "other"]).nullish().catch(null),
  store: z.string().trim().max(120).nullish().catch(null),
  purchased_on: day,
  price: z.coerce.number().positive().max(10_000_000).nullish().catch(null),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .nullish()
    .catch(null),
  warranty_months: z.coerce.number().int().min(1).max(1200).nullish().catch(null),
  warranty_ends_on: day,
  warranty_note: z.string().trim().max(500).nullish().catch(null),
  unsure: z.boolean().catch(false).default(false),
});

export type ReceiptRead = z.infer<typeof receiptSchema>;

const INSTRUCTIONS = `You read store receipts and product warranty cards in photos for a household app that tracks warranties.
Return JSON: "found" (true if a receipt, invoice or warranty card is visible), "kind" (receipt|warranty_card|other), "store" (the seller's name), "purchased_on" (purchase date as YYYY-MM-DD), "price" (what was paid for the product as a plain number, no currency sign; the product line, not the total, when the receipt lists several things), "currency" (ISO code like USD), "warranty_months" (the warranty length in months, e.g. 1 year is 12; the main or parts-and-labor warranty when there are several), "warranty_ends_on" (YYYY-MM-DD, only if an end date is printed), "warranty_note" (one short line on what the warranty covers, in the card's words), "unsure" (true if any part was hard to read).
Use null for anything not visible. Never guess a date or a price. Return only JSON.`;

export async function readReceipt(
  env: Env,
  image: { mime: string; base64: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ReceiptRead> {
  const reader = env.reader;
  if (!reader) throw new Error("The photo reader isn't configured (READER_* settings).");
  const res = await fetchImpl(`${reader.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(reader.apiKey ? { authorization: `Bearer ${reader.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: env.chatModel ?? reader.model,
      response_format: { type: "json_object" },
      max_tokens: 1500,
      messages: [
        { role: "system", content: INSTRUCTIONS },
        {
          role: "user",
          content: [
            { type: "text", text: `Read this receipt or warranty card. Today is ${today()}.` },
            { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`The photo reader answered ${res.status}.`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = (body.choices?.[0]?.message?.content ?? "").replace(/^```(?:json)?\s*|\s*```$/g, "");
  return receiptSchema.parse(JSON.parse(text));
}

/** A day plus whole months; the 31st lands on the month's last day, like Postgres. */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

export interface ReceiptRow {
  id: string;
  item_id: string;
  kind: "receipt" | "warranty_card" | "other";
  purchased_on: string | null;
  store: string | null;
  price: number | null;
  currency: string | null;
  warranty_months: number | null;
  warranty_ends_on: string | null;
  warranty_note: string | null;
  image_path: string | null;
  read_by: "server" | "user";
  created_at: string;
}

export const RECEIPT_COLUMNS =
  "id, item_id, kind, purchased_on, store, price, currency, warranty_months, warranty_ends_on, warranty_note, image_path, read_by, created_at";

export interface Warranty {
  status: "covered" | "ending_soon" | "ended" | "unknown";
  ends_on: string | null;
  days_left: number | null;
  /** One plain sentence for the page or for Muse to relay. */
  summary: string;
}

type WarrantyInput = Pick<ReceiptRow, "purchased_on" | "warranty_months" | "warranty_ends_on">;

/** When the warranty ends: the printed date, or the purchase date plus its length. */
export function warrantyEnds(r: WarrantyInput): string | null {
  if (r.warranty_ends_on) return r.warranty_ends_on;
  if (r.purchased_on && r.warranty_months) return addMonths(r.purchased_on, r.warranty_months);
  return null;
}

export function warrantyStatus(r: WarrantyInput | null, on: string = today()): Warranty {
  const ends = r ? warrantyEnds(r) : null;
  if (!r || !ends) {
    return {
      status: "unknown",
      ends_on: null,
      days_left: null,
      summary: r?.purchased_on
        ? `Bought ${r.purchased_on}; the warranty length isn't saved, so check the warranty card or the manual's warranty page.`
        : "No receipt or warranty card is saved for it.",
    };
  }
  const left = daysBetween(on, ends);
  if (left < 0) {
    return {
      status: "ended",
      ends_on: ends,
      days_left: left,
      summary: `The warranty ended ${ends}, so a repair likely isn't covered.`,
    };
  }
  return {
    status: left <= ENDING_SOON_DAYS ? "ending_soon" : "covered",
    ends_on: ends,
    days_left: left,
    summary: `Likely still under warranty until ${ends} (${left} day${left === 1 ? "" : "s"} left). Before paying for a repair, contact the maker or store with the receipt.`,
  };
}

/** The newest receipt for each of these items. Null when receipts aren't set up (migration not applied). */
export async function latestReceipts(
  db: Db,
  itemIds: string[],
): Promise<Map<string, ReceiptRow> | null> {
  if (!itemIds.length) return new Map();
  const { data, error } = await db
    .from("receipts")
    .select(RECEIPT_COLUMNS)
    .in("item_id", itemIds)
    .order("created_at", { ascending: false });
  if (error) return null;
  const out = new Map<string, ReceiptRow>();
  for (const row of (data ?? []) as ReceiptRow[])
    if (!out.has(row.item_id)) out.set(row.item_id, row);
  return out;
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Saves a read receipt as the user: the photo to the private "receipts"
 * bucket, the row, and the item's purchase date when it has none. Each step
 * that can't run (no bucket or table yet) is skipped, and the note says so.
 */
export async function saveReceipt(opts: {
  db: Db;
  householdId: string;
  item: { id: string; purchased_on: string | null };
  read: ReceiptRead;
  image: { mime: string; base64: string };
}): Promise<{ receipt: ReceiptRow | null; image_saved: boolean; note?: string }> {
  const { db, householdId, item, read, image } = opts;
  const id = crypto.randomUUID();
  const path = `${householdId}/${id}.${EXT[image.mime] ?? "jpg"}`;
  const upload = await db.storage
    .from("receipts")
    .upload(path, Buffer.from(image.base64, "base64"), { contentType: image.mime, upsert: true });
  const imageSaved = !upload.error;
  if (read.purchased_on && !item.purchased_on) {
    await db.from("items").update({ purchased_on: read.purchased_on }).eq("id", item.id);
  }
  const { data, error } = await db
    .from("receipts")
    .insert({
      id,
      household_id: householdId,
      item_id: item.id,
      kind: read.kind ?? "receipt",
      purchased_on: read.purchased_on ?? null,
      store: read.store ?? null,
      price: read.price ?? null,
      currency: read.currency ?? null,
      warranty_months: read.warranty_months ?? null,
      warranty_ends_on: read.warranty_ends_on ?? null,
      warranty_note: read.warranty_note ?? null,
      image_path: imageSaved ? path : null,
      read_by: "server",
    })
    .select(RECEIPT_COLUMNS)
    .single();
  if (error) {
    return {
      receipt: null,
      image_saved: imageSaved,
      note: `Receipts can't be saved here yet (the database needs its update)${read.purchased_on && !item.purchased_on ? ", so only the purchase date was kept" : ""}.`,
    };
  }
  return { receipt: data as ReceiptRow, image_saved: imageSaved };
}
