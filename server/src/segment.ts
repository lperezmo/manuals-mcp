import { decodeMaskToSVGPath, parseImageStream, recordsOfKind } from "@meta-sam/parser";
import { createCanvas, loadImage, Path2D } from "@napi-rs/canvas";
import type { Env } from "./env.js";
import type { Marked } from "./mark-photo.js";
import { askJev, BOX_AT, PRESENT_AT } from "./photo-check.js";

// "Which one is the cup filter?" on the person's own photo, in about a second
// and a quarter of a cent. Jev reads Muse's description ("the round gray cup
// in the middle of the mesh") and boxes where that part is (well under a
// second). SAM 3.1, Meta's segmentation model, then traces the exact edge of
// the thing inside that box, and the outline is drawn here on the photo's own
// pixels, so nothing else in the picture changes. SAM alone is too literal to
// pick the part ("round filter" found a round cap first), and a loose box
// gives it a messy mask; Jev's tight box is what makes it land. Anything
// unsure or down returns null and the caller falls back to Muse Image.

/** The photo is sent and drawn at most this many px on its long side. */
export const LONG_SIDE = 1280;
/** SAM must be at least this sure of the outline it traced. */
export const SAM_AT = 0.5;
/** Jev's box call cap; SAM gets the rest of the call's budget. */
const JEV_MS = 3_000;
const SAM_MS = 12_000;

/** A box in photo pixels, right and bottom exclusive. */
export interface PxBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Muse's instruction as a description Jev can box: "Circle the cup" becomes "the cup". */
export function partOf(instruction: string): string {
  return instruction
    .trim()
    .replace(/[.\s]+$/, "")
    .replace(/^(please\s+)?(circle|mark|point (out|to|at)|show|highlight|outline)\s+/i, "");
}

/** The object prompt SAM reads: one object, frame 0, boxed in source pixels (x2/y2 inclusive). */
export function boxPrompt(box: PxBox, w: number, h: number): string {
  const x1 = Math.max(0, Math.floor(box.left));
  const y1 = Math.max(0, Math.floor(box.top));
  const x2 = Math.min(w - 1, Math.ceil(box.right) - 1);
  const y2 = Math.min(h - 1, Math.ceil(box.bottom) - 1);
  return `<0f>0<|box;x1=${x1};y1=${y1};x2=${x2};y2=${y2};w=${w};h=${h}|>`;
}

/** Where Jev thinks the part is, in pixels, or null when it isn't sure it's there. */
export async function locatePart(
  env: Env,
  jpegBase64: string,
  part: string,
  w: number,
  h: number,
  fetchImpl: typeof fetch,
): Promise<PxBox | null> {
  const router = env.router;
  if (!router) return null;
  try {
    const res = await askJev(
      router,
      {
        state: { photo: "part-photo" },
        assets: { "part-photo": { type: "image", format: "jpg", data_base64: jpegBase64 } },
        questions: {
          box: { type: "box", instructions: `${part}, in \`photo\`` },
          present: { type: "noul", instructions: `Does \`photo\` show ${part}?` },
        },
      },
      JEV_MS,
      fetchImpl,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      answers?: Record<
        string,
        { noul?: number; confidence?: number; box?: Record<string, unknown> }
      >;
    };
    const present = body.answers?.present?.noul;
    const found = body.answers?.box;
    const b = found?.box;
    if (typeof present !== "number" || present < PRESENT_AT) return null;
    if (typeof found?.confidence !== "number" || found.confidence < BOX_AT || !b) return null;
    const edge = (k: string) => {
      const v = b[k];
      return typeof v === "number" && v >= 0 && v <= 1 ? v : null;
    };
    const left = edge("left");
    const top = edge("top");
    const right = edge("right");
    const bottom = edge("bottom");
    if (left === null || top === null || right === null || bottom === null) return null;
    if (right <= left || bottom <= top) return null;
    return { left: left * w, top: top * h, right: right * w, bottom: bottom * h };
  } catch {
    return null;
  }
}

export interface Outline {
  /** An SVG path in mask coordinates, offset by `at`. */
  path: string;
  at: { left: number; top: number };
  confidence: number | null;
}

/** SAM's sharpest outline of the object in the box, or null for no confident match. */
export async function traceInBox(
  image: NonNullable<Env["image"]>,
  dataUrl: string,
  box: PxBox,
  w: number,
  h: number,
  fetchImpl: typeof fetch,
): Promise<Outline | null> {
  const res = await fetchImpl(`${image.baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${image.apiKey}` },
    body: JSON.stringify({
      model: image.segmentModel,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: boxPrompt(box, w, h) },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
      metadata: { include_confidence: "true" },
    }),
    signal: AbortSignal.timeout(SAM_MS),
  });
  if (!res.ok) throw new Error(`The segmentation model answered ${res.status}.`);
  const body = (await res.json()) as {
    output?: { content?: { type?: string; text?: string }[] }[];
  };
  const text = (body.output ?? [])
    .flatMap((o) => o.content ?? [])
    .map((c) => c.text ?? "")
    .join("");
  if (!text.trim()) return null;
  async function* events() {
    yield {
      type: "response.output_text.done",
      item_id: "sam",
      output_index: 0,
      content_index: 0,
      text,
    } as const;
    yield { type: "response.completed" } as const;
  }
  const parsed = parseImageStream(events() as never);
  for await (const _ of parsed) {
    // Only the final result matters.
  }
  const result = await parsed.finalResult;
  const masks = recordsOfKind(result.records, "mask") as unknown as {
    mask: Parameters<typeof decodeMaskToSVGPath>[0];
    bounds: { left: number; top: number; right: number; bottom: number };
    confidence?: number;
  }[];
  const best = masks
    .filter((m) => m.confidence === undefined || m.confidence >= SAM_AT)
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  if (!best) return null;
  return {
    path: decodeMaskToSVGPath(best.mask),
    at: { left: best.bounds.left, top: best.bounds.top },
    confidence: best.confidence ?? null,
  };
}

/**
 * Outlines the part Muse described on the person's photo, or null when Jev
 * can't place it or SAM can't trace it (the caller then asks Muse Image).
 */
export async function outlinePart(
  env: Env,
  photo: { mime: string; base64: string },
  instruction: string,
  fetchImpl: typeof fetch = fetch,
): Promise<(Marked & { model: string }) | null> {
  const image = env.image;
  if (!image || !env.router) return null;
  const started = Date.now();
  // Drawing it first applies the photo's rotation, so boxes match what's drawn.
  const img = await loadImage(Buffer.from(photo.base64, "base64"));
  const scale = Math.min(1, LONG_SIDE / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = createCanvas(w, h);
  const g = canvas.getContext("2d");
  g.drawImage(img, 0, 0, w, h);
  const jpeg = (await canvas.encode("jpeg", 85)).toString("base64");

  const box = await locatePart(env, jpeg, partOf(instruction), w, h, fetchImpl);
  if (!box) return null;
  const outline = await traceInBox(image, `data:image/jpeg;base64,${jpeg}`, box, w, h, fetchImpl);
  if (!outline) return null;

  const path = new Path2D(outline.path);
  const width = Math.max(4, Math.round(Math.max(w, h) / 220));
  g.save();
  g.translate(outline.at.left, outline.at.top);
  g.lineJoin = "round";
  g.lineCap = "round";
  g.strokeStyle = "rgba(0, 0, 0, 0.4)";
  g.lineWidth = width * 2;
  g.stroke(path);
  g.strokeStyle = "#2ee6d6";
  g.lineWidth = width;
  g.stroke(path);
  g.restore();
  return {
    image: `data:image/jpeg;base64,${(await canvas.encode("jpeg", 82)).toString("base64")}`,
    ms: Date.now() - started,
    tokens_in: null,
    tokens_out: null,
    model: image.segmentModel,
  };
}
