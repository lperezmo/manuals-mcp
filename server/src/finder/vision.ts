import { getDocumentProxy, renderPageAsImage } from "unpdf";
import type { Env } from "../env.js";
import type { PageText } from "./pdf-text.js";

// Some manuals have no text layer: scanned pages, or text exported as drawn
// outlines (Galanz's are). For those, pages are rendered to images, Jev drops
// the ones in other languages, and Muse transcribes the rest. The text is
// saved like any other page text, so search and the normal read work on it.

/** Most pages transcribed per manual; English pages first, in order. */
export const MAX_VISION_PAGES = 40;
/** Most pages rendered to find those, so a 300-page multilingual manual stays quick. */
const MAX_RENDERED = 80;
const PAGE_WIDTH = 1100;
const BATCH = 4;
const PARALLEL = 5;

export interface PageImage {
  page_number: number;
  png_base64: string;
}

/** Pages with no text, as PNGs about 1100 px wide. */
export async function renderPages(bytes: Uint8Array, pageNumbers: number[]): Promise<PageImage[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const out: PageImage[] = [];
  for (const n of pageNumbers.slice(0, MAX_RENDERED)) {
    const png = await renderPageAsImage(pdf, n, {
      canvasImport: () => import("@napi-rs/canvas"),
      width: PAGE_WIDTH,
    });
    out.push({ page_number: n, png_base64: Buffer.from(png).toString("base64") });
  }
  return out;
}

/** Jev's quick look at each page image: is it English? Unsure or down counts as yes. */
export async function englishPages(
  env: Env,
  images: PageImage[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ english: PageImage[]; tokens_in: number }> {
  const router = env.router;
  if (!router) return { english: images, tokens_in: 0 };
  let tokens = 0;
  const verdicts = await Promise.all(
    images.map(async (img) => {
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
            state: { page: "manual-page" },
            assets: {
              "manual-page": { type: "image", format: "png", data_base64: img.png_base64 },
            },
            questions: {
              english: {
                type: "noul",
                instructions: "Is the text on `page` mostly in English?",
              },
            },
          }),
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return true;
        const body = (await res.json()) as {
          answers?: { english?: { noul?: number } };
          usage?: { input_tokens?: number };
        };
        tokens += body.usage?.input_tokens ?? 0;
        const p = body.answers?.english?.noul;
        return typeof p !== "number" || p >= 0.2;
      } catch {
        return true;
      }
    }),
  );
  const english = images.filter((_, i) => verdicts[i]);
  // A manual with almost no English pages is read in its own language.
  return {
    english: english.length >= Math.max(2, images.length * 0.15) ? english : images,
    tokens_in: tokens,
  };
}

const TRANSCRIBE = `You transcribe pages of a product manual for a household upkeep app.
For each page image, write out its text in reading order: headings, numbered steps, warnings, and tables as rows of "cell | cell". Include error codes, part names and numbers exactly as printed. Skip decorative text and page furniture.
Return JSON: {"pages": [{"page": <the page number given before the image>, "text": "..."}]}. Return only JSON.`;

export interface VisionUsage {
  calls: number;
  tokens_in: number;
  tokens_out: number;
  failed: number;
}

/** Muse transcribes the page images, a few per call, several calls at once. */
export async function transcribePages(
  env: Env,
  images: PageImage[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ pages: PageText[]; usage: VisionUsage }> {
  const reader = env.reader;
  if (!reader) throw new Error("No server reader is configured.");
  const usage: VisionUsage = { calls: 0, tokens_in: 0, tokens_out: 0, failed: 0 };
  const batches: PageImage[][] = [];
  for (let i = 0; i < images.length; i += BATCH) batches.push(images.slice(i, i + BATCH));
  const pages: PageText[] = [];

  const one = async (batch: PageImage[]) => {
    usage.calls++;
    try {
      const res = await fetchImpl(`${reader.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(reader.apiKey ? { authorization: `Bearer ${reader.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: env.chatModel ?? reader.model,
          response_format: { type: "json_object" },
          max_tokens: 8_000,
          messages: [
            { role: "system", content: TRANSCRIBE },
            {
              role: "user",
              content: batch.flatMap((img) => [
                { type: "text", text: `Page ${img.page_number}:` },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${img.png_base64}` },
                },
              ]),
            },
          ],
        }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      usage.tokens_in += body.usage?.prompt_tokens ?? 0;
      usage.tokens_out += body.usage?.completion_tokens ?? 0;
      const text = (body.choices?.[0]?.message?.content ?? "").replace(
        /^```(?:json)?\s*|\s*```$/g,
        "",
      );
      const parsed = JSON.parse(text) as { pages?: { page?: unknown; text?: unknown }[] };
      const wanted = new Set(batch.map((b) => b.page_number));
      for (const p of parsed.pages ?? []) {
        const n = Number(p.page);
        if (wanted.has(n) && typeof p.text === "string" && p.text.trim()) {
          pages.push({ page_number: n, content: p.text.trim() });
          wanted.delete(n);
        }
      }
    } catch {
      // One failed batch costs those pages, not the whole manual.
      usage.failed++;
    }
  };

  for (let i = 0; i < batches.length; i += PARALLEL) {
    await Promise.all(batches.slice(i, i + PARALLEL).map(one));
  }
  return { pages: pages.sort((a, b) => a.page_number - b.page_number), usage };
}
