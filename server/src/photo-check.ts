import type { Env } from "./env.js";

// A quick look at a label photo before Muse reads it. Jev answers two yes/no
// questions about the image in one call (well under a second, a hundredth of
// a cent): is there a label, and is its text sharp enough to read. Only a
// confident "no" stops the photo, and the person can always read it anyway.
// Anything else, including Jev being unset or down, goes on to Muse.

/** Below this, the answer counts as a confident no. */
export const RETAKE_BELOW = 0.12;

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
    const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${router.apiKey}`,
        "TypeSafe-Danger-Zone-Images": "true",
      },
      body: JSON.stringify({
        model: router.model,
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
      }),
      signal: AbortSignal.timeout(5_000),
    });
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
  tokens_in: number | null;
  ms: number;
}

export async function checkRead(
  env: Env,
  image: { mime: string; base64: string },
  read: Record<string, unknown>,
  what: keyof typeof SHOWS = "label",
  fetchImpl: typeof fetch = fetch,
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
    const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${router.apiKey}`,
        "TypeSafe-Danger-Zone-Images": "true",
      },
      body: JSON.stringify({
        model: router.model,
        state: { photo: `${what}-read` },
        assets: { [`${what}-read`]: { type: "image", format, data_base64: image.base64 } },
        questions,
      }),
      signal: AbortSignal.timeout(5_000),
    });
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
    return {
      doubtful: Object.keys(scores).filter((f) => (scores[f] ?? 1) < DOUBT_BELOW),
      scores,
      tokens_in: body.usage?.input_tokens ?? null,
      ms: Date.now() - started,
    };
  } catch {
    return null;
  }
}
