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
