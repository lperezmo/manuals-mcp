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
  problem?: string;
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

/** Letters and digits only, lower case: "WTW-5000 DW" and "wtw5000dw" match. */
export function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
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
  const model = squash(item.model ?? "");
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
    const named = model.length >= 4 && squash(`${r.title} ${url.pathname}`).includes(model);
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
    const wanted = squash(model ?? "");
    const text = squash(pages.map((p) => p.content).join(" "));
    return {
      ...candidate,
      page_count: pageCount,
      // No text layer (a scan) or no model to look for: we can't tell, so don't claim a match.
      has_model: wanted.length >= 4 && text.includes(wanted),
    };
  } catch (err) {
    return {
      ...candidate,
      problem: err instanceof FetchPdfError ? err.message : "Couldn't open that PDF.",
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
  const query = searchQuery(item);
  const ranked = rankResults(await searchWeb(env, query, fetchImpl), item);
  const tried = await Promise.all(
    ranked.slice(0, check).map((c) => checkCandidate(c, item.model, fetchImpl)),
  );
  // A PDF that names neither the model nor comes from the maker is likely
  // someone else's (a fictional "BW-4100" found a forklift's "XL4100").
  const candidates = tried
    .filter((c) => !c.problem && (c.has_model || c.official || c.named))
    .sort(
      (a, b) =>
        Number(b.has_model) - Number(a.has_model) || Number(b.official) - Number(a.official),
    );
  return { query, candidates, tried };
}
