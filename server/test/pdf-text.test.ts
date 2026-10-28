import { expect, test } from "bun:test";
import { pdfPages } from "../src/finder/pdf-text.js";

/** Builds a tiny two-page PDF with real xref offsets. */
function tinyPdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test("extracts text page by page", async () => {
  const { pageCount, pages } = await pdfPages(
    tinyPdf(["Rinse the filter every 2 weeks.", "Error UE means the load is unbalanced."]),
  );
  expect(pageCount).toBe(2);
  expect(pages[0]?.content).toContain("Rinse the filter");
  expect(pages[1]?.page_number).toBe(2);
  expect(pages[1]?.content).toContain("Error UE");
});
