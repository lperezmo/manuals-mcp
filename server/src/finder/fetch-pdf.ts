// Fetches a manual PDF from a URL the user's AI found. Only public https
// hosts, a few redirects, and a size cap: this runs on our server with a
// URL that came out of a chat.

export const MAX_PDF_BYTES = 40 * 1024 * 1024;
const MAX_REDIRECTS = 4;

export class FetchPdfError extends Error {}

/**
 * The site turned us away (401, 403, 429) or never started answering. Some
 * makers' sites block apps outright (whirlpool.com hangs, then answers 403 to
 * a browser), so waiting or retrying won't help: the person has to open the
 * link and save the PDF themselves. We don't try to get around it.
 */
export class SiteBlockedError extends FetchPdfError {
  constructor(
    readonly host: string,
    readonly why: "refused" | "silent",
  ) {
    super(blockedSentence(host.replace(/^www\./, ""), why));
  }
}

/** "whirlpool.com won't let apps download its manuals.", or the brand's name in place of the host. */
export function blockedSentence(site: string, why: "refused" | "silent"): string {
  return why === "refused"
    ? `${site} won't let apps download its manuals.`
    : `${site} didn't answer. It may not let apps download its manuals.`;
}

const REFUSED = new Set([401, 403, 429]);

export function checkPublicHttpsUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchPdfError("That isn't a valid link.");
  }
  if (url.protocol !== "https:") throw new FetchPdfError("Only https links are fetched.");
  if (url.username || url.password)
    throw new FetchPdfError("Links with credentials aren't fetched.");
  const host = url.hostname.toLowerCase();
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":");
  if (
    isIp ||
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  ) {
    throw new FetchPdfError("Only public web hosts are fetched.");
  }
  return url;
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  // "%PDF-" may follow a little junk; the spec allows it within the first 1 KB.
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  return head.includes("%PDF-");
}

/** Quick check of a search result. Attaching a manual waits longer: some makers' sites are slow. */
export const CHECK_TIMEOUT_MS = 25_000;
export const ATTACH_TIMEOUT_MS = 50_000;
/** The website's two-step attach: the download has its own call, so it can wait longest. */
export const ATTACH_DOWNLOAD_MS = 120_000;
/**
 * A site that hasn't started answering by now is turning us away, not slow:
 * slow sites send headers quickly and then trickle the PDF. The search's check
 * waits less, so it has time to look for a copy elsewhere.
 */
export const FIRST_BYTE_MS = 15_000;
export const CHECK_FIRST_BYTE_MS = 10_000;

/** What a browser asks for. The user agent stays honest. */
const HEADERS = {
  accept: "application/pdf,text/html;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent": "manuals-mcp/0.1 (+manual fetcher)",
};

export async function fetchPdf(
  raw: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CHECK_TIMEOUT_MS,
  firstByteMs = FIRST_BYTE_MS,
): Promise<{ bytes: Uint8Array; finalUrl: string }> {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = checkPublicHttpsUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await headersWithin(fetchImpl, url, signal, Math.min(firstByteMs, timeoutMs));
    if (REFUSED.has(res.status)) {
      await res.body?.cancel().catch(() => {});
      throw new SiteBlockedError(url.hostname, "refused");
    }
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get("location");
      if (!next) throw new FetchPdfError("The link redirected nowhere.");
      url = checkPublicHttpsUrl(new URL(next, url).toString());
      continue;
    }
    if (!res.ok) throw new FetchPdfError(`The site answered ${res.status}.`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_PDF_BYTES) throw new FetchPdfError("That PDF is too big (over 40 MB).");
    const bytes = await readCapped(res, MAX_PDF_BYTES);
    if (!looksLikePdf(bytes)) {
      // Some sites answer an app with a quick "Access Denied" or robot check page instead of a 403.
      if (looksLikeBotWall(bytes)) throw new SiteBlockedError(url.hostname, "refused");
      throw new FetchPdfError(
        "That link isn't a PDF. It may be a support page; look for the PDF link on it.",
      );
    }
    return { bytes, finalUrl: url.toString() };
  }
  throw new FetchPdfError("Too many redirects.");
}

const BOT_WALL =
  /access denied|request (was )?blocked|you have been blocked|are you a (human|robot)|captcha|attention required|just a moment\.\.\.|unusual traffic|errors\.edgesuite\.net/i;

/** A short web page that says the site turned us away (Akamai, Cloudflare and the like). */
export function looksLikeBotWall(bytes: Uint8Array): boolean {
  if (bytes.byteLength > 200_000) return false;
  return BOT_WALL.test(new TextDecoder("latin1").decode(bytes.subarray(0, 8_000)));
}

/** One request whose headers must arrive within `ms`; the body may take longer. */
async function headersWithin(
  fetchImpl: typeof fetch,
  url: URL,
  signal: AbortSignal,
  ms: number,
): Promise<Response> {
  const quiet = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silent = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Rejected first, so the race ends with this and not with the aborted request.
      reject(new SiteBlockedError(url.hostname, "silent"));
      quiet.abort();
    }, ms);
  });
  try {
    return await Promise.race([
      fetchImpl(url, {
        redirect: "manual",
        headers: HEADERS,
        signal: AbortSignal.any([signal, quiet.signal]),
      }),
      silent,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new FetchPdfError("That PDF is too big (over 40 MB).");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
