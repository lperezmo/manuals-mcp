import type { Env } from "../env.js";
import {
  blockedSentence,
  CHECK_FIRST_BYTE_MS,
  CHECK_TIMEOUT_MS,
  FetchPdfError,
  fetchPdf,
  SiteBlockedError,
} from "./fetch-pdf.js";
import { pdfPages } from "./pdf-text.js";

// Finding a manual on the web for the website, where no AI client is there
// to search. One search query, PDF links ranked (the maker's own site first),
// then the top few downloaded and checked for the model number before the
// user is asked "is this yours?". Nothing here spends a Muse read.

export interface SearchResult {
  url: string;
  title: string;
  score: number;
  /** For a PDF link found on a page: that page's title and link. */
  via?: string;
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
  /** The site turned us away or never answered: only the person's own browser can get it. */
  blocked?: boolean;
  /** A spec, feature, energy, dimension or install sheet: about the model, but not its manual. */
  sheet?: boolean;
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

/** Words that mark a sheet about the model rather than its manual. */
const SHEET_WORDS =
  /\b((spec(ification)?s?|feature|cycle|reference|tech|data|fact|product) ?sheets?|spec(ification)?s? guide|quick ?specs?|key features|features (&|and) benefits|energy ?guide|dimension(s| guide)?|install(ation)? (instructions?|guide|sheet)|wiring diagram|parts? (list|catalog)|service manual|warranty|brochure)\b|specsheet/;
/** Words that mark the manual itself; a combined "Installation and Use & Care Guide" is a manual. */
const MANUAL_WORDS =
  /\b(use (&|and) care|owner'?s? (manual|guide)|user'?s? (manual|guide|instructions)|operating instructions|instruction manual)\b/;

/** Lower case, link separators as spaces: "WDF330PAHS_quick-specs.pdf" reads "wdf330pahs quick specs pdf". */
function plain(text: string): string {
  let t = text;
  try {
    t = decodeURIComponent(text);
  } catch {}
  return t
    .toLowerCase()
    .replace(/[_\-./]+/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Whether a title, link or first page reads like a spec sheet, cycle sheet,
 * energy guide, dimension guide or the like (Whirlpool's "Key Features &
 * Benefits"), not the owner's or use and care manual.
 */
export function isSheet(text: string): boolean {
  const t = plain(text);
  return SHEET_WORDS.test(t) && !MANUAL_WORDS.test(t);
}

/** Whether a title or link says it is the owner's, user or use and care manual. */
export function looksLikeManual(text: string): boolean {
  const t = plain(text);
  return MANUAL_WORDS.test(t) && !isSheet(text);
}

/**
 * The model without its trailing revision digits, when it has some:
 * WDF330PAHS5 is a WDF330PAHS, and pages and PDFs often name only that.
 */
export function baseModel(model: string | null | undefined): string | null {
  const m = (model ?? "").trim();
  const base = m.replace(/[-\s]*\d{1,2}$/, "");
  return base !== m && /[A-Za-z]$/.test(base) && squash(base).length >= 6 ? base : null;
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
    // A manual linked from a page for this model counts as naming it (Whirlpool's
    // owners page for WDF330PAHS links "owners-manual-W10644345.pdf").
    const named =
      modelMatch(`${r.title} ${url.pathname}`, item.model) !== null ||
      Boolean(
        r.via &&
          modelMatch(r.via, item.model) !== null &&
          looksLikeManual(`${r.title} ${url.pathname}`),
      );
    const hint = suggestModel(`${r.title} ${url.pathname}`, item.model);
    const sheet = isSheet(`${r.title} ${url.pathname}`);
    ranked.push({
      url: url.toString(),
      title: tidyTitle(r.title) || url.pathname.split("/").pop() || host,
      host,
      official,
      named,
      ...(hint ? { model_hint: hint } : {}),
      ...(sheet ? { sheet } : {}),
      // A sheet that names the model shouldn't push the manual out of the few PDFs checked.
      rank: (official ? 3 : 0) + (named ? 2 : 0) - (sheet ? 3 : 0) + r.score,
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
  timeoutMs = CHECK_TIMEOUT_MS,
  firstByteMs = CHECK_FIRST_BYTE_MS,
): Promise<Candidate> {
  try {
    const { bytes } = await fetchPdf(
      candidate.url,
      fetchImpl,
      timeoutMs,
      Math.min(firstByteMs, timeoutMs),
    );
    const { pageCount, pages } = await pdfPages(bytes);
    // No text layer (a scan) or no model to look for: we can't tell, so don't claim a match.
    const text = pages.map((p) => p.content).join(" ");
    const match = modelMatch(text, model);
    const hint = match === "lookalike" ? suggestModel(text, model) : null;
    const models = sameLineModels(text, model);
    const excerpt = pages
      .slice(0, 3)
      .map((p) => p.content)
      .join(" ")
      .slice(0, 3_000);
    // A page or two that reads like a spec or install sheet is one, whatever its link says.
    const sheet = candidate.sheet || (pageCount <= 4 && isSheet(excerpt.slice(0, 1_500)));
    return {
      ...candidate,
      page_count: pageCount,
      has_model: match !== null,
      ...(match ? { match } : {}),
      ...(hint ? { model_hint: hint } : {}),
      ...(models.length > 1 ? { models: models.slice(0, 8) } : {}),
      ...(sheet ? { sheet } : {}),
      excerpt,
    };
  } catch (err) {
    // The site turned us away: the PDF may be fine, but only the person's browser can get it.
    if (err instanceof SiteBlockedError)
      return { ...candidate, problem: err.message, unchecked: true, blocked: true };
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

/** "Whirlpool's site won't let apps download its manuals.", with the brand's name when it's the maker's own site. */
export function blockedMessage(err: SiteBlockedError, brand: string | null | undefined): string {
  const site =
    brand && isBrandHost(err.host, brand) ? `${brand}'s site` : err.host.replace(/^www\./, "");
  const first = blockedSentence(site, err.why);
  return `${first[0]?.toUpperCase() ?? ""}${first.slice(1)} Tap Open, save the PDF on your phone, then add it with Upload a PDF.`;
}

export interface FindOutcome {
  query: string;
  /** Checked PDFs that opened and look like this thing's, model matches first. */
  candidates: Candidate[];
  /** Everything tried, for the model log. */
  tried: Candidate[];
}

/** All of a search's downloading ends by then, so Jev's pick and the log fit in the function's 60 s. */
export const FIND_BUDGET_MS = 45_000;
/** A second look needs at least this long to be worth starting. */
const SECOND_LOOK_MIN_MS = 12_000;
/** Pages the second look opens with the crawler, in one call. */
const SECOND_LOOK_PAGES = 5;

/**
 * Searches, ranks and checks up to `check` PDFs, in parallel. When none of
 * them turns out to be the manual because a site turned us away or they were
 * only spec sheets, looks once more: further down the list and on retailers'
 * pages, skipping the sites that didn't answer, for a copy that opens.
 */
export async function findManual(
  env: Env,
  item: { brand?: string | null; model?: string | null; nickname?: string | null },
  fetchImpl: typeof fetch = fetch,
  check = 3,
  budgetMs = FIND_BUDGET_MS,
): Promise<FindOutcome> {
  const deadline = Date.now() + budgetMs;
  const left = () => deadline - Date.now();
  const queries = searchQueries(item);
  const query = queries[0] as string;
  const base = baseModel(item.model);
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
      await choosePages(env, item, [...best.values()], fetchImpl),
      fetchImpl,
    );
    if (found.length) {
      for (const r of found) if (!best.has(r.url)) best.set(r.url, r);
      ranked = rankResults([...best.values()], item);
    }
  }
  const checkAll = (list: Candidate[]) =>
    Promise.all(
      list.map((c) =>
        checkCandidate(
          c,
          item.model,
          fetchImpl,
          Math.max(1_000, Math.min(CHECK_TIMEOUT_MS, left())),
        ),
      ),
    );
  const tried = await checkAll(ranked.slice(0, check));
  const isManual = (c: Candidate) => !c.problem && !c.sheet && Boolean(c.has_model || c.named);
  const gotStuck = tried.some((c) => c.unchecked || c.sheet);
  if (!tried.some(isManual) && (gotStuck || base) && left() >= SECOND_LOOK_MIN_MS) {
    // Sites that didn't answer won't answer a second time either.
    const away = new Set(tried.filter((c) => c.unchecked).map((c) => c.host));
    const done = new Set(tried.map((c) => c.url));
    const fresh = (list: Candidate[]) => list.filter((c) => !away.has(c.host) && !done.has(c.url));
    // More searches: the model without its revision digit, and one that finds
    // stores and manual sites carrying a copy.
    const again = await Promise.allSettled(
      secondLookQueries(item, base).map((q) => searchWeb(env, q, fetchImpl)),
    );
    for (const a of again) {
      if (a.status !== "fulfilled") continue;
      for (const r of a.value) if (!best.has(r.url)) best.set(r.url, r);
    }
    let more = fresh(rankResults([...best.values()], item));
    if (more.length < check && env.crawl) {
      // Jev's picks, then more of the pages naming the model: a retailer's page often carries the PDF.
      const results = [...best.values()].filter((r) => !away.has(hostOf(r.url)));
      const pages = [
        ...(await choosePages(env, item, results, fetchImpl, away)),
        ...pagesWorthOpening(results, item, SECOND_LOOK_PAGES),
      ]
        .filter((p, i, all) => all.findIndex((q) => q.url === p.url) === i)
        .slice(0, SECOND_LOOK_PAGES);
      const found = await pdfLinksFromPages(
        env.crawl,
        pages,
        fetchImpl,
        Math.min(20_000, left() - 5_000),
      );
      for (const r of found) if (!best.has(r.url)) best.set(r.url, r);
      if (found.length) more = fresh(rankResults([...best.values()], item));
    }
    if (more.length && left() >= 5_000) tried.push(...(await checkAll(more.slice(0, check))));
  }
  // A PDF that names neither the model nor comes from the maker is likely
  // someone else's (a fictional "BW-4100" found a forklift's "XL4100").
  // A slow maker's site isn't a wrong PDF: keep an unchecked one when it's the
  // maker's own and its link names the model, and let the person decide.
  // A real manual on a site that blocks apps is still offered: the person's
  // phone can open it and save it.
  const blockedManual = (c: Candidate) =>
    Boolean(c.blocked) &&
    !c.sheet &&
    (c.named || (c.official && looksLikeManual(`${c.title} ${pathOf(c.url)}`)));
  let kept = tried.filter((c) =>
    c.problem
      ? (c.unchecked && c.official && c.named) || blockedManual(c)
      : c.has_model || c.official || c.named,
  );
  // Several blocked "Owner's Manual" links all look alike: keep the ones found
  // for this model, or else just the first, and none when one opened.
  const lookalikes = kept.filter((c) => blockedManual(c) && !c.named);
  if (lookalikes.length) {
    const keep = kept.some((c) => isManual(c) || (blockedManual(c) && c.named))
      ? null
      : lookalikes[0];
    kept = kept.filter((c) => !lookalikes.includes(c) || c === keep);
  }
  // Opened manuals, then blocked ones, then the rest; sheets last. When a manual
  // is there, sheets and PDFs that name neither the model nor its page are gone
  // (a rebate form or a help page from the maker's site).
  const tier = (c: Candidate) => (isManual(c) ? 0 : blockedManual(c) ? 1 : c.sheet ? 3 : 2);
  const hasManual = kept.some((c) => isManual(c) || blockedManual(c));
  const candidates = (
    hasManual
      ? kept.filter((c) => tier(c) < 2 || (tier(c) === 2 && (c.has_model || c.named)))
      : kept
  ).sort(
    (a, b) =>
      tier(a) - tier(b) ||
      Number(!b.unchecked) - Number(!a.unchecked) ||
      Number(Boolean(b.has_model)) - Number(Boolean(a.has_model)) ||
      Number(b.official) - Number(a.official),
  );
  const picked = await pickBest(env, item, candidates, fetchImpl);
  const strip = ({ excerpt: _, ...c }: Candidate) => c;
  return { query, candidates: picked.map(strip), tried: tried.map(strip) };
}

/** The second look's searches: the base model's usual two, and a "manual pdf download" one. */
export function secondLookQueries(
  item: { brand?: string | null; model?: string | null; nickname?: string | null },
  base: string | null,
): string[] {
  const model = base ?? item.model;
  if (!model) return [];
  return [
    ...(base ? searchQueries({ ...item, model: base }) : []),
    [item.brand, model, "manual pdf download"].filter(Boolean).join(" "),
  ];
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Manual-listing sites: they turn crawlers away (manuals.plus answers 403) and only mirror the maker's PDF. */
const LISTING_HOSTS =
  /(^|\.)(manuals\.plus|manualsfile\.com|manualsdir\.com|manualshelf\.com|usermanual\.wiki|manualowl\.com|all-guidesbox\.com|safe-manuals\.com|device\.report|notice-facile\.com|manuals\.ca|manual\.gt)$/;
/** Parts and repair-help shops: their model pages list parts, not the manual PDF. */
const PARTS_HOSTS =
  /(^|\.)(partselect\.(com|ca)|appliancepartspros\.com|repairclinic\.com|reliableparts\.(com|ca)|partsdr\.com|coastparts\.com|justanswer\.com|ifixit\.com|ubuy\.[a-z.]+|whirlpoolparts\.com)$/;

/** Pages (not PDFs) from the maker's site or naming the model, best first, at most `limit`. */
export function pagesWorthOpening(
  results: SearchResult[],
  item: { brand?: string | null; model?: string | null },
  limit = 2,
): SearchResult[] {
  return results
    .filter((r) => {
      try {
        const url = new URL(r.url);
        const host = url.hostname.toLowerCase();
        if (url.protocol !== "https:" || SKIP_HOSTS.test(host) || isPdfUrl(url)) return false;
        if (LISTING_HOSTS.test(host) || PARTS_HOSTS.test(host)) return false;
        return (
          isBrandHost(host, item.brand) ||
          modelMatch(`${r.title} ${url.pathname}`, item.model) !== null
        );
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Which pages to open with the crawler. Jev reads each page's title and link
 * and says whether it likely links this thing's manual PDF (a maker's product
 * or support page does; a forum or parts shop rarely does). Without Jev, or
 * if it's away, the maker's pages and model-named ones go.
 */
export async function choosePages(
  env: Env,
  item: { brand?: string | null; model?: string | null; nickname?: string | null },
  results: SearchResult[],
  fetchImpl: typeof fetch = fetch,
  avoid: Set<string> = new Set(),
): Promise<SearchResult[]> {
  const fallback = pagesWorthOpening(results, item).filter((r) => !avoid.has(hostOf(r.url)));
  const router = env.router;
  const pool = results
    .filter((r) => {
      try {
        const url = new URL(r.url);
        const host = url.hostname.toLowerCase();
        return (
          url.protocol === "https:" &&
          !SKIP_HOSTS.test(host) &&
          !LISTING_HOSTS.test(host) &&
          !PARTS_HOSTS.test(host) &&
          !avoid.has(host) &&
          !isPdfUrl(url)
        );
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  if (!router || pool.length === 0) return fallback;
  const thing = [item.brand, item.nickname, item.model].filter(Boolean).join(" ");
  try {
    const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${router.apiKey}` },
      body: JSON.stringify({
        model: router.model,
        state: {
          thing,
          pages: Object.fromEntries(pool.map((r, i) => [`p${i}`, { title: r.title, url: r.url }])),
        },
        questions: Object.fromEntries(
          pool.map((_, i) => [
            `p${i}`,
            {
              type: "noul",
              instructions: `Is page p${i} likely to link the owner's manual PDF for the ${thing}?`,
              criteria: {
                true: "The maker's product, support or downloads page for this model, or a retailer's page for it with a manuals section.",
                false:
                  "A forum, review, news, parts or general shopping page, or one for another product.",
              },
            },
          ]),
        ),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return fallback;
    const body = (await res.json()) as { answers?: Record<string, { noul?: number }> };
    return pool
      .map((r, i) => ({ r, p: body.answers?.[`p${i}`]?.noul ?? 0 }))
      .filter((x) => x.p >= PICK_FLOOR)
      .sort((a, b) => b.p - a.p)
      .slice(0, 2)
      .map((x) => x.r);
  } catch {
    return fallback;
  }
}

/**
 * Opens each page with Crawl4AI and keeps the PDF links on it, scored just
 * under the page itself. Each page is its own request, so one slow page
 * doesn't hold up the rest; slow or failing pages are skipped quietly.
 */
export async function pdfLinksFromPages(
  crawl: NonNullable<Env["crawl"]>,
  pages: SearchResult[],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<SearchResult[]> {
  if (!pages.length || timeoutMs <= 0) return [];
  const each = await Promise.all(pages.map((p) => linksOnPage(crawl, p, fetchImpl, timeoutMs)));
  const out: SearchResult[] = [];
  for (const r of each.flat()) if (!out.some((o) => o.url === r.url)) out.push(r);
  return out;
}

async function linksOnPage(
  crawl: NonNullable<Env["crawl"]>,
  from: SearchResult,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SearchResult[]> {
  try {
    const res = await fetchImpl(`${crawl.baseUrl}/crawl`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${crawl.token}`,
        ...(crawl.accessId && crawl.accessSecret
          ? { "CF-Access-Client-Id": crawl.accessId, "CF-Access-Client-Secret": crawl.accessSecret }
          : {}),
      },
      body: JSON.stringify({ urls: [from.url] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      results?: {
        url?: string;
        links?: Record<string, { href?: string; text?: string }[]>;
      }[];
    };
    const out: SearchResult[] = [];
    for (const page of body.results ?? []) {
      const base = page.url ?? from.url;
      for (const link of Object.values(page.links ?? {}).flat()) {
        try {
          const url = new URL(link.href ?? "", base);
          if (url.protocol !== "https:" || !isPdfUrl(url)) continue;
          if (out.some((r) => r.url === url.toString())) continue;
          out.push({
            url: url.toString(),
            title: (link.text ?? "").trim() || from.title || "",
            score: Math.max(0, from.score - 0.01),
            via: `${from.title} ${base}`.trim(),
          });
        } catch {}
      }
    }
    return out.slice(0, 10);
  } catch {
    return [];
  }
}

/** Jev's "this is the one" must reach this, and beat the next by PICK_MARGIN. */
export const PICK_FLOOR = 0.5;
export const PICK_MARGIN = 0.15;

/**
 * When two or more PDFs name the model, Jev reads the first pages of each and
 * answers three questions: is it for this model, is it for this model alone
 * rather than a series, and is it the full manual rather than a quick start.
 * The clear winner on the first is marked best and moved first; a tie goes to
 * the more specific, complete one, then to the one covering fewer models. A
 * close call all the way down, or Jev being away, leaves the order as it was.
 */
export async function pickBest(
  env: Env,
  item: { brand?: string | null; model?: string | null; nickname?: string | null },
  candidates: Candidate[],
  fetchImpl: typeof fetch = fetch,
): Promise<Candidate[]> {
  const router = env.router;
  // A spec sheet prints the model too, but it's never the pick.
  const named = candidates.filter((c) => c.has_model && c.excerpt && !c.sheet);
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
          named.flatMap((_, i) => [
            [
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
            ],
            [
              `m${i}_specific`,
              {
                type: "noul",
                instructions: `Is manual m${i} written for this one model rather than a whole series of sizes?`,
                criteria: {
                  true: "It covers this model alone or with one or two near-identical variants.",
                  false: "It covers a series of several sizes or models with shared instructions.",
                },
              },
            ],
            [
              `m${i}_full`,
              {
                type: "noul",
                instructions: `Is manual m${i} the full owner's or user manual?`,
                criteria: {
                  true: "A complete owner's or user manual: safety, operation, care and troubleshooting.",
                  false:
                    "Only part of it: a quick start, spec sheet, parts list, installation-only sheet or warranty card.",
                },
              },
            ],
          ]),
        ),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return candidates;
    const body = (await res.json()) as { answers?: Record<string, { noul?: number }> };
    const p = (key: string) => body.answers?.[key]?.noul ?? 0;
    const scored = named
      .map((c, i) => ({ c, p: p(`m${i}`), extra: p(`m${i}_specific`) + p(`m${i}_full`) }))
      .sort((a, b) => b.p - a.p);
    let [top, next] = scored;
    if (!top || top.p < PICK_FLOOR) return candidates;
    if (next && top.p - next.p < PICK_MARGIN) {
      // Two right manuals: the more specific, complete one wins, then the one covering fewer models.
      if (next.p < PICK_FLOOR) return candidates;
      const covers = (c: Candidate) => c.models?.length ?? 1;
      if (Math.abs(top.extra - next.extra) >= PICK_MARGIN) {
        if (next.extra > top.extra) [top, next] = [next, top];
      } else if (covers(top.c) !== covers(next.c)) {
        if (covers(next.c) < covers(top.c)) [top, next] = [next, top];
      } else {
        return candidates;
      }
    }
    const winner = { ...top.c, best: true };
    return [winner, ...candidates.filter((c) => c !== top.c)];
  } catch {
    return candidates;
  }
}
