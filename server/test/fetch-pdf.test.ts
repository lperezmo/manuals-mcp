import { describe, expect, test } from "bun:test";
import {
  checkPublicHttpsUrl,
  FetchPdfError,
  fetchPdf,
  looksLikePdf,
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
});
