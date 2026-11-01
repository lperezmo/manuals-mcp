import type { Env } from "../env.js";
import { PAGE_CHARS } from "./verify.js";

// The exact line: after the full-text search, Jev reads the top pages as
// numbered lines and answers two things in one call (TypeSafe's semantic
// find): which line answers the question (a Choice over line ids), and whether
// any line answers it at all (an "exists" Noul). A sure pick comes back as a
// quote with its page; a low "exists" means the manual doesn't seem to cover
// it; anything in between leaves the pages as they were. Jev unset, down or
// slow returns null, and the caller goes on as if this weren't here.
//
// Size: at most MAX_LINES lines of LINE_CHARS, about 19k tokens at worst,
// under Jev's 32k per question and 64k per request.

/** Jev's Choice takes at most 255 options. */
export const MAX_LINES = 255;
/** Longer lines are cut at sentences, then between words. */
export const LINE_CHARS = 300;
/** A line this short (a heading, a code alone) joins the next one. */
const SHORT_LINE = 30;
/** Pages read, best search hit first. */
export const LINE_PAGES = 3;
/** The semantic-find cookbook's bars: answered at 0.7, absent below 0.35. */
export const LINE_FOUND = 0.7;
export const EXISTS_FOUND = 0.7;
export const EXISTS_ABSENT = 0.35;

export interface SearchedPage {
  item: string;
  page: number;
  text: string;
}

export interface ManualLine {
  item: string;
  page: number;
  /** Its place among the page's lines, from 1. */
  line: number;
  text: string;
}

export interface LineFinding {
  /** found: `line` answers it. absent: no line does. unsure: in between. */
  verdict: "found" | "absent" | "unsure";
  line: ManualLine | null;
  /** Jev's probability for the line it picked, and that any line answers. */
  confidence: number;
  exists: number;
  /** Lines sent. */
  lines: number;
}

const STOP = new Set(
  "the a an and or of to in on for is are be it this that with your you my our do does how what when which can i".split(
    " ",
  ),
);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Joins a short piece onto the one before it, while the two fit on a line. */
function joinShort(pieces: string[], joins: (prev: string, next: string) => boolean): string[] {
  const out: string[] = [];
  for (const piece of pieces) {
    const prev = out[out.length - 1];
    if (prev !== undefined && joins(prev, piece) && prev.length + 1 + piece.length <= LINE_CHARS) {
      out[out.length - 1] = `${prev} ${piece}`;
    } else {
      out.push(piece);
    }
  }
  return out;
}

function byWords(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current && current.length + 1 + word.length > LINE_CHARS) {
      out.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) out.push(current);
  return out.map((piece) => piece.slice(0, LINE_CHARS));
}

/** A line too long for one option, cut at sentences (a vision-read page may have no line breaks). */
function cut(line: string): string[] {
  if (line.length <= LINE_CHARS) return [line];
  const sentences = line
    .split(/(?<=[.!?;])\s+/)
    .flatMap((s) => (s.length <= LINE_CHARS ? [s] : byWords(s)));
  return joinShort(sentences, (prev) => prev.length < SHORT_LINE);
}

/**
 * A page as lines worth choosing between: one per printed line, with a short
 * line or a wrapped one ("...the drain\nhose") joined to its neighbor, and a
 * long one cut at sentences.
 */
export function splitLines(text: string): string[] {
  const raw = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l));
  const joined = joinShort(raw, (prev, next) => prev.length < SHORT_LINE || /^\p{Ll}/u.test(next));
  return joined.flatMap(cut);
}

/** The top pages' lines, at most MAX_LINES: past that, the ones sharing the fewest words with the question are dropped. */
export function manualLines(pages: SearchedPage[], question: string): ManualLine[] {
  const all = pages.slice(0, LINE_PAGES).flatMap((p) =>
    splitLines(p.text.slice(0, PAGE_CHARS)).map((text, i) => ({
      item: p.item,
      page: p.page,
      line: i + 1,
      text,
    })),
  );
  if (all.length <= MAX_LINES) return all;
  const asked = new Set(words(question));
  return all
    .map((l, i) => ({
      l,
      i,
      score: [...new Set(words(l.text))].filter((w) => asked.has(w)).length,
    }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, MAX_LINES)
    .sort((a, b) => a.i - b.i)
    .map((s) => s.l);
}

interface JevAnswers {
  answers?: Record<
    string,
    { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }
  >;
}

/** One Jev call: which line answers `question`, and whether any does. Null when Jev can't say. */
export async function findLine(
  env: Env,
  question: string,
  pages: SearchedPage[],
  fetchImpl: typeof fetch = fetch,
): Promise<LineFinding | null> {
  const router = env.router;
  const asked = question.trim();
  if (!router || !asked) return null;
  const lines = manualLines(pages, asked);
  if (!lines.length) return null;
  const ids = lines.map((_, i) => `L${String(i + 1).padStart(3, "0")}`);
  try {
    const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${router.apiKey}` },
      body: JSON.stringify({
        model: router.model,
        state: {
          question: asked.slice(0, 2_000),
          manual: lines.map((l, i) => `${ids[i]}| ${l.item}, p. ${l.page}: ${l.text}`).join("\n"),
        },
        questions: {
          line: {
            type: "choice",
            instructions: "Which line of `manual` answers `question`?",
            criteria: Object.fromEntries(ids.map((id) => [id, null])),
          },
          exists: {
            type: "noul",
            instructions: "Does one of the lines of `manual` answer `question`?",
            criteria: {
              true: "A line states the answer, or says the same thing in other words.",
              false: "No line answers it; they only share words or a related topic.",
            },
          },
        },
      }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return null;
    const a = ((await res.json()) as JevAnswers).answers ?? {};
    const exists = a.exists?.noul;
    if (typeof exists !== "number") return null;
    const probs = a.line?.probabilities ?? {};
    let best = -1;
    let confidence = 0;
    ids.forEach((id, i) => {
      const p = probs[id] ?? (a.line?.choice === id ? (a.line?.confidence ?? 0) : 0);
      if (p > confidence) {
        confidence = p;
        best = i;
      }
    });
    const line = lines[best] ?? null;
    // "Absent" only when Jev saw every line of every page: a cut page or a
    // dropped line could hold the answer.
    const sawAll =
      pages.length <= LINE_PAGES &&
      pages.every((p) => p.text.length <= PAGE_CHARS) &&
      lines.length ===
        pages.reduce((n, p) => n + splitLines(p.text.slice(0, PAGE_CHARS)).length, 0);
    const verdict =
      exists < EXISTS_ABSENT
        ? sawAll
          ? "absent"
          : "unsure"
        : line && exists >= EXISTS_FOUND && confidence >= LINE_FOUND
          ? "found"
          : "unsure";
    return {
      verdict,
      line: verdict === "found" ? line : null,
      confidence: Math.round(confidence * 100) / 100,
      exists: Math.round(exists * 100) / 100,
      lines: lines.length,
    };
  } catch {
    return null;
  }
}
