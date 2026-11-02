import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { Db } from "./db.js";
import type { Env } from "./env.js";

// "Which one is the cup filter?" Muse names the part, and Meta's image model
// draws a circle on the person's own photo to point at it, changing nothing
// else. One image call each (about a cent), counted in model_runs as kind
// "image" against a hard cap kept under the free credits.

/** What the image model is told, around Muse's instruction. */
export function markPrompt(instruction: string): string {
  return `${instruction.trim().replace(/[.\s]+$/, "")}. Point it out with one bright teal circle (or an arrow if a circle would hide it). Keep the photo exactly as it is otherwise: same framing, colors and details, nothing added or removed.`;
}

/** Said when the cap is reached; the answer still comes, just without the marked photo. */
export const CAP_REACHED =
  "The photo markup budget is used up, so describe where it is in words instead.";

/** Image calls so far, across every household (they share one credit). */
export async function imagesUsed(db: Db): Promise<number> {
  const { data, error } = await db.rpc("image_runs_total");
  if (error) throw new Error(`Couldn't check the image budget: ${error.message}`);
  return typeof data === "number" ? data : 0;
}

/** A marked image as a JPEG data URL, at most `max` px on its long side, small enough to keep in a chat. */
export async function toJpeg(bytes: Uint8Array, max = 1280): Promise<string> {
  const img = await loadImage(Buffer.from(bytes));
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return `data:image/jpeg;base64,${(await canvas.encode("jpeg", 82)).toString("base64")}`;
}

export interface Marked {
  image: string;
  ms: number;
  tokens_in: number | null;
  tokens_out: number | null;
}

export async function markPhoto(
  env: Env,
  photo: { mime: string; base64: string },
  instruction: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Marked> {
  const image = env.image;
  if (!image) throw new Error("Photo markup isn't set up here.");
  const started = Date.now();
  const res = await fetchImpl(`${image.baseUrl}/images/edits`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${image.apiKey}` },
    body: JSON.stringify({
      model: image.model,
      prompt: markPrompt(instruction),
      images: [{ image_url: `data:${photo.mime};base64,${photo.base64}` }],
    }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`The image model answered ${res.status}.`);
  const body = (await res.json()) as {
    data?: { b64_json?: string; url?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const first = body.data?.[0];
  let bytes: Uint8Array | null = null;
  if (first?.b64_json) bytes = Buffer.from(first.b64_json, "base64");
  else if (first?.url) bytes = new Uint8Array(await (await fetchImpl(first.url)).arrayBuffer());
  if (!bytes) throw new Error("The image model sent back no picture.");
  return {
    image: await toJpeg(bytes),
    ms: Date.now() - started,
    tokens_in: body.usage?.input_tokens ?? null,
    tokens_out: body.usage?.output_tokens ?? null,
  };
}
