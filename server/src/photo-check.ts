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

export async function checkPhoto(
  env: Env,
  image: { mime: string; base64: string },
  fetchImpl: typeof fetch = fetch,
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
        state: { photo: "label-photo" },
        assets: { "label-photo": { type: "image", format, data_base64: image.base64 } },
        questions: {
          label: {
            type: "noul",
            instructions:
              "Does `photo` show a product label, rating plate or sticker with printed text such as a brand, model or serial number?",
          },
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
