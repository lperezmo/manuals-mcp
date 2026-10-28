import { extractText, getDocumentProxy } from "unpdf";

export interface PageText {
  page_number: number;
  content: string;
}

/**
 * Pulls the text layer out of a PDF, one entry per page. Scanned manuals
 * have no text layer; those come back empty and need a model to read them.
 */
export async function pdfPages(
  bytes: Uint8Array,
): Promise<{ pageCount: number; pages: PageText[] }> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = text
    .map((content, i) => ({ page_number: i + 1, content: cleanText(content) }))
    .filter((p) => p.content.length > 0);
  return { pageCount: totalPages, pages };
}

export function cleanText(raw: string): string {
  return raw
    .replaceAll("\u0000", "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
