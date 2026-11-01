import type { PageText } from "./pdf-text.js";

// Many manuals print the same content in several languages. Sending only the
// English pages to the reader cuts what it reads without losing anything.
// This is a stopword count, not a model: free, instant and deterministic.
// Every page stays saved and searchable; this only decides what the reader sees.

const STOPWORDS: Record<string, string[]> = {
  en: "the and of to is in for with this that your not be are on or if it do when from use".split(
    " ",
  ),
  es: "el la los las de del que y en para con por una este esta su no se es al como".split(" "),
  fr: "le la les des de du et pour avec une est dans sur ne pas vous votre ce que au".split(" "),
  de: "der die das und nicht mit ist ein eine sie den dem zu auf für von wenn ihr bei".split(" "),
  it: "il lo gli di che per con una non sono della del nel alla questo come le".split(" "),
  pt: "o os as de do da que para com uma não por se em ao no na este".split(" "),
  nl: "de het een en van niet met voor op is zijn dat bij als uw dit".split(" "),
};

const LOOKUP = new Map<string, string[]>();
for (const [lang, words] of Object.entries(STOPWORDS)) {
  for (const w of words) LOOKUP.set(w, [...(LOOKUP.get(w) ?? []), lang]);
}

export interface LanguageScore {
  /** Best guess, or null when the page has too little prose to tell (diagrams, part lists). */
  lang: string | null;
  /** Share of stopword hits that are English, 0 to 1. */
  english: number;
}

const MIN_HITS = 8;

export function pageLanguage(text: string): LanguageScore {
  const counts: Record<string, number> = {};
  let hits = 0;
  for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    const langs = LOOKUP.get(word);
    if (!langs) continue;
    hits++;
    // A word several languages share ("de", "la") counts for each of them.
    for (const l of langs) counts[l] = (counts[l] ?? 0) + 1;
  }
  const english = hits ? (counts.en ?? 0) / hits : 0;
  if (hits < MIN_HITS) return { lang: null, english };
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { lang: top ? top[0] : null, english };
}

export interface LanguageFilter {
  kept: PageText[];
  /** Page numbers left out as another language. */
  dropped: number[];
}

/**
 * Keeps English pages, pages too sparse to judge, and bilingual pages with a
 * real share of English. If too little English is left (a Spanish-only
 * manual), keeps everything rather than starving the reader.
 */
export function keepEnglish(pages: PageText[]): LanguageFilter {
  const kept: PageText[] = [];
  const dropped: number[] = [];
  let englishPages = 0;
  for (const p of pages) {
    const { lang, english } = pageLanguage(p.content);
    if (lang === "en") englishPages++;
    if (lang === null || lang === "en" || english >= 0.3) kept.push(p);
    else dropped.push(p.page_number);
  }
  if (englishPages < Math.max(2, pages.length * 0.15)) return { kept: pages, dropped: [] };
  return { kept, dropped };
}
