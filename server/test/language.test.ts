import { describe, expect, test } from "bun:test";
import { keepEnglish, pageLanguage } from "../src/finder/language.js";

const EN =
  "Clean the harness with a damp cloth. Do not immerse the straps in water, as this may weaken them. If the straps are frayed, contact customer service for your replacement.";
const ES =
  "Limpie el arnés con un paño húmedo. No sumerja las correas en agua, ya que esto puede debilitarlas. Si las correas están deshilachadas, comuníquese con el servicio al cliente para su reemplazo.";
const FR =
  "Nettoyez le harnais avec un chiffon humide. Ne pas immerger les sangles dans l'eau, car cela peut les affaiblir. Si les sangles sont effilochées, contactez le service client pour votre remplacement.";

const page = (n: number, content: string) => ({ page_number: n, content });

describe("pageLanguage", () => {
  test("tells English, Spanish and French apart", () => {
    expect(pageLanguage(EN).lang).toBe("en");
    expect(pageLanguage(ES).lang).toBe("es");
    expect(pageLanguage(FR).lang).toBe("fr");
  });

  test("won't guess on a parts list", () => {
    expect(pageLanguage("A-123 4x M6 screw 12 kg 30 lb").lang).toBeNull();
  });
});

describe("keepEnglish", () => {
  test("drops other-language copies of the same pages", () => {
    const pages = [page(1, EN), page(2, EN), page(3, ES), page(4, FR), page(5, "Fig. 3 A B C")];
    const { kept, dropped } = keepEnglish(pages);
    expect(kept.map((p) => p.page_number)).toEqual([1, 2, 5]);
    expect(dropped).toEqual([3, 4]);
  });

  test("keeps a bilingual page with a real share of English", () => {
    const { kept } = keepEnglish([page(1, EN), page(2, EN), page(3, `${EN}\n${ES}`)]);
    expect(kept.map((p) => p.page_number)).toEqual([1, 2, 3]);
  });

  test("keeps everything when the manual has almost no English", () => {
    const pages = [page(1, ES), page(2, ES), page(3, ES), page(4, EN)];
    expect(keepEnglish(pages)).toEqual({ kept: pages, dropped: [] });
  });
});
