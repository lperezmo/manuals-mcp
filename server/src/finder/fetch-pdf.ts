// Fetches a manual PDF from a URL the user's AI found. Only public https
// hosts, a few redirects, and a size cap: this runs on our server with a
// URL that came out of a chat.

export const MAX_PDF_BYTES = 40 * 1024 * 1024;
const MAX_REDIRECTS = 4;

export class FetchPdfError extends Error {}

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

export async function fetchPdf(
  raw: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<{ bytes: Uint8Array; finalUrl: string }> {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = checkPublicHttpsUrl(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(url, {
      redirect: "manual",
      headers: {
        accept: "application/pdf,*/*;q=0.5",
        "user-agent": "manuals-mcp/0.1 (+manual fetcher)",
      },
      signal,
    });
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
      throw new FetchPdfError(
        "That link isn't a PDF. It may be a support page; look for the PDF link on it.",
      );
    }
    return { bytes, finalUrl: url.toString() };
  }
  throw new FetchPdfError("Too many redirects.");
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
