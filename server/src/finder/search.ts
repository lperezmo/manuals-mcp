import type { Env } from "../env.js";
import { FetchPdfError, fetchPdf } from "./fetch-pdf.js";
import { pdfPages } from "./pdf-text.js";

// Finding a manual on the web for the website, where no AI client is there
// to search. One search query, PDF links ranked (the maker's own site first),
// then the top few downloaded and checked for the model number before the
// user is asked "is this yours?". Nothing here spends a Muse read.

export interface SearchResult {
  url: string;
  title: string;
  score: number;
}

export interface Candidate {
  url: string;
  title: string;
  host: string;
  official: boolean;
  /** The model number is in the link or the result's title. */
  named: boolean;
  /** Filled in by checkCandidate. */
  page_count?: number;
  has_model?: boolean;
  /** How the PDF names the model; see modelMatch. */
  match?: Match;
  problem?: string;
  /** The check didn't finish (slow site, network); the PDF may still be fine. */
  unchecked?: boolean;
}

/** Sites that list manuals but rarely serve the PDF itself, or aren't manuals at all. */
const SKIP_HOSTS =
  /(^|\.)(manua\.ls|manualslib\.com|manualzz\.com|manualsonline\.com|searspartsdirect\.com|youtube\.com|youtu\.be|yahoo\.com|amazon\.[a-z.]+|ebay\.[a-z.]+|reddit\.com|pinterest\.com|facebook\.com)$/;

export function searchQuery(item: {
  brand?: string | null;
  model?: string | null;
  nickname?: string | null;
}): string {
  return [item.brand, item.model || item.nickname, "owner's manual pdf"].filter(Boolean).join(" ");
}

/**
 * The queries run together: the main one, and a plainer one with what the
 * thing is. Search engines correct a misread model number more readily in the
 * plainer one ("GSWWD0951A09B microwave manual" finds GSWWD09S1A09B's).
 */
export function searchQueries(item: {
  brand?: string | null;
  model?: string | null;
  nickname?: string | null;
}): string[] {
  const main = searchQuery(item);
  if (!item.model) return [main];
  return [main, [item.brand, item.model, item.nickname, "manual"].filter(Boolean).join(" ")];
}

/** Letters and digits only, lower case: "WTW-5000 DW" and "wtw5000dw" match. */
export function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type Match = "exact" | "family" | "lookalike";

/** Characters a label photo or a person easily confuses, folded together: S/5, O/0, I/L/1, B/8, Z/2. */
export function lookalike(text: string): string {
  return squash(text).replace(
    /[soilbz]/g,
    (c) => ({ s: "5", o: "0", i: "1", l: "1", b: "8", z: "2" })[c] ?? c,
  );
}

function contains(text: string, model: string): "exact" | "family" | null {
  if (text.includes(model)) return "exact";
  for (const cut of [1, 2]) {
    const stem = model.slice(0, -cut);
    if (stem.length >= 7 && text.includes(stem)) return "family";
  }
  return null;
}

/**
 * How text names a model: "exact"; "family" when only the last one or two
 * characters differ (GSWWD09S1A09B on the sticker, GSWWD09S1A09A in the PDF);
 * "lookalike" when it matches once easily confused characters are folded
 * together (a label read as GSWWD0951A09B); or null. Family needs at least 7
 * characters left and lookalike at least 6, so short numbers can't match by accident.
 */
export function modelMatch(text: string, model: string | null | undefined): Match | null {
  const m = squash(model ?? "");
  if (m.length < 4) return null;
  const direct = contains(squash(text), m);
  if (direct) return direct;
  if (m.length >= 6 && contains(lookalike(text), lookalike(m))) return "lookalike";
  return null;
}

function isPdfUrl(url: URL): boolean {
  return /\.pdf$/i.test(url.pathname) || /[?&][^=]*=?[^&]*\.pdf/i.test(url.search);
}

/** Whether a host belongs to the brand: whirlpool.com, media3.bosch-home.com, download.gracobaby.com. */
export function isBrandHost(host: string, brand: string | null | undefined): boolean {
  const b = squash(brand ?? "");
  return b.length >= 2 && squash(host.replace(/\.[a-z]+$/, "")).includes(b);
}

/** PDF links from the results, best first: the maker's site, then the model in the link or title. */
export function rankResults(
  results: SearchResult[],
  item: { brand?: string | null; model?: string | null },
): Candidate[] {
  const seen = new Set<string>();
  const ranked: (Candidate & { rank: number })[] = [];
  for (const r of results) {
    let url: URL;
    try {
      url = new URL(r.url);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || SKIP_HOSTS.test(host) || !isPdfUrl(url)) continue;
    if (seen.has(url.toString())) continue;
    seen.add(url.toString());
    const official = isBrandHost(host, item.brand);
    const named = modelMatch(`${r.title} ${url.pathname}`, item.model) !== null;
    ranked.push({
      url: url.toString(),
      title: r.title,
      host,
      official,
      named,
      rank: (official ? 3 : 0) + (named ? 2 : 0) + r.score,
    });
  }
  return ranked.sort((a, b) => b.rank - a.rank).map(({ rank: _, ...c }) => c);
}

/** One web search through the configured provider. */
export async function searchWeb(
  env: Env,
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchResult[]> {
  const search = env.search;
  if (!search) throw new Error("Web search isn't set up (SEARCH_API_KEY).");
  const res = await fetchImpl("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${search.apiKey}` },
    body: JSON.stringify({ query, search_depth: "basic", max_results: 10 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`The search answered ${res.status}.`);
  const body = (await res.json()) as {
    results?: { url?: string; title?: string; score?: number }[];
  };
  return (body.results ?? [])
    .filter((r) => typeof r.url === "string")
    .map((r) => ({ url: r.url as string, title: r.title ?? "", score: r.score ?? 0 }));
}

/** Downloads a candidate and checks it is a PDF that names the model. */
export async function checkCandidate(
  candidate: Candidate,
  model: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<Candidate> {
  try {
    const { bytes } = await fetchPdf(candidate.url, fetchImpl);
    const { pageCount, pages } = await pdfPages(bytes);
    // No text layer (a scan) or no model to look for: we can't tell, so don't claim a match.
    const match = modelMatch(pages.map((p) => p.content).join(" "), model);
    return {
      ...candidate,
      page_count: pageCount,
      has_model: match !== null,
      ...(match ? { match } : {}),
    };
  } catch (err) {
    // A FetchPdfError is a definite answer (not a PDF, 404, too big); anything
    // else is a timeout or network trouble, which says nothing about the PDF.
    const definite = err instanceof FetchPdfError;
    return {
      ...candidate,
      problem: definite ? err.message : "Couldn't open that PDF in time.",
      ...(definite ? {} : { unchecked: true }),
    };
  }
}

export interface FindOutcome {
  query: string;
  /** Checked PDFs that opened and look like this thing's, model matches first. */
  candidates: Candidate[];
  /** Everything tried, for the model log. */
  tried: Candidate[];
}

/** Searches, ranks and checks up to `check` PDFs, in parallel. */
export async function findManual(
  env: Env,
  item: { brand?: string | null; model?: string | null; nickname?: string | null },
  fetchImpl: typeof fetch = fetch,
  check = 3,
): Promise<FindOutcome> {
  const queries = searchQueries(item);
  const query = queries[0] as string;
  const answers = await Promise.allSettled(queries.map((q) => searchWeb(env, q, fetchImpl)));
  const ok = answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
  if (!ok.length) throw (answers[0] as PromiseRejectedResult).reason;
  // One list, each link once with its best score.
  const best = new Map<string, SearchResult>();
  for (const r of ok.flat()) {
    const seen = best.get(r.url);
    if (!seen || r.score > seen.score) best.set(r.url, r);
  }
  const ranked = rankResults([...best.values()], item);
  const tried = await Promise.all(
    ranked.slice(0, check).map((c) => checkCandidate(c, item.model, fetchImpl)),
  );
  // A PDF that names neither the model nor comes from the maker is likely
  // someone else's (a fictional "BW-4100" found a forklift's "XL4100").
  // A slow maker's site isn't a wrong PDF: keep an unchecked one when it's the
  // maker's own and its link names the model, and let the person decide.
  const candidates = tried
    .filter((c) =>
      c.problem ? c.unchecked && c.official && c.named : c.has_model || c.official || c.named,
    )
    .sort(
      (a, b) =>
        Number(Boolean(b.has_model)) - Number(Boolean(a.has_model)) ||
        Number(!b.unchecked) - Number(!a.unchecked) ||
        Number(b.official) - Number(a.official),
    );
  return { query, candidates, tried };
}
