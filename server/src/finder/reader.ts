import type { Env } from "../env.js";
import { type Knowledge, knowledgeSchema } from "./knowledge.js";
import type { PageText } from "./pdf-text.js";

// The server-side reader (D6): Muse Spark, or any OpenAI-compatible chat
// completions API, set with READER_BASE_URL, READER_MODEL and READER_API_KEY.
// When unset, manuals are still saved and searchable, just not distilled.
// Bring-your-own-key later means choosing these per household.

const BUDGET_CHARS = 120_000;
const KEYWORDS =
  /clean|maint|filter|descal|every|month|week|daily|replace|inspect|error|code|warning|weight|height|\blb\b|\bkg\b|rear.?facing|forward.?facing|booster|harness|expir/gi;

export const DISTILL_INSTRUCTIONS = `You read product manuals for a household upkeep app.
Return JSON with three arrays:
- "tasks": recurring or one-time upkeep the owner should do. Each has "title" (short imperative), "details" (one or two sentences, in the manual's terms), "interval_unit" (days|weeks|months|cycles|once|as_needed), "interval_value" (integer; omit for once/as_needed), "source_page" (the page number shown before the text).
  Use "cycles" for "every N washes/uses/loads". Only include intervals the manual states; do not invent any.
- "facts": things owners look up later. Each has "kind" (error_code|part|spec|safety|other), "label", "value", "source_page". One fact per error code (label is the code as displayed, e.g. "E4"), per replaceable part, per spec (capacity, detergent type, voltage), per safety warning.
- "seat_modes": only for car seats: one entry per mode (rear_facing, forward_facing, booster_high_back, booster_backless) with min/max weight and height exactly as printed, "weight_unit" (lb|kg), "height_unit" (in|cm), "min_age_months" if stated, "fit_note" for non-numeric limits, "source_page".
Any task, fact or seat mode may add "unsure": true when the manual is ambiguous, the text is garbled, or you had to interpret. Flag rather than guess; a person will check it.
Return only JSON. Leave an array empty when the manual has nothing for it.`;

/** Picks the pages most likely to hold upkeep and limits, within a size budget. */
export function selectPages(pages: PageText[], budget = BUDGET_CHARS): PageText[] {
  const total = pages.reduce((n, p) => n + p.content.length, 0);
  if (total <= budget) return pages;
  const ranked = [...pages].sort(
    (a, b) => (b.content.match(KEYWORDS)?.length ?? 0) - (a.content.match(KEYWORDS)?.length ?? 0),
  );
  const chosen: PageText[] = [];
  let used = 0;
  for (const p of ranked) {
    if (used + p.content.length > budget) continue;
    chosen.push(p);
    used += p.content.length;
  }
  return chosen.sort((a, b) => a.page_number - b.page_number);
}

export function formatPages(pages: PageText[]): string {
  return pages.map((p) => `--- page ${p.page_number} ---\n${p.content}`).join("\n\n");
}

export async function distill(
  env: Env,
  args: { itemLabel: string; pages: PageText[] },
  fetchImpl: typeof fetch = fetch,
): Promise<Knowledge> {
  const reader = env.reader;
  if (!reader) throw new Error("No server reader is configured.");
  const res = await fetchImpl(`${reader.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(reader.apiKey ? { authorization: `Bearer ${reader.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: reader.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: DISTILL_INSTRUCTIONS },
        {
          role: "user",
          content: `Manual for: ${args.itemLabel}\n\n${formatPages(selectPages(args.pages))}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(50_000),
  });
  if (!res.ok) throw new Error(`Reader answered ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? "";
  const json = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
  return knowledgeSchema.parse(JSON.parse(json));
}
