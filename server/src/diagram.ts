import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Db } from "./db.js";
import type { Env } from "./env.js";
import { primaryManual } from "./finder/guides.js";
import { BUCKET } from "./finder/ingest.js";
import { renderPages } from "./finder/vision.js";
import { askJev, type Box } from "./photo-check.js";
import { findItem } from "./tools/context.js";

// "Where's the drain pump?" Muse found the page; this shows the manual's own
// drawing of it, with the part circled. The cited page and its neighbors are
// rendered, and one Jev call (well under a second) says which page's drawing
// shows the part, where that drawing is, and where the part is in it. The
// drawing is cut out and the circle is drawn here, on the manual's own pixels:
// an image model redraws a page and changes its words ("pump" came back
// "purnp"), so it never touches a manual page.

/** Jev must think a page shows the part at least this much to prefer it over the cited one. */
export const SHOWS_AT = 0.3;
/**
 * Box always answers, and its confidence measures how concentrated the answer
 * is, not whether it's right (TypeSafe's guidance), so the "shows" yes/no is
 * the real gate; this only drops boxes Jev was scattered on.
 */
export const PART_AT = 0.15;

export interface DiagramArgs {
  item: string;
  page: number;
  part: string;
}

export interface Drawing {
  /** The cut-out drawing with the part circled, as a JPEG data URL. */
  image: string;
  page: number;
  /** False when Jev couldn't pinpoint the part: the drawing is shown without a circle. */
  circled: boolean;
}

/** Edges as fractions, clamped, with a margin around them. */
export function padBox(box: Box, margin = 0.04): Box {
  return {
    top: Math.max(0, box.top - margin),
    bottom: Math.min(1, box.bottom + margin),
    left: Math.max(0, box.left - margin),
    right: Math.min(1, box.right + margin),
  };
}

/** The smallest box holding both. */
export function union(a: Box, b: Box): Box {
  return {
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
    left: Math.min(a.left, b.left),
    right: Math.max(a.right, b.right),
  };
}

const usableBox = (b: { box?: Box; confidence?: number } | undefined, at: number): Box | null => {
  if (!b?.box || typeof b.confidence !== "number" || b.confidence < at) return null;
  const { top, bottom, left, right } = b.box;
  if (![top, bottom, left, right].every((e) => typeof e === "number" && e >= 0 && e <= 1))
    return null;
  return right > left && bottom > top ? b.box : null;
};

/**
 * Cuts `crop` out of a PNG page, scaled to about `long` px on its long side,
 * and circles `part` (both as fractions of the page) in teal.
 */
export async function drawMarked(
  pngBase64: string,
  crop: Box,
  part: Box | null,
  long = 1100,
): Promise<string> {
  const img = await loadImage(Buffer.from(pngBase64, "base64"));
  const sx = crop.left * img.width;
  const sy = crop.top * img.height;
  const sw = Math.max(1, (crop.right - crop.left) * img.width);
  const sh = Math.max(1, (crop.bottom - crop.top) * img.height);
  const scale = Math.min(2.5, long / Math.max(sw, sh));
  const canvas = createCanvas(Math.round(sw * scale), Math.round(sh * scale));
  const g = canvas.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  if (part) {
    const x = (part.left * img.width - sx) * scale;
    const y = (part.top * img.height - sy) * scale;
    const w = (part.right - part.left) * img.width * scale;
    const h = (part.bottom - part.top) * img.height * scale;
    const line = Math.max(4, Math.round(canvas.width / 160));
    g.strokeStyle = "#14b8a6";
    g.lineWidth = line;
    g.beginPath();
    g.ellipse(x + w / 2, y + h / 2, w / 2 + line * 2, h / 2 + line * 2, 0, 0, Math.PI * 2);
    g.stroke();
  }
  return `data:image/jpeg;base64,${(await canvas.encode("jpeg", 88)).toString("base64")}`;
}

/** Finds the manual's drawing of the part near the cited page. */
export async function findDrawing(
  env: Env,
  db: Db,
  args: DiagramArgs,
  fetchImpl: typeof fetch = fetch,
): Promise<Drawing> {
  const item = await findItem(db, args.item);
  // The thing's primary guide (its owner's manual, else its first). Every column, so the kind comes along once it exists.
  const { data: manuals, error } = await db
    .from("manuals")
    .select("*")
    .eq("item_id", item.id)
    .not("storage_path", "is", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  const manual = primaryManual(
    (manuals ?? []) as {
      id: string;
      kind?: string | null;
      storage_path: string;
      page_count: number | null;
    }[],
  );
  if (!manual?.storage_path)
    throw new Error(`There's no manual PDF saved for the ${item.nickname}.`);
  const file = await db.storage.from(BUCKET).download(manual.storage_path);
  if (file.error || !file.data) throw new Error("Couldn't open the manual's PDF.");
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  return drawingFromPdf(env, bytes, manual.page_count, args, fetchImpl);
}

/** The drawing of the part from a manual's PDF bytes: the cited page or a neighbor, cut out. */
export async function drawingFromPdf(
  env: Env,
  bytes: Uint8Array,
  pageCount: number | null,
  args: Pick<DiagramArgs, "page" | "part">,
  fetchImpl: typeof fetch = fetch,
): Promise<Drawing> {
  const last = pageCount ?? args.page + 1;
  const wanted = [args.page, args.page - 1, args.page + 1].filter((n) => n >= 1 && n <= last);
  const pages = await renderPages(bytes, wanted);
  if (!pages.length) throw new Error(`The manual has no page ${args.page}.`);

  // One Jev call per page, in parallel (three pages in one call is over Jev's size limit):
  // does a drawing show the part, where is that drawing, where is the part.
  let chosen = pages[0] as (typeof pages)[number];
  let crop: Box = { top: 0, bottom: 1, left: 0, right: 1 };
  let part: Box | null = null;
  const router = env.router;
  if (router) {
    type Answers = Record<string, { noul?: number; box?: Box; confidence?: number }>;
    const looks = await Promise.all(
      pages.map(async (p): Promise<Answers | null> => {
        try {
          const res = await askJev(
            router,
            {
              state: { page: "page" },
              assets: { page: { type: "image", format: "png", data_base64: p.png_base64 } },
              questions: {
                shows: {
                  type: "noul",
                  instructions: `Does \`page\` have a drawing, diagram or photo that shows ${args.part}?`,
                },
                drawing: {
                  type: "box",
                  instructions: `Where is the whole diagram in \`page\` that shows ${args.part}, with its labels?`,
                },
                part: {
                  type: "box",
                  instructions: `Where is ${args.part} drawn in \`page\`? The drawn part itself, not its text label.`,
                },
              },
            },
            8_000,
            fetchImpl,
          );
          return res.ok ? (((await res.json()) as { answers?: Answers }).answers ?? null) : null;
        } catch {
          return null;
        }
      }),
    );
    const score = (i: number) => looks[i]?.shows?.noul ?? -1;
    let at = 0;
    // Stay on the cited page unless another page clearly has the drawing and it doesn't.
    const best = pages.map((_, i) => i).sort((x, y) => score(y) - score(x))[0] ?? 0;
    if (score(best) >= SHOWS_AT && score(0) < SHOWS_AT) at = best;
    chosen = pages[at] as (typeof pages)[number];
    const look = looks[at];
    // The circle needs Jev to say the page shows the part: a Box alone always points somewhere.
    part = score(at) >= SHOWS_AT ? usableBox(look?.part, PART_AT) : null;
    const drawing = usableBox(look?.drawing, 0.3);
    if (drawing || part)
      crop = padBox(union(drawing ?? (part as Box), part ?? (drawing as Box)), 0.06);
  }
  return {
    image: await drawMarked(chosen.png_base64, crop, part ? padBox(part, 0.01) : null),
    page: chosen.page_number,
    circled: !!part,
  };
}
