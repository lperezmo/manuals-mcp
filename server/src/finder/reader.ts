import type { Env } from "../env.js";
import { type Knowledge, LIMITS, readKnowledge } from "./knowledge.js";
import { keepEnglish } from "./language.js";
import type { PageText } from "./pdf-text.js";

// The server-side reader (D6): Muse Spark, or any OpenAI-compatible chat
// completions API, set with READER_BASE_URL, READER_MODEL and READER_API_KEY.
// When unset, manuals are still saved and searchable, just not distilled.
// Bring-your-own-key later means choosing these per household.

const BUDGET_CHARS = 40_000;
const KEYWORDS =
  /clean|maint|filter|descal|every|month|week|daily|replace|inspect|error|code|warning|weight|height|\blb\b|\bkg\b|rear.?facing|forward.?facing|booster|harness|expir/gi;

export const DISTILL_INSTRUCTIONS = `You read product manuals for a household upkeep app.
Return JSON with three arrays:
- "tasks": recurring or one-time upkeep the owner should do. Each has "title" (short imperative), "details" (one or two sentences, in the manual's terms), "interval_unit" (days|weeks|months|cycles|once|as_needed), "interval_value" (integer; omit for once/as_needed), "source_page" (the page number shown before the text).
  Use "cycles" for "every N washes/uses/loads". Only include intervals the manual states; do not invent any.
- "facts": things owners look up later. Each has "kind" (error_code|part|spec|safety|other), "label", "value", "source_page". One fact per error code (label is the code as displayed, e.g. "E4"), per replaceable part, per spec (capacity, detergent type, voltage), per safety rule specific to this product.
  Skip what nobody needs saved: common-sense warnings (supervise children, don't use it if damaged, read the manual), legal and regulatory text (FCC, Prop 65, warranty, disposal law), and plain labels from the product diagram. A part is worth a fact only if the owner may replace it, buy it or care for it. Fewer, useful facts beat many.
- "seat_modes": only for car seats: one entry per mode (rear_facing, forward_facing, booster_high_back, booster_backless) with min/max weight and height exactly as printed, "weight_unit" (lb|kg), "height_unit" (in|cm), "min_age_months" if stated, "fit_note" for non-numeric limits, "source_page".
Any task, fact or seat mode may add "unsure": true when the manual is ambiguous, the text is garbled, or you had to interpret. Flag rather than guess; a person will check it.
Keep text short: "title" at most ${LIMITS.task_title} characters, "details" at most ${LIMITS.task_details}, "label" at most ${LIMITS.fact_label}, "value" at most ${LIMITS.fact_value}, "fit_note" at most ${LIMITS.fit_note} (summarize; the page number points to the rest).
At most ${LIMITS.tasks} tasks, ${LIMITS.facts} facts and ${LIMITS.seat_modes} seat modes; keep the most important.
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

export interface ReaderUsage {
  model: string;
  tokens_in: number | null;
  tokens_out: number | null;
}

/** What was sent and what came back, for the model_runs log. */
export interface ReaderTrace {
  pages_sent: number[];
  chars_sent: number;
  raw_output: string | null;
  usage: ReaderUsage | null;
}

/** A failed read that still knows what was sent and what came back. */
export class ReaderError extends Error {
  constructor(
    message: string,
    readonly trace: ReaderTrace,
  ) {
    super(message);
  }
}

export interface Distilled {
  knowledge: Knowledge;
  usage: ReaderUsage;
  trace: ReaderTrace;
  /** Entries whose text was cut to fit (flagged for review). */
  trimmed: number;
  /** Entries left out because they couldn't fit. */
  dropped: number;
}

export async function distill(
  env: Env,
  args: { itemLabel: string; pages: PageText[] },
  fetchImpl: typeof fetch = fetch,
): Promise<Distilled> {
  const reader = env.reader;
  if (!reader) throw new Error("No server reader is configured.");
  // Other-language copies of the same content are left out before ranking.
  const chosen = selectPages(keepEnglish(args.pages).kept, reader.maxChars);
  const text = formatPages(chosen);
  const trace: ReaderTrace = {
    pages_sent: chosen.map((p) => p.page_number),
    chars_sent: text.length,
    raw_output: null,
    usage: null,
  };
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
          content: `Manual for: ${args.itemLabel}\n\n${text}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(50_000),
  });
  if (!res.ok) {
    trace.raw_output = (await res.text().catch(() => "")).slice(0, 2_000) || null;
    throw new ReaderError(`Reader answered ${res.status}`, trace);
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const answer = body.choices?.[0]?.message?.content ?? "";
  const usage: ReaderUsage = {
    model: reader.model,
    tokens_in: body.usage?.prompt_tokens ?? null,
    tokens_out: body.usage?.completion_tokens ?? null,
  };
  trace.raw_output = answer;
  trace.usage = usage;
  try {
    const json = answer.replace(/^```(?:json)?\s*|\s*```$/g, "");
    return { ...readKnowledge(JSON.parse(json)), usage, trace };
  } catch (err) {
    throw new ReaderError(
      `Reader's answer didn't fit: ${(err as Error).message.slice(0, 300)}`,
      trace,
    );
  }
}
