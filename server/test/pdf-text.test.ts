import { expect, test } from "bun:test";
import { pdfPages } from "../src/finder/pdf-text.js";
import { tinyPdf } from "./helpers.js";

test("extracts text page by page", async () => {
  const { pageCount, pages } = await pdfPages(
    tinyPdf(["Rinse the filter every 2 weeks.", "Error UE means the load is unbalanced."]),
  );
  expect(pageCount).toBe(2);
  expect(pages[0]?.content).toContain("Rinse the filter");
  expect(pages[1]?.page_number).toBe(2);
  expect(pages[1]?.content).toContain("Error UE");
});
