import type { Env } from "../env.js";
import type { Knowledge } from "./knowledge.js";
import type { PageText } from "./pdf-text.js";

// A second look at what the reader saved: for each page, Jev answers one
// yes/no question per entry ("does this page support it?"), and every number
// in an entry must appear on its page. Either miss flags the entry for a
// person to check; nothing is changed or thrown away. Car seat limits fail
// closed: if Jev can't be reached, they're flagged too.

/** Jev's "supported" probability below this flags the entry. Supported claims score modestly, made-up ones near 0. */
export const SUPPORT_THRESHOLD = 0.2;
const PAGE_CHARS = 12_000;
const PARALLEL = 6;

const WORD_NUMBERS: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  fifteen: "15",
  twenty: "20",
  thirty: "30",
  fifty: "50",
  hundred: "100",
};

/** Every number a page shows, digits or a small number word, without thousands commas. */
export function numbersOn(text: string): Set<string> {
  const found = new Set<string>();
  for (const n of text.replace(/(\d),(\d{3})/g, "$1$2").match(/\d+(?:\.\d+)?/g) ?? []) {
    found.add(String(Number(n)));
  }
  for (const w of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    if (WORD_NUMBERS[w]) found.add(WORD_NUMBERS[w]);
  }
  return found;
}

interface Claim {
  list: "tasks" | "facts" | "seat_modes";
  index: number;
  page: number;
  text: string;
  numbers: number[];
}

function claims(k: Knowledge): Claim[] {
  const out: Claim[] = [];
  k.tasks.forEach((t, index) => {
    if (!t.source_page || t.unsure) return;
    const every =
      t.interval_value && !["once", "as_needed"].includes(t.interval_unit)
        ? ` every ${t.interval_value} ${t.interval_unit}`
        : "";
    out.push({
      list: "tasks",
      index,
      page: t.source_page,
      text: `${t.title}${every}. ${t.details ?? ""}`.trim(),
      // "every 1 month" is usually printed as "monthly", so 1 isn't checked.
      numbers: t.interval_value && t.interval_value > 1 ? [t.interval_value] : [],
    });
  });
  k.facts.forEach((f, index) => {
    if (!f.source_page || f.unsure) return;
    out.push({
      list: "facts",
      index,
      page: f.source_page,
      text: `${f.label}: ${f.value}`,
      numbers: [],
    });
  });
  k.seat_modes.forEach((s, index) => {
    if (!s.source_page || s.unsure) return;
    // Only the bounds the reader gave: a missing minimum isn't zero.
    const range = (min: number | undefined, max: number | undefined, unit: string) =>
      min != null && max != null
        ? `${min} to ${max} ${unit}`
        : max != null
          ? `up to ${max} ${unit}`
          : min != null
            ? `from ${min} ${unit}`
            : "";
    const limits = [
      range(s.min_weight, s.max_weight, s.weight_unit),
      range(s.min_height, s.max_height, s.height_unit),
    ].filter(Boolean);
    out.push({
      list: "seat_modes",
      index,
      page: s.source_page,
      text: `${s.mode.replace(/_/g, " ")} use: ${limits.join(", ")}${s.fit_note ? `. ${s.fit_note}` : ""}`,
      numbers: [s.min_weight, s.max_weight, s.min_height, s.max_height].filter(
        (n): n is number => typeof n === "number" && n > 0,
      ),
    });
  });
  return out;
}

export interface Verified {
  knowledge: Knowledge;
  checked: number;
  /** Entries newly flagged for review, and why. */
  flagged: { list: Claim["list"]; index: number; why: "numbers" | "unsupported" | "unchecked" }[];
  tokens_in: number;
  ms: number;
}

export async function verifyKnowledge(
  env: Env,
  knowledge: Knowledge,
  pages: PageText[],
  fetchImpl: typeof fetch = fetch,
): Promise<Verified> {
  const started = Date.now();
  const byPage = new Map(pages.map((p) => [p.page_number, p.content]));
  const all = claims(knowledge).filter((c) => byPage.has(c.page));
  const flagged: Verified["flagged"] = [];
  const flag = (c: Claim, why: Verified["flagged"][number]["why"]) => {
    if (flagged.some((f) => f.list === c.list && f.index === c.index)) return;
    flagged.push({ list: c.list, index: c.index, why });
  };

  // Numbers first: free, and the check that matters most for car seat limits.
  for (const c of all) {
    const seen = numbersOn(byPage.get(c.page) ?? "");
    if (c.numbers.some((n) => !seen.has(String(n)))) flag(c, "numbers");
  }

  let tokens = 0;
  const router = env.router;
  const byPageClaims = new Map<number, Claim[]>();
  for (const c of all) byPageClaims.set(c.page, [...(byPageClaims.get(c.page) ?? []), c]);
  const groups = [...byPageClaims];
  const ask = async ([page, group]: [number, Claim[]]) => {
    if (!router) return;
    try {
      const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${router.apiKey}` },
        body: JSON.stringify({
          model: router.model,
          state: { manual_page: page, text: (byPage.get(page) ?? "").slice(0, PAGE_CHARS) },
          questions: Object.fromEntries(
            group.map((c, i) => [
              `c${i}`,
              {
                type: "noul",
                instructions: `Does this manual page support this statement? ${c.text}`,
                criteria: {
                  true: "The page states it, or says the same thing in other words.",
                  false:
                    "The page doesn't say it, or says something different (another number, unit or interval).",
                },
              },
            ]),
          ),
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as {
        answers?: Record<string, { noul?: number }>;
        usage?: { input_tokens?: number };
      };
      tokens += body.usage?.input_tokens ?? 0;
      group.forEach((c, i) => {
        const p = body.answers?.[`c${i}`]?.noul;
        if (typeof p === "number" && p < SUPPORT_THRESHOLD) flag(c, "unsupported");
      });
    } catch {
      for (const c of group) if (c.list === "seat_modes") flag(c, "unchecked");
    }
  };
  for (let i = 0; i < groups.length; i += PARALLEL) {
    await Promise.all(groups.slice(i, i + PARALLEL).map(ask));
  }

  const next: Knowledge = {
    tasks: knowledge.tasks.map((t) => ({ ...t })),
    facts: knowledge.facts.map((f) => ({ ...f })),
    seat_modes: knowledge.seat_modes.map((s) => ({ ...s })),
  };
  for (const f of flagged) {
    const entry = next[f.list][f.index];
    if (entry) entry.unsure = true;
  }
  return {
    knowledge: next,
    checked: all.length,
    flagged,
    tokens_in: tokens,
    ms: Date.now() - started,
  };
}
