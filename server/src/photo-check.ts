import type { Env } from "./env.js";

// A quick look at a label photo before Muse reads it. Jev answers two yes/no
// questions about the image in one call (well under a second, a hundredth of
// a cent): is there a label, and is its text sharp enough to read. Only a
// confident "no" stops the photo, and the person can always read it anyway.
// Anything else, including Jev being unset or down, goes on to Muse.

/** Below this, the answer counts as a confident no. */
export const RETAKE_BELOW = 0.12;

// Jev's image endpoint now and then answers HTTP 503 "Image processing is
// unavailable." in about 12 ms, and the same call works a moment later (seen
// in the jev-live runs). So a 503 gets one more try after a short wait, inside
// the call's own time cap, and only when at least a second of that cap is
// left. Any other failure, or a second 503, fails open as before.

/** The wait before the one retry of a 503. */
export const RETRY_WAIT_MS = 300;
/** The retry needs at least this much of the call's time cap left after the wait. */
const RETRY_MIN_MS = 1_000;

/** One Jev call with an image, capped at `ms` in all, with the one retry of a 503. */
export async function askJev(
  router: NonNullable<Env["router"]>,
  body: object,
  ms: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const deadline = Date.now() + ms;
  const call = (cap: number) =>
    fetchImpl(`${router.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${router.apiKey}`,
        "TypeSafe-Danger-Zone-Images": "true",
      },
      body: JSON.stringify({ model: router.model, ...body }),
      signal: AbortSignal.timeout(cap),
    });
  const res = await call(ms);
  if (res.status !== 503) return res;
  const left = deadline - Date.now() - RETRY_WAIT_MS;
  if (left < RETRY_MIN_MS) return res;
  await res.body?.cancel().catch(() => {});
  await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
  return call(left);
}

export type Retake = "no_label" | "blurry";

export interface PhotoCheck {
  retake: Retake | null;
  label: number;
  sharp: number;
  tokens_in: number | null;
  ms: number;
}

/** What each kind of photo should show. A receipt's "no_label" means no receipt or card. */
const SHOWS = {
  label:
    "Does `photo` show a product label, rating plate or sticker with printed text such as a brand, model or serial number?",
  receipt:
    "Does `photo` show a store receipt, invoice or product warranty card with printed text such as a store name, date or price?",
};

export async function checkPhoto(
  env: Env,
  image: { mime: string; base64: string },
  fetchImpl: typeof fetch = fetch,
  what: keyof typeof SHOWS = "label",
): Promise<PhotoCheck | null> {
  const router = env.router;
  // Jev takes JPEG and PNG; WebP goes straight to Muse.
  const format = { "image/jpeg": "jpg", "image/png": "png" }[image.mime];
  if (!router || !format) return null;
  const started = Date.now();
  try {
    const res = await askJev(
      router,
      {
        state: { photo: `${what}-photo` },
        assets: { [`${what}-photo`]: { type: "image", format, data_base64: image.base64 } },
        questions: {
          label: { type: "noul", instructions: SHOWS[what] },
          sharp: {
            type: "noul",
            instructions:
              "Is the printed text in `photo` sharp, in focus and lit well enough to read?",
          },
        },
      },
      5_000,
      fetchImpl,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      answers?: { label?: { noul?: number }; sharp?: { noul?: number } };
      usage?: { input_tokens?: number };
    };
    const label = body.answers?.label?.noul;
    const sharp = body.answers?.sharp?.noul;
    if (typeof label !== "number" || typeof sharp !== "number") return null;
    return {
      retake: label < RETAKE_BELOW ? "no_label" : sharp < RETAKE_BELOW ? "blurry" : null,
      label,
      sharp,
      tokens_in: body.usage?.input_tokens ?? null,
      ms: Date.now() - started,
    };
  } catch {
    return null;
  }
}

// A photographed page of a paper manual, checked as the person snaps it: is
// it a manual page, is it sharp, and is it in English. The page grid marks a
// blurry page for a retake and a page in another language as skipped, so
// Muse is only sent pages it can use. Fails open: no answer marks nothing.

export interface PageCheck {
  /** "blurry" or "not_a_page": worth a retake. */
  retake: Retake | "not_a_page" | null;
  /** False only when Jev is sure the page isn't in English. */
  english: boolean;
  tokens_in: number | null;
}

export async function checkPage(
  env: Env,
  image: { mime: string; base64: string },
  fetchImpl: typeof fetch = fetch,
): Promise<PageCheck | null> {
  const router = env.router;
  const format = { "image/jpeg": "jpg", "image/png": "png" }[image.mime];
  if (!router || !format) return null;
  try {
    const res = await askJev(
      router,
      {
        state: { photo: "page-photo" },
        assets: { "page-photo": { type: "image", format, data_base64: image.base64 } },
        questions: {
          page: {
            type: "noul",
            instructions:
              "Does `photo` show a printed page of a manual or instruction booklet, with paragraphs, steps, a table or diagrams?",
          },
          sharp: {
            type: "noul",
            instructions:
              "Is the printed text in `photo` sharp, in focus and lit well enough to read?",
          },
          english: {
            type: "noul",
            instructions: "Is most of the text on the page in `photo` written in English?",
          },
        },
      },
      5_000,
      fetchImpl,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      answers?: Record<string, { noul?: number }>;
      usage?: { input_tokens?: number };
    };
    const p = (k: string) => body.answers?.[k]?.noul;
    const page = p("page");
    const sharp = p("sharp");
    const english = p("english");
    return {
      retake:
        typeof page === "number" && page < RETAKE_BELOW
          ? "not_a_page"
          : typeof sharp === "number" && sharp < RETAKE_BELOW
            ? "blurry"
            : null,
      english: !(typeof english === "number" && english < RETAKE_BELOW),
      tokens_in: body.usage?.input_tokens ?? null,
    };
  } catch {
    return null;
  }
}

// A photo in the chat. When the question is a simple yes/no about how
// something looks (is the filter clogged, is this light on), Jev answers it
// from the image and Muse gets Jev's finding as text instead of the picture,
// which costs a fraction of a Muse image read. Reading a display, small print
// or an error code, naming a part, or any doubt sends the photo to Muse.

/** Jev must be this sure the question is a simple look, and this sure of its answer. */
export const SIMPLE_AT = 0.8;
export const SURE_AT = 0.85;

export interface PhotoLook {
  /** Jev's finding for Muse, or null when Muse should see the photo itself. */
  finding: string | null;
  simple: number;
  yes: number;
  tokens_in: number | null;
  ms: number;
}

export async function lookAtPhoto(
  env: Env,
  image: { mime: string; base64: string },
  question: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PhotoLook | null> {
  const router = env.router;
  const format = { "image/jpeg": "jpg", "image/png": "png" }[image.mime];
  if (!router || !format || !question.trim()) return null;
  const started = Date.now();
  try {
    const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${router.apiKey}`,
        "TypeSafe-Danger-Zone-Images": "true",
      },
      body: JSON.stringify({
        model: router.model,
        state: { photo: "chat-photo", question: question.slice(0, 500) },
        assets: { "chat-photo": { type: "image", format, data_base64: image.base64 } },
        questions: {
          simple: {
            type: "noul",
            instructions:
              "Is `question` a simple yes or no question about how something in `photo` looks, such as whether it is dirty, clogged, frosted, worn, leaking or damaged, or whether a light is on? Answer no if it asks to read text, a number, a display or an error code, to name or identify a part, or for anything else.",
          },
          yes: {
            type: "noul",
            instructions: "Looking at `photo`, is the answer to `question` yes?",
          },
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      answers?: { simple?: { noul?: number }; yes?: { noul?: number } };
      usage?: { input_tokens?: number };
    };
    const simple = body.answers?.simple?.noul;
    const yes = body.answers?.yes?.noul;
    if (typeof simple !== "number" || typeof yes !== "number") return null;
    const sure = Math.max(yes, 1 - yes);
    const finding =
      simple >= SIMPLE_AT && sure >= SURE_AT
        ? `[photo, checked by Jev: asked "${question.trim().slice(0, 200)}", the answer is ${yes >= 0.5 ? "yes" : "no"} (confidence ${sure.toFixed(2)})]`
        : null;
    return {
      finding,
      simple,
      yes,
      tokens_in: body.usage?.input_tokens ?? null,
      ms: Date.now() - started,
    };
  } catch {
    return null;
  }
}

// A second look at what Muse read off a label or receipt photo, after the
// pattern in TypeSafe's "OCR confidence and bounding boxes" cookbook
// (https://docs.typesafe.ai/cookbooks/ocr_confidence_bounding_boxes): Jev
// answers one yes/no per value, "is this what the photo shows?", in a single
// call with the photo sent once. A confident no marks the value doubtful, so
// the person checks it (a misread model number finds the wrong manual, a
// misread date moves the warranty). Nothing is changed or thrown away, and
// Jev being unset or down leaves the read as it was.

/** Below this, a value counts as doubtful: the cookbook's review bar. */
export const DOUBT_BELOW = 0.25;

/** One question per value Muse can read, keyed by the field it read it into. */
const READ_QUESTIONS = {
  label: {
    brand: (v: string) => `Is "${v}" the brand name shown in \`photo\`?`,
    model: (v: string) =>
      `Is "${v}" the model number printed in \`photo\`, character for character? Answer no if any letter or digit differs, such as S read as 5, O as 0, I as 1 or B as 8.`,
    serial: (v: string) =>
      `Is "${v}" the serial number printed in \`photo\`, character for character? Answer no if any letter or digit differs.`,
  },
  receipt: {
    store: (v: string) => `Is the store or seller in \`photo\` "${v}"?`,
    purchased_on: (v: string) =>
      `Is ${v} (year-month-day) the purchase date printed in \`photo\`? It may be written in another date format; answer no if the day, month or year differs.`,
    price: (v: string) => `Does \`photo\` show ${v} as the price paid for the product?`,
    warranty_months: (v: string) =>
      `Does \`photo\` state a warranty of ${v} months, or the same length in years?`,
  },
} satisfies Record<keyof typeof SHOWS, Record<string, (v: string) => string>>;

export interface ReadCheck {
  /** Fields whose value Jev confidently says the photo doesn't show. */
  doubtful: string[];
  /** Jev's P(yes) per field it was asked about. */
  scores: Record<string, number>;
  /** Where each doubtful value sits on the photo, when Jev found it clearly. */
  boxes?: Record<string, Box>;
  /** Jev's raw answers for the boxes, kept in the log to tune the bars. */
  located?: Located["found"];
  tokens_in: number | null;
  ms: number;
}

/**
 * Asks Jev what Muse read, then, for any value it doubts, where that value is
 * on the photo. `boxUntil` is a clock time (ms) the box call must finish by,
 * so it never pushes the handler past its function budget.
 */
export async function checkRead(
  env: Env,
  image: { mime: string; base64: string },
  read: Record<string, unknown>,
  what: keyof typeof SHOWS = "label",
  fetchImpl: typeof fetch = fetch,
  boxUntil = Number.POSITIVE_INFINITY,
): Promise<ReadCheck | null> {
  const router = env.router;
  const format = { "image/jpeg": "jpg", "image/png": "png" }[image.mime];
  if (!router || !format) return null;
  const builders: Record<string, (v: string) => string> = READ_QUESTIONS[what];
  const questions: Record<string, { type: "noul"; instructions: string }> = {};
  for (const [field, ask] of Object.entries(builders)) {
    const value = read[field];
    if ((typeof value === "string" && value.trim()) || typeof value === "number") {
      questions[field] = { type: "noul", instructions: ask(String(value).trim().slice(0, 120)) };
    }
  }
  if (!Object.keys(questions).length) return null;
  const started = Date.now();
  try {
    const res = await askJev(
      router,
      {
        state: { photo: `${what}-read` },
        assets: { [`${what}-read`]: { type: "image", format, data_base64: image.base64 } },
        questions,
      },
      5_000,
      fetchImpl,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      answers?: Record<string, { noul?: number }>;
      usage?: { input_tokens?: number };
    };
    const scores: Record<string, number> = {};
    for (const field of Object.keys(questions)) {
      const p = body.answers?.[field]?.noul;
      if (typeof p === "number") scores[field] = p;
    }
    if (!Object.keys(scores).length) return null;
    const doubtful = Object.keys(scores).filter((f) => (scores[f] ?? 1) < DOUBT_BELOW);
    const where = doubtful.length
      ? await locateDoubts(env, image, read, doubtful, what, fetchImpl, boxUntil)
      : null;
    return {
      doubtful,
      scores,
      ...(where && Object.keys(where.boxes).length ? { boxes: where.boxes } : {}),
      ...(where ? { located: where.found } : {}),
      tokens_in: body.usage?.input_tokens ?? null,
      ms: Date.now() - started,
    };
  } catch {
    return null;
  }
}

// Where a doubtful value is on the photo, so the person sees that strip of the
// sticker or receipt right next to what Muse read (S and 5, O and 0 are much
// easier to catch side by side). Jev's Box primitive answers with the value's
// edges as 0 to 1 fractions of the photo, plus a confidence. Box always draws
// a box, even for something that isn't there, so each one is paired with a
// yes/no "is it on the photo at all" in the same call, and a box is only kept
// when both are sure enough. Asked only for doubtful values, in one extra call
// with a tight timeout; Jev being slow, down or unsure just means no crop.
// Box and images are "dreamer-ready" at TypeSafe (https://docs.typesafe.ai/primitives/box).

/** Edges as fractions of the photo, measured from its top-left corner. */
export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The "is it there" answer must be at least this sure to use the box. */
export const PRESENT_AT = 0.6;
/**
 * And Box's own confidence at least this. TypeSafe has no recommended bar yet;
 * on the live fixtures, boxes that sat right on the value scored 0.4 to 0.69.
 */
export const BOX_AT = 0.4;
/** A box covering more of the photo than this shows nothing a crop would add. */
const MOST_OF_PHOTO = 0.8;
/** The box call's own cap; it runs after Muse, so it is kept short. */
export const BOX_MS = 3_000;

/** What each value is, in words Box can look for. */
const WHERE = {
  label: { brand: "the brand name", model: "the model number", serial: "the serial number" },
  receipt: {
    store: "the store or seller name",
    purchased_on: "the purchase date",
    price: "the price paid for the product",
    warranty_months: "the warranty length",
  },
} satisfies Record<keyof typeof SHOWS, Record<string, string>>;

interface Located {
  boxes: Record<string, Box>;
  found: Record<string, { present: number; confidence: number; box: Box }>;
}

function usable(b: unknown): b is Box {
  if (!b || typeof b !== "object") return false;
  const { top, bottom, left, right } = b as Record<string, unknown>;
  const edges = [top, bottom, left, right];
  if (!edges.every((e) => typeof e === "number" && e >= 0 && e <= 1)) return false;
  const box = b as Box;
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  return w > 0 && h > 0 && w * h <= MOST_OF_PHOTO;
}

export async function locateDoubts(
  env: Env,
  image: { mime: string; base64: string },
  read: Record<string, unknown>,
  fields: string[],
  what: keyof typeof SHOWS = "label",
  fetchImpl: typeof fetch = fetch,
  until = Number.POSITIVE_INFINITY,
): Promise<Located | null> {
  const router = env.router;
  const format = { "image/jpeg": "jpg", "image/png": "png" }[image.mime];
  const ms = Math.min(BOX_MS, until - Date.now());
  if (!router || !format || ms < 1_000) return null;
  const names: Record<string, string> = WHERE[what];
  const questions: Record<string, { type: "box" | "noul"; instructions: string }> = {};
  for (const field of fields) {
    const name = names[field];
    const value = read[field];
    if (!name || (typeof value !== "string" && typeof value !== "number")) continue;
    const shown = String(value).trim().slice(0, 120);
    questions[`box_${field}`] = {
      type: "box",
      instructions: `${name} printed in \`photo\`, which may read like "${shown}"`,
    };
    questions[`present_${field}`] = {
      type: "noul",
      instructions: `Does \`photo\` clearly show ${name}?`,
    };
  }
  if (!Object.keys(questions).length) return null;
  try {
    const res = await askJev(
      router,
      {
        state: { photo: `${what}-where` },
        assets: { [`${what}-where`]: { type: "image", format, data_base64: image.base64 } },
        questions,
      },
      ms,
      fetchImpl,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      answers?: Record<string, { noul?: number; box?: unknown; confidence?: number }>;
    };
    const out: Located = { boxes: {}, found: {} };
    for (const field of fields) {
      const box = body.answers?.[`box_${field}`];
      const present = body.answers?.[`present_${field}`]?.noul;
      if (!usable(box?.box) || typeof box.confidence !== "number" || typeof present !== "number")
        continue;
      out.found[field] = { present, confidence: box.confidence, box: box.box };
      if (present >= PRESENT_AT && box.confidence >= BOX_AT) out.boxes[field] = box.box;
    }
    return out;
  } catch {
    return null;
  }
}
