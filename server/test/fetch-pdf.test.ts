import { describe, expect, test } from "bun:test";
import {
  checkPublicHttpsUrl,
  FetchPdfError,
  fetchPdf,
  looksLikePdf,
  SiteBlockedError,
} from "../src/finder/fetch-pdf.js";

const PDF = new TextEncoder().encode("%PDF-1.4\n%fake\n");

describe("PDF fetcher", () => {
  test.each([
    "http://example.com/manual.pdf",
    "https://127.0.0.1/manual.pdf",
    "https://localhost/manual.pdf",
    "https://[::1]/manual.pdf",
    "https://printer.local/manual.pdf",
    "https://user:pw@example.com/manual.pdf",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => checkPublicHttpsUrl(url)).toThrow(FetchPdfError);
  });

  test("follows a redirect to a PDF", async () => {
    const calls: string[] = [];
    const fake = (async (url: URL | string) => {
      calls.push(String(url));
      if (String(url).endsWith("/go")) {
        return new Response(null, { status: 302, headers: { location: "/files/manual.pdf" } });
      }
      return new Response(PDF, { headers: { "content-type": "application/pdf" } });
    }) as typeof fetch;
    const { bytes, finalUrl } = await fetchPdf("https://maker.example.com/go", fake);
    expect(looksLikePdf(bytes)).toBe(true);
    expect(finalUrl).toBe("https://maker.example.com/files/manual.pdf");
    expect(calls).toHaveLength(2);
  });

  test("won't follow a redirect to a private host", async () => {
    const fake = (async () =>
      new Response(null, {
        status: 301,
        headers: { location: "https://10.0.0.5/secret.pdf" },
      })) as unknown as typeof fetch;
    expect(fetchPdf("https://maker.example.com/go", fake)).rejects.toThrow(FetchPdfError);
  });

  test("says when a link is a web page, not a PDF", async () => {
    const fake = (async () => new Response("<html>support</html>")) as unknown as typeof fetch;
    expect(fetchPdf("https://maker.example.com/support", fake)).rejects.toThrow("isn't a PDF");
  });

  test("a site that never starts answering ends quickly, as one that may block apps", async () => {
    // whirlpool.com with our user agent: no answer at all, however long we wait.
    const hang = ((_u: URL, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted")));
      })) as unknown as typeof fetch;
    const started = Date.now();
    const err = await fetchPdf("https://www.whirlpool.com/manual.pdf", hang, 5_000, 50).catch(
      (e) => e,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(err).toBeInstanceOf(SiteBlockedError);
    expect(err.why).toBe("silent");
    expect(err.host).toBe("www.whirlpool.com");
    expect(err.message).toBe(
      "whirlpool.com didn't answer. It may not let apps download its manuals.",
    );
  });

  test.each([401, 403, 429])("a %i says the site won't let apps download", async (status) => {
    const no = (async () => new Response("Access Denied", { status })) as unknown as typeof fetch;
    const err = await fetchPdf("https://www.whirlpool.com/manual.pdf", no).catch((e) => e);
    expect(err).toBeInstanceOf(SiteBlockedError);
    expect(err.why).toBe("refused");
    expect(err.message).toBe("whirlpool.com won't let apps download its manuals.");
  });

  test("a site that answers at once but sends the PDF slowly isn't cut off", async () => {
    const trickle = (async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            await new Promise((r) => setTimeout(r, 120));
            controller.enqueue(PDF);
            controller.close();
          },
        }),
      )) as unknown as typeof fetch;
    const { bytes } = await fetchPdf("https://slow.example.com/m.pdf", trickle, 5_000, 50);
    expect(looksLikePdf(bytes)).toBe(true);
  });

  test("asks like a browser for the PDF, under its own name", async () => {
    let headers: Record<string, string> = {};
    const fake = (async (_u: URL, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(PDF);
    }) as unknown as typeof fetch;
    await fetchPdf("https://maker.example.com/m.pdf", fake);
    expect(headers.accept).toContain("application/pdf");
    expect(headers.accept).toContain("text/html");
    expect(headers["accept-language"]).toContain("en");
    expect(headers["user-agent"]).toStartWith("manuals-mcp/");
  });
});
