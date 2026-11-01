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
  /** The model number as this PDF spells it, when the saved one looks misread (GSWWD0951A09B -> GSWWD09S1A09B). */
  model_hint?: string;
  problem?: string;
  /** The check didn't finish (slow site, network); the PDF may still be fine. */
  unchecked?: boolean;
  /** Other models of the same line this PDF also covers (RAC-PD1011CRU, ...), when it covers several. */
  models?: string[];
  /** Jev's pick among the candidates that name the model. */
  best?: boolean;
  /** The first pages' text, for picking; never sent to the browser. */
  excerpt?: string;
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
 * The saved model number re-spelled the way the text prints it, when they only
 * differ by look-alike characters: the label said GSWWD09S1A09B but was read
 * as GSWWD0951A09B. A family match keeps the saved variant letter(s) at the end.
 * Null when the text spells it the same, or doesn't name it.
 */
export function suggestModel(text: string, model: string | null | undefined): string | null {
  const m = squash(model ?? "");
  if (m.length < 6) return null;
  const t = squash(text);
  if (contains(t, m)) return null;
  // squash and lookalike keep every character in place, so positions line up.
  const lt = lookalike(text);
  const lm = lookalike(m);
  for (const cut of [0, 1, 2]) {
    const stem = cut ? lm.slice(0, -cut) : lm;
    if (cut && stem.length < 7) break;
    const at = lt.indexOf(stem);
    if (at >= 0) return (t.slice(at, at + stem.length) + m.slice(m.length - cut)).toUpperCase();
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

/**
 * A result title a person can read. PDFs often carry their work file's name as
 * the title ("PORTABLE PD_USER MANUAL TOSHIBA US (P14).indd"): drop the file
 * extension and underscores, and calm all-caps down. Short words like "US" stay.
 */
export function tidyTitle(raw: string): string {
  let t = raw
    .replace(/\.(indd|pdf|docx?|qxp|qxd|ai|idml|pub|rtf|txt)\b/gi, "")
    .replace(/_+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 6 && letters === letters.toUpperCase()) {
    t = t.replace(/[A-Z]{4,}/g, (w) => w[0] + w.slice(1).toLowerCase());
  }
  return t;
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
    const hint = suggestModel(`${r.title} ${url.pathname}`, item.model);
    ranked.push({
      url: url.toString(),
      title: tidyTitle(r.title) || url.pathname.split("/").pop() || host,
      host,
      official,
      named,
      ...(hint ? { model_hint: hint } : {}),
      rank: (official ? 3 : 0) + (named ? 2 : 0) + r.score,
    });
  }
  return ranked.sort((a, b) => b.rank - a.rank).map(({ rank: _, ...c }) => c);
}

/**
 * One web search: SearXNG first when it's set, Tavily when SearXNG is down or
 * finds nothing. Scores are 0 to 1 either way so ranking treats them alike.
 */
export async function searchWeb(
  env: Env,
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SearchResult[]> {
  const search = env.search;
  if (!search) throw new Error("Web search isn't set up (SEARXNG_URL or SEARCH_API_KEY).");
  let failure: unknown;
  if (search.searxng) {
    try {
      const found = await searxng(search.searxng, query, fetchImpl);
      if (found.length || !search.tavily) return found;
    } catch (err) {
      if (!search.tavily) throw err;
      failure = err;
    }
  }
  if (search.tavily) return tavily(search.tavily.apiKey, query, fetchImpl);
  throw failure;
}

/** The self-hosted SearXNG's JSON API, through Cloudflare Access when a service token is set. */
async function searxng(
  config: NonNullable<NonNullable<Env["search"]>["searxng"]>,
  query: string,
  fetchImpl: typeof fetch,
): Promise<SearchResult[]> {
  const url = `${config.baseUrl}/search?${new URLSearchParams({ q: query, format: "json" })}`;
  const res = await fetchImpl(url, {
    headers: {
      accept: "application/json",
      ...(config.accessId && config.accessSecret
        ? { "CF-Access-Client-Id": config.accessId, "CF-Access-Client-Secret": config.accessSecret }
        : {}),
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`The search answered ${res.status}.`);
  const body = (await res.json()) as { results?: { url?: string; title?: string }[] };
  const results = (body.results ?? []).filter((r) => typeof r.url === "string").slice(0, 15);
  // SearXNG's own scores aren't on a fixed scale; its order is, so rank by position.
  return results.map((r, i) => ({
    url: r.url as string,
    title: r.title ?? "",
    score: 1 - i / results.length,
  }));
}

async function tavily(
  apiKey: string,
  query: string,
  fetchImpl: typeof fetch,
): Promise<SearchResult[]> {
  const res = await fetchImpl("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
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

/**
 * The model numbers of the same line a text mentions, spelled as printed: a
 * manual for "RAC-PD0811CRU" that also lists RAC-PD1011CRU covers several sizes.
 * The line is the model's letters before its first digit (RAC-PD), at least 3.
 */
export function sameLineModels(text: string, model: string | null | undefined): string[] {
  const prefix = squash((model ?? "").match(/^[^0-9]*/)?.[0] ?? "");
  if (prefix.length < 3) return [];
  const found = new Map<string, string>();
  for (const word of text.match(/[A-Za-z][A-Za-z-]*\d[A-Za-z0-9-]*/g) ?? []) {
    const key = squash(word);
    if (key.startsWith(prefix) && key.length > prefix.length + 1 && !found.has(key)) {
      found.set(key, word.replace(/-+$/, ""));
    }
  }
  return [...found.values()];
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
    const text = pages.map((p) => p.content).join(" ");
    const match = modelMatch(text, model);
    const hint = match === "lookalike" ? suggestModel(text, model) : null;
    const models = sameLineModels(text, model);
    return {
      ...candidate,
      page_count: pageCount,
      has_model: match !== null,
      ...(match ? { match } : {}),
      ...(hint ? { model_hint: hint } : {}),
      ...(models.length > 1 ? { models: models.slice(0, 8) } : {}),
      excerpt: pages
        .slice(0, 3)
        .map((p) => p.content)
        .join(" ")
        .slice(0, 3_000),
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
  let ranked = rankResults([...best.values()], item);
  // Too few PDFs: the maker's product page often links the manual without the search seeing it.
  if (ranked.length < check && env.crawl) {
    const found = await pdfLinksFromPages(
      env.crawl,
      pagesWorthOpening([...best.values()], item),
      fetchImpl,
    );
    if (found.length) {
      for (const r of found) if (!best.has(r.url)) best.set(r.url, r);
      ranked = rankResults([...best.values()], item);
    }
  }
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
  const picked = await pickBest(env, item, candidates, fetchImpl);
  const strip = ({ excerpt: _, ...c }: Candidate) => c;
  return { query, candidates: picked.map(strip), tried: tried.map(strip) };
}

/** Manual-listing sites: they turn crawlers away (manuals.plus answers 403) and only mirror the maker's PDF. */
const LISTING_HOSTS =
  /(^|\.)(manuals\.plus|manualsfile\.com|manualsdir\.com|manualshelf\.com|usermanual\.wiki|manualowl\.com|all-guidesbox\.com|safe-manuals\.com|device\.report)$/;

/** Pages (not PDFs) from the maker's site or naming the model, best first, at most two. */
export function pagesWorthOpening(
  results: SearchResult[],
  item: { brand?: string | null; model?: string | null },
): SearchResult[] {
  return results
    .filter((r) => {
      try {
        const url = new URL(r.url);
        const host = url.hostname.toLowerCase();
        if (url.protocol !== "https:" || SKIP_HOSTS.test(host) || isPdfUrl(url)) return false;
        if (LISTING_HOSTS.test(host)) return false;
        return (
          isBrandHost(host, item.brand) ||
          modelMatch(`${r.title} ${url.pathname}`, item.model) !== null
        );
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
}

/**
 * Opens each page with Crawl4AI and keeps the PDF links on it, scored just
 * under the page itself. Slow or failing pages are skipped quietly.
 */
export async function pdfLinksFromPages(
  crawl: NonNullable<Env["crawl"]>,
  pages: SearchResult[],
  fetchImpl: typeof fetch = fetch,
): Promise<SearchResult[]> {
  if (!pages.length) return [];
  const res = await fetchImpl(`${crawl.baseUrl}/crawl`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${crawl.token}`,
      ...(crawl.accessId && crawl.accessSecret
        ? { "CF-Access-Client-Id": crawl.accessId, "CF-Access-Client-Secret": crawl.accessSecret }
        : {}),
    },
    body: JSON.stringify({ urls: pages.map((p) => p.url) }),
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);
  if (!res?.ok) return [];
  const body = (await res.json().catch(() => ({}))) as {
    results?: {
      url?: string;
      links?: Record<string, { href?: string; text?: string }[]>;
    }[];
  };
  const out: SearchResult[] = [];
  for (const page of body.results ?? []) {
    const from = pages.find((p) => p.url === page.url) ?? pages[0];
    for (const link of Object.values(page.links ?? {}).flat()) {
      try {
        const url = new URL(link.href ?? "", page.url);
        if (url.protocol !== "https:" || !isPdfUrl(url)) continue;
        if (out.some((r) => r.url === url.toString())) continue;
        out.push({
          url: url.toString(),
          title: (link.text ?? "").trim() || from?.title || "",
          score: Math.max(0, (from?.score ?? 0) - 0.01),
        });
      } catch {}
    }
  }
  return out.slice(0, 10);
}

/** Jev's "this is the one" must reach this, and beat the next by PICK_MARGIN. */
export const PICK_FLOOR = 0.5;
export const PICK_MARGIN = 0.15;

/**
 * When two or more PDFs name the model, Jev reads the first pages of each and
 * says which one is written for this exact model (not a sibling size, not a
 * whole product line). The clear winner is marked best and moved first; a
 * close call, or Jev being away, leaves the order as it was.
 */
export async function pickBest(
  env: Env,
  item: { brand?: string | null; model?: string | null; nickname?: string | null },
  candidates: Candidate[],
  fetchImpl: typeof fetch = fetch,
): Promise<Candidate[]> {
  const router = env.router;
  const named = candidates.filter((c) => c.has_model && c.excerpt);
  // Only one PDF prints the model (not a lookalike spelling): that's the pick, no need to ask Jev.
  if (named.length === 1 && named[0]?.match !== "lookalike") {
    const only = named[0] as Candidate;
    return [{ ...only, best: true }, ...candidates.filter((c) => c !== only)];
  }
  if (!router || !item.model || named.length < 2) return candidates;
  const thing = [item.brand, item.nickname, item.model].filter(Boolean).join(" ");
  try {
    const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${router.apiKey}` },
      body: JSON.stringify({
        model: router.model,
        state: {
          thing,
          manuals: Object.fromEntries(
            named.map((c, i) => [
              `m${i}`,
              { title: c.title, pages: c.page_count, also_lists: c.models ?? [], text: c.excerpt },
            ]),
          ),
        },
        questions: Object.fromEntries(
          named.map((_, i) => [
            `m${i}`,
            {
              type: "noul",
              instructions: `Is manual m${i} the owner's manual for the ${thing} itself?`,
              criteria: {
                true: "It is written for this model: its own size and version, or a short list where this model is one of a few close variants.",
                false:
                  "It is for a different size or model, or a long catalog where this model is only mentioned.",
              },
            },
          ]),
        ),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return candidates;
    const body = (await res.json()) as { answers?: Record<string, { noul?: number }> };
    const scored = named
      .map((c, i) => ({ c, p: body.answers?.[`m${i}`]?.noul ?? 0 }))
      .sort((a, b) => b.p - a.p);
    const [top, next] = scored;
    if (!top || top.p < PICK_FLOOR || (next && top.p - next.p < PICK_MARGIN)) return candidates;
    const winner = { ...top.c, best: true };
    return [winner, ...candidates.filter((c) => c !== top.c)];
  } catch {
    return candidates;
  }
}
