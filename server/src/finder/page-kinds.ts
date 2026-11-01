import type { Env } from "../env.js";
import type { PageText } from "./pdf-text.js";

// Manual atlas: while a manual is read, Jev gives each page a kind (safety,
// setup, use, care, fix, parts, warranty, another language, other), one
// choice question per page, many pages per call. The thing's page then shows
// jump links by kind, and ask_manual can search only the "fix" pages for a
// fault. Without Jev, or when a call fails, pages simply have no kind.

export const PAGE_KINDS = {
  safety: "Safety: warnings, hazards, what never to do, child safety.",
  setup: "Setup: unpacking, installing, connecting, first use.",
  use: "Everyday use: controls, programs, settings, how to run it.",
  care: "Care and upkeep: cleaning, filters, descaling, regular maintenance.",
  fix: "Fixing problems: troubleshooting, error codes, what to do when it won't work.",
  parts: "Parts: a parts list or a labeled diagram of the parts.",
  warranty: "Warranty, service, registration or contact details.",
  language: "Mostly in a language other than English.",
  other: "Anything else: a cover, contents, index, specifications or a blank page.",
} as const;

export type PageKind = keyof typeof PAGE_KINDS;
export const PAGE_KIND_KEYS = Object.keys(PAGE_KINDS) as PageKind[];

/** Short names for jump links and tool replies. */
export const PAGE_KIND_LABELS: Record<PageKind, string> = {
  safety: "Safety",
  setup: "Setup",
  use: "Use",
  care: "Care",
  fix: "Repairs",
  parts: "Parts",
  warranty: "Warranty",
  language: "Other language",
  other: "Other",
};

/** Questions per Jev call; a long manual is split into a few calls sent together. */
const PAGES_PER_CALL = 40;
/** Most pages sorted per manual. */
const MAX_PAGES = 240;
/** Enough of a page for Jev to tell what it is about. */
const CHARS_PER_PAGE = 700;
/** Pages with less text than this (a blank or a picture) are left without a kind. */
const MIN_CHARS = 40;
const TIMEOUT_MS = 10_000;

export interface PageKindResult {
  kinds: Map<number, { kind: PageKind; p: number }>;
  tokens_in: number;
  calls: number;
  failed: number;
}

/** Jev's top pick for one choice answer, or null when it isn't one of the kinds. */
function topPick(answer: unknown): { kind: PageKind; p: number } | null {
  const a = answer as
    | { choice?: string; confidence?: number; probabilities?: Record<string, number> }
    | undefined;
  if (!a) return null;
  let best: [string, number] | null = null;
  if (a.probabilities && typeof a.probabilities === "object") {
    for (const [k, p] of Object.entries(a.probabilities)) {
      if (
        k in PAGE_KINDS &&
        typeof p === "number" &&
        Number.isFinite(p) &&
        (!best || p > best[1])
      ) {
        best = [k, p];
      }
    }
  } else if (a.choice && a.choice in PAGE_KINDS) {
    best = [a.choice, typeof a.confidence === "number" ? a.confidence : 0.5];
  }
  if (!best) return null;
  return {
    kind: best[0] as PageKind,
    p: Math.round(Math.min(1, Math.max(0, best[1])) * 1000) / 1000,
  };
}

/** One kind per page with text. Never throws: a failed call leaves its pages without a kind. */
export async function pageKinds(
  env: Env,
  pages: PageText[],
  fetchImpl: typeof fetch = fetch,
): Promise<PageKindResult> {
  const out: PageKindResult = { kinds: new Map(), tokens_in: 0, calls: 0, failed: 0 };
  const router = env.router;
  if (!router) return out;
  const usable = pages.filter((p) => p.content.trim().length >= MIN_CHARS).slice(0, MAX_PAGES);
  const chunks: PageText[][] = [];
  for (let i = 0; i < usable.length; i += PAGES_PER_CALL) {
    chunks.push(usable.slice(i, i + PAGES_PER_CALL));
  }
  out.calls = chunks.length;
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${router.apiKey}`,
          },
          body: JSON.stringify({
            model: router.model,
            state: {
              manual: "Pages of one product manual, each shortened to its start.",
              pages: Object.fromEntries(
                chunk.map((p) => [
                  `p${p.page_number}`,
                  p.content.replace(/\s+/g, " ").trim().slice(0, CHARS_PER_PAGE),
                ]),
              ),
            },
            questions: Object.fromEntries(
              chunk.map((p) => [
                `p${p.page_number}`,
                {
                  type: "choice",
                  instructions: `What is manual page p${p.page_number} mostly about?`,
                  criteria: PAGE_KINDS,
                },
              ]),
            ),
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          out.failed++;
          return;
        }
        const body = (await res.json()) as {
          answers?: Record<string, unknown>;
          usage?: { input_tokens?: number };
        };
        out.tokens_in += body.usage?.input_tokens ?? 0;
        for (const p of chunk) {
          const pick = topPick(body.answers?.[`p${p.page_number}`]);
          if (pick) out.kinds.set(p.page_number, pick);
        }
      } catch {
        out.failed++;
      }
    }),
  );
  return out;
}

/** Jump links for one manual: each kind with its pages, in manual order ("Repairs: p. 31, 32"). */
export function pageStrip(
  rows: { page_number: number; kind: string | null }[],
  skip: PageKind[] = ["other", "language"],
): { kind: PageKind; label: string; pages: number[] }[] {
  const by = new Map<PageKind, number[]>();
  for (const r of [...rows].sort((a, b) => a.page_number - b.page_number)) {
    if (!r.kind || !(r.kind in PAGE_KINDS)) continue;
    const kind = r.kind as PageKind;
    if (skip.includes(kind)) continue;
    by.set(kind, [...(by.get(kind) ?? []), r.page_number]);
  }
  return PAGE_KIND_KEYS.filter((k) => by.has(k)).map((k) => ({
    kind: k,
    label: PAGE_KIND_LABELS[k],
    pages: by.get(k) ?? [],
  }));
}
