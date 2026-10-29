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
});

export type Label = z.infer<typeof labelSchema>;

const INSTRUCTIONS = `You read product labels and rating plates in photos for a household app.
Return JSON: "found" (true if a label with a brand or model number is visible), "brand", "model" (exactly as printed), "serial", "category" (snake_case type: washer, dishwasher, dryer, refrigerator, car_seat, stroller, crib...), "kind" (appliance|baby_gear|vehicle|other), "nickname" (what a family would call it, e.g. "Washer"), "unsure" (true if any part was hard to read).
Use null for anything not visible. Never guess a model number. Return only JSON.`;

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
