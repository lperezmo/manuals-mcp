import type { Db } from "../db.js";
import { isUuid } from "../tools/context.js";
import { looksLikePdf, MAX_PDF_BYTES } from "./fetch-pdf.js";
import { BUCKET } from "./ingest.js";

// Upload slots: when a maker's site blocks our server but the person's AI can
// download the PDF in its own sandbox or browser, the AI sends the bytes
// straight to Supabase Storage with a signed upload URL, then calls add_item
// with the slot's id. The bytes never pass through our functions (so Vercel's
// request body limit doesn't apply) and never go through a tool call.
//
// The slot lives in the household's own folder of the manuals bucket, so the
// existing storage policies cover it: signing needs INSERT on the path (the
// caller's own token, checked by RLS), and reading it back needs SELECT.

export const UPLOAD_FOLDER = "uploads";
/** Supabase Storage signs upload URLs for two hours; a client can't ask for less. */
export const SLOT_TTL_MS = 2 * 60 * 60_000;
/** An upload nobody attached is cleared when the household next asks for a slot. */
export const STALE_UPLOAD_MS = 24 * 60 * 60_000;

/** The upload was missing, not a PDF, too big, or not this household's. Nothing was saved. */
export class UploadError extends Error {}

export function uploadPath(householdId: string, uploadId: string): string {
  return `${householdId}/${UPLOAD_FOLDER}/${uploadId}.pdf`;
}

export interface UploadSlot {
  upload_id: string;
  path: string;
  upload_url: string;
  method: "PUT";
  headers: Record<string, string>;
  max_bytes: number;
  expires_at: string;
}

/** Signs a one-file upload URL for a new path in the household's uploads folder. */
export async function createUploadSlot(
  db: Db,
  householdId: string,
  now = Date.now(),
): Promise<UploadSlot> {
  const uploadId = crypto.randomUUID();
  const path = uploadPath(householdId, uploadId);
  // No upsert: the URL takes one file, and nothing already stored can be replaced through it.
  const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(`Couldn't open an upload slot: ${error?.message}`);
  return {
    upload_id: uploadId,
    path,
    upload_url: data.signedUrl,
    method: "PUT",
    headers: { "content-type": "application/pdf" },
    max_bytes: MAX_PDF_BYTES,
    expires_at: new Date(now + SLOT_TTL_MS).toISOString(),
  };
}

/**
 * Turns an upload_id (the bare id, or the path the slot gave) into a path in
 * the caller's household. Anything else is refused before storage is asked.
 */
export function resolveUpload(householdId: string, ref: string): string {
  const value = ref.trim().toLowerCase();
  if (isUuid(value)) return uploadPath(householdId, value);
  const parts = value.split("/");
  if (parts.length === 3 && parts[1] === UPLOAD_FOLDER && parts[2]?.endsWith(".pdf")) {
    const [folder, , file] = parts as [string, string, string];
    const id = file.slice(0, -".pdf".length);
    if (isUuid(folder) && isUuid(id)) {
      if (folder !== householdId.toLowerCase())
        throw new UploadError("That upload isn't in your household.");
      return uploadPath(householdId, id);
    }
  }
  throw new UploadError("That isn't an upload_id from request_manual_upload.");
}

/** Best effort: a leftover upload only costs storage, and the next slot request sweeps it. */
export async function discardUpload(db: Db, path: string): Promise<void> {
  try {
    await db.storage.from(BUCKET).remove([path]);
  } catch {
    // Swept later.
  }
}

/**
 * Checks an upload and reads it: it must exist in the caller's household, be
 * at most 40 MB, and start like a PDF. A bad upload is removed so the slot
 * can take the right file.
 */
export async function readUpload(
  db: Db,
  householdId: string,
  ref: string,
): Promise<{ path: string; bytes: Uint8Array }> {
  const path = resolveUpload(householdId, ref);
  const folder = `${householdId}/${UPLOAD_FOLDER}`;
  const name = path.slice(folder.length + 1);
  const { data: listed, error } = await db.storage
    .from(BUCKET)
    .list(folder, { search: name, limit: 10 });
  if (error) throw new Error(`Couldn't check the upload: ${error.message}`);
  const entry = (listed ?? []).find((o) => o.name === name);
  if (!entry) {
    throw new UploadError(
      "Nothing has been uploaded to that slot yet, or it was already used. Send the PDF to the upload_url first, or call request_manual_upload for a new slot.",
    );
  }
  const declared = Number((entry.metadata as { size?: unknown } | null)?.size ?? 0);
  if (declared > MAX_PDF_BYTES) {
    await discardUpload(db, path);
    throw new UploadError("That PDF is too big (over 40 MB).");
  }
  const file = await db.storage.from(BUCKET).download(path);
  if (file.error || !file.data) {
    throw new Error(`Couldn't read the upload: ${file.error?.message ?? "nothing came back"}`);
  }
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  if (bytes.byteLength > MAX_PDF_BYTES) {
    await discardUpload(db, path);
    throw new UploadError("That PDF is too big (over 40 MB).");
  }
  if (!looksLikePdf(bytes)) {
    await discardUpload(db, path);
    throw new UploadError(
      "The upload isn't a PDF (a PDF starts with %PDF). Send the file's raw bytes, not base64, JSON or a web page, then call add_item again.",
    );
  }
  return { path, bytes };
}

/** Removes uploads in the household's folder that were never attached. Never throws. */
export async function sweepStaleUploads(
  db: Db,
  householdId: string,
  now = Date.now(),
): Promise<number> {
  try {
    const folder = `${householdId}/${UPLOAD_FOLDER}`;
    const { data } = await db.storage
      .from(BUCKET)
      .list(folder, { limit: 100, sortBy: { column: "created_at", order: "asc" } });
    const stale = (data ?? [])
      .filter((o) => o.created_at && now - Date.parse(o.created_at) > STALE_UPLOAD_MS)
      .map((o) => `${folder}/${o.name}`);
    if (stale.length) await db.storage.from(BUCKET).remove(stale);
    return stale.length;
  } catch {
    return 0;
  }
}
