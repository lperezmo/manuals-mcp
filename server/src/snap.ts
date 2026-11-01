import { z } from "zod";
import type { Env } from "./env.js";

// Reads an appliance's rating plate from a photo with the reader model
// (Muse Spark), so adding a thing can start from one picture.

export const MAX_IMAGE_BYTES = 2_000_000;

export const labelSchema = z.object({
  found: z.boolean().default(false),
  brand: z.string().max(80).nullish(),
  model: z.string().max(80).nullish(),
  serial: z.string().max(80).nullish(),
  category: z.string().max(40).nullish(),
  kind: z.enum(["appliance", "baby_gear", "vehicle", "other"]).nullish(),
  nickname: z.string().max(80).nullish(),
  unsure: z.boolean().default(false),
  // Other tagged codes on the sticker ("FCC ID: 2ADQOMDNA23", "MO: R0698201"),
  // so a label with no "Model" line can still offer a likely model number.
  codes: z.array(z.string().max(120)).max(20).nullish().catch(null),
});

export type Label = z.infer<typeof labelSchema>;

const INSTRUCTIONS = `You read product labels and rating plates in photos for a household app.
Return JSON: "found" (true if a label with a brand or model number is visible), "brand", "model" (exactly as printed), "serial", "category" (snake_case type: washer, dishwasher, dryer, refrigerator, car_seat, stroller, crib...), "kind" (appliance|baby_gear|vehicle|other), "nickname" (what a family would call it, e.g. "Washer"), "unsure" (true if any part was hard to read), "codes" (every other code printed with a tag, one string each, exactly as printed, e.g. "FCC ID: 2ADQOMDNA23", "MO: R0698201", "P/N: 12345").
"category", "kind" and "nickname": only when the label names what the thing is or the thing itself shows in the photo. A brand alone doesn't say it (Midea, LG and Samsung make fridges, dishwashers and more), and neither does a Wi-Fi or smart-home sticker; use null then.
Use null for anything not visible. Never guess a model number: a code is "model" only when the label calls it the model. Return only JSON.`;

/** Tags that can mark a model number on a sticker with no "Model" line, most likely first. */
const MODEL_TAGS: [RegExp, number][] = [
  [/^model(?:\s*(?:no\.?|number|#))?$/i, 0],
  [/^m\/n$|^mn$/i, 1],
  [/^mod\.?$|^mdl\.?$/i, 2],
  [/^mo\.?$/i, 3],
  [/^type$/i, 4],
];

/** A tagged code split into its tag and value, e.g. "MO:R0698201" to ["MO", "R0698201"]. */
export function splitCode(code: string): [string, string] | null {
  const m = code.trim().match(/^([A-Za-z][A-Za-z0-9 ./#]{0,15}?)\s*[:#]\s*(\S.*)$/);
  return m?.[1] && m[2] ? [m[1].trim(), m[2].trim()] : null;
}

/**
 * The likeliest model number among a label's other codes, for the person to
 * confirm ("Is the model R0698201?"). Null when none is tagged like one.
 */
export function modelGuess(codes: readonly string[] | null | undefined): string | null {
  let best: { value: string; rank: number } | null = null;
  for (const code of codes ?? []) {
    const parts = splitCode(code);
    if (!parts) continue;
    const [tag, value] = parts;
    const rank = MODEL_TAGS.find(([re]) => re.test(tag))?.[1];
    // A model number is one word of letters and digits with at least one digit.
    if (rank === undefined || !/^[A-Z0-9][A-Z0-9./-]{2,39}$/i.test(value) || !/\d/.test(value)) {
      continue;
    }
    if (!best || rank < best.rank) best = { value, rank };
  }
  return best?.value ?? null;
}

/** True when the codes look like a Wi-Fi or smart-home module's sticker (FCC or IC ID). */
export function radioSticker(codes: readonly string[] | null | undefined): boolean {
  return (codes ?? []).some((c) =>
    /^(?:contains\s+)?(?:fcc(?:\s*id)?|ic)$/i.test(splitCode(c)?.[0] ?? ""),
  );
}

export async function readLabel(
  env: Env,
  image: { mime: string; base64: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Label> {
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
            { type: "text", text: "Read this label." },
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
  return labelSchema.parse(JSON.parse(text));
}
