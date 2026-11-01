import { describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import {
  findManual,
  isBrandHost,
  modelMatch,
  pickBest,
  rankResults,
  sameLineModels,
  searchQueries,
  searchQuery,
  squash,
  suggestModel,
  tidyTitle,
} from "../src/finder/search.js";

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

describe("model families", () => {
  test("a variant letter still matches, marked as the family", () => {
    expect(modelMatch("GSWWD09S1A09A-User-Manual.pdf", "GSWWD09S1A09B")).toBe("family");
    expect(modelMatch("Model GSWWD09S1A09B", "GSWWD09S1A09B")).toBe("exact");
  });

  test("short or different numbers don't match", () => {
    expect(modelMatch("SHPM65W55N", "SHPM65Z55N")).toBeNull();
    expect(modelMatch("XL4100", "BW-4101")).toBeNull();
    expect(modelMatch("anything", "E4")).toBeNull();
  });
});

describe("a slow maker's site", () => {
  const env = readEnv({
    SUPABASE_URL: "https://example-ref.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    SEARCH_API_KEY: "tvly_test",
  });
  const OFFICIAL =
    "https://www.galanz.com/us/wp-content/uploads/2021/01/GSWWD09S1A09A-User-Manual.pdf";
  const net = (fail: () => never) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("tavily"))
        return Response.json({
          results: [{ url: OFFICIAL, title: "GSWWD09S1A09A-User-Manual.pdf", score: 0.64 }],
        });
      return fail();
    }) as unknown as typeof fetch;

  test("keeps the maker's PDF when only the download timed out", async () => {
    const found = await findManual(
      env,
      { brand: "Galanz", model: "GSWWD09S1A09B" },
      net(() => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }),
    );
    expect(found.candidates).toEqual([
      expect.objectContaining({ url: OFFICIAL, official: true, named: true, unchecked: true }),
    ]);
  });

  test("drops it when the site gives a definite no", async () => {
    const found = await findManual(env, { brand: "Galanz", model: "GSWWD09S1A09B" }, (async (
      input: RequestInfo | URL,
    ) =>
      String(input).includes("tavily")
        ? Response.json({ results: [{ url: OFFICIAL, title: "manual", score: 0.6 }] })
        : new Response("gone", { status: 404 })) as unknown as typeof fetch);
    expect(found.candidates).toEqual([]);
    expect(found.tried[0]?.problem).toContain("404");
  });
});

describe("misread model numbers", () => {
  test("S read as 5 still finds the manual, flagged as a lookalike", () => {
    expect(modelMatch("GSWWD09S1A09A-User-Manual.pdf", "GSWWD0951A09B")).toBe("lookalike");
    expect(modelMatch("Model GSWWD09S1A09B", "GSWWD0951A09B")).toBe("lookalike");
    expect(modelMatch("GSWWD12S1SA10A-User-Manual.pdf", "GSWWD0951A09B")).toBeNull();
  });

  test("runs a plainer second query with what the thing is", () => {
    expect(
      searchQueries({ brand: "Galanz", model: "GSWWD0951A09B", nickname: "Microwave" }),
    ).toEqual(["Galanz GSWWD0951A09B owner's manual pdf", "Galanz GSWWD0951A09B Microwave manual"]);
    expect(searchQueries({ brand: "Galanz", nickname: "Microwave" })).toHaveLength(1);
  });
});

describe("suggestModel", () => {
  test("re-spells a misread model the way the maker prints it", () => {
    expect(suggestModel("GSWWD09S1A09B Microwave", "GSWWD0951A09B")).toBe("GSWWD09S1A09B");
    // Family match: the PDF is for the A variant, the saved letter B stays.
    expect(suggestModel("/uploads/GSWWD09S1A09A-User-Manual.pdf", "GSWWD0951A09B")).toBe(
      "GSWWD09S1A09B",
    );
  });

  test("says nothing when the spelling already matches or the model isn't there", () => {
    expect(suggestModel("GSWWD09S1A09B", "GSWWD09S1A09B")).toBeNull();
    expect(suggestModel("GSWWD12S1SA10A-User-Manual.pdf", "GSWWD0951A09B")).toBeNull();
    expect(suggestModel("E4 error", "E4")).toBeNull();
  });

  test("ranking carries the hint from the link", () => {
    const [c] = rankResults(
      [
        {
          url: "https://www.galanz.com/us/wp-content/uploads/2021/01/GSWWD09S1A09A-User-Manual.pdf",
          title: "",
          score: 0.5,
        },
      ],
      { brand: "Galanz", model: "GSWWD0951A09B" },
    );
    expect(c?.model_hint).toBe("GSWWD09S1A09B");
  });
});

describe("tidyTitle", () => {
  test("drops the work file's extension and calms all-caps", () => {
    expect(tidyTitle("PORTABLE PD_USER MANUAL TOSHIBA US (06-19_RT).indd")).toBe(
      "Portable PD User Manual Toshiba US (06-19 RT)",
    );
    expect(tidyTitle("LG Washer Owner's Manual")).toBe("LG Washer Owner's Manual");
  });
});

describe("narrowing the options", () => {
  const jevEnv = readEnv({
    SUPABASE_URL: "https://example-ref.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    JEV_API_KEY: "jev_test",
  });
  const item = { brand: "Toshiba", nickname: "Air Conditioner", model: "RAC-PD0811CRU" };
  const cand = (title: string, excerpt: string) => ({
    url: `https://example.com/${title}.pdf`,
    title,
    host: "example.com",
    official: false,
    named: false,
    has_model: true,
    excerpt,
  });
  const jev = (scores: number[]) =>
    (async () =>
      Response.json({
        answers: Object.fromEntries(scores.map((noul, i) => [`m${i}`, { noul }])),
      })) as unknown as typeof fetch;

  test("lists the other models of the same line a manual covers", () => {
    expect(
      sameLineModels("Models RAC-PD0811CRU, RAC-PD1011CRU and RAC-PD1411CRU-B", item.model),
    ).toEqual(["RAC-PD0811CRU", "RAC-PD1011CRU", "RAC-PD1411CRU-B"]);
  });

  test("Jev's clear pick is marked best and moved first", async () => {
    const list = [cand("P14", "14,000 BTU"), cand("P08", "8,000 BTU")];
    const out = await pickBest(jevEnv, item, list, jev([0.2, 0.9]));
    expect(out[0]?.title).toBe("P08");
    expect(out[0]?.best).toBe(true);
    expect(out[1]?.best).toBeUndefined();
  });

  test("a close call leaves the order alone", async () => {
    const list = [cand("A", "a"), cand("B", "b")];
    const out = await pickBest(jevEnv, item, list, jev([0.7, 0.65]));
    expect(out.map((c) => c.title)).toEqual(["A", "B"]);
    expect(out.some((c) => c.best)).toBe(false);
  });
});
