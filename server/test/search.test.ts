import { describe, expect, test } from "bun:test";
import { isBrandHost, rankResults, searchQuery, squash } from "../src/finder/search.js";

// Shapes from real Tavily answers, 2026-10-28.
const RESULTS = [
  {
    url: "https://www.manua.ls/bosch/shpm65z55n/manual",
    title: "User manual Bosch SHPM65Z55N",
    score: 0.94,
  },
  {
    url: "https://removeandreplace.com/wp-content/uploads/2022/05/Bosch-SHPM65Z55N.pdf",
    title: "Bosch-SHPM65Z55N.pdf",
    score: 0.82,
  },
  {
    url: "https://www.bosch-home.com/us/en/product/SHPM65Z55N",
    title: "SHPM65Z55N Dishwasher | BOSCH US",
    score: 0.72,
  },
  {
    url: "https://media3.bosch-home.com/Documents/9001238233_A.pdf",
    title: "Dishwasher SHPM65W55N SHPM65W52N",
    score: 0.59,
  },
  { url: "https://www.youtube.com/watch?v=abc.pdf", title: "Video", score: 0.5 },
  { url: "http://example.com/old.pdf", title: "Plain http", score: 0.4 },
];

describe("finding manuals", () => {
  test("keeps only https PDF links, the maker's first", () => {
    const ranked = rankResults(RESULTS, { brand: "Bosch", model: "SHPM65Z55N" });
    expect(ranked.map((c) => c.host)).toEqual(["media3.bosch-home.com", "removeandreplace.com"]);
    expect(ranked[0]).toMatchObject({ official: true, named: false });
    expect(ranked[1]).toMatchObject({ official: false, named: true });
  });

  test("knows the maker's hosts", () => {
    expect(isBrandHost("download.gracobaby.com", "Graco")).toBe(true);
    expect(isBrandHost("www.whirlpool.com", "Whirlpool")).toBe(true);
    expect(isBrandHost("images.thdstatic.com", "LG")).toBe(false);
    expect(isBrandHost("lg.example.com", "")).toBe(false);
  });

  test("matches model numbers however they're written", () => {
    expect(squash("WTW-5000 DW")).toBe(squash("wtw5000dw"));
    expect(searchQuery({ brand: "LG", model: "WM4000HWA" })).toBe(
      "LG WM4000HWA owner's manual pdf",
    );
    expect(searchQuery({ nickname: "Car seat", brand: "Graco" })).toBe(
      "Graco Car seat owner's manual pdf",
    );
  });
});
