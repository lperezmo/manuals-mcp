import { describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { SiteBlockedError } from "../src/finder/fetch-pdf.js";
import {
  blockedMessage,
  checkCandidate,
  choosePages,
  findManual,
  isBrandHost,
  isSheet,
  modelMatch,
  pagesWorthOpening,
  pdfLinksFromPages,
  pickBest,
  rankResults,
  sameLineModels,
  searchQueries,
  searchQuery,
  searchWeb,
  squash,
  suggestModel,
  tidyTitle,
} from "../src/finder/search.js";
import { tinyPdf } from "./helpers.js";

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

  test("a tie between two right manuals goes to the one covering fewer models", async () => {
    const wide = { ...cand("P08", "x"), models: ["A1", "A2", "A3", "A4", "A5", "A6"] };
    const narrow = { ...cand("RT", "y"), models: ["A1", "A2", "A3", "A4", "A5"] };
    const out = await pickBest(jevEnv, item, [wide, narrow], jev([0.9, 0.9]));
    expect(out[0]?.title).toBe("RT");
    expect(out[0]?.best).toBe(true);
  });

  test("a tie on the model goes to the more specific, complete manual", async () => {
    const list = [cand("Series", "x"), cand("Own", "y")];
    const answers = (async () =>
      Response.json({
        answers: {
          m0: { noul: 0.9 },
          m0_specific: { noul: 0.2 },
          m0_full: { noul: 0.9 },
          m1: { noul: 0.9 },
          m1_specific: { noul: 0.9 },
          m1_full: { noul: 0.9 },
        },
      })) as unknown as typeof fetch;
    const out = await pickBest(jevEnv, item, list, answers);
    expect(out[0]?.title).toBe("Own");
    expect(out[0]?.best).toBe(true);
  });

  test("Jev chooses which pages to crawl, at most two it believes in", async () => {
    let asked = 0;
    const answers = (async (_u: string, init: RequestInit) => {
      asked = Object.keys(JSON.parse(String(init.body)).questions).length;
      return Response.json({
        answers: { p0: { noul: 0.1 }, p1: { noul: 0.8 }, p2: { noul: 0.6 }, p3: { noul: 0.7 } },
      });
    }) as unknown as typeof fetch;
    const pages = await choosePages(
      jevEnv,
      item,
      [
        { url: "https://forum.example.com/ac", title: "Forum", score: 0.9 },
        { url: "https://www.toshiba-lifestyle.com/us/ac", title: "Toshiba AC", score: 0.8 },
        { url: "https://store.example.com/ac", title: "Store", score: 0.7 },
        { url: "https://www.toshiba-lifestyle.com/support", title: "Support", score: 0.6 },
        { url: "https://manuals.plus/toshiba/ac", title: "Listing", score: 1 },
        { url: "https://x.example.com/m.pdf", title: "PDF", score: 1 },
      ],
      answers,
    );
    expect(asked).toBe(4);
    expect(pages.map((r) => r.title)).toEqual(["Toshiba AC", "Support"]);
  });

  test("without Jev, the maker's and model-named pages are crawled", async () => {
    const noJev = readEnv({
      SUPABASE_URL: "https://example-ref.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    });
    const pages = await choosePages(noJev, item, [
      { url: "https://forum.example.com/ac", title: "Forum", score: 0.9 },
      { url: "https://www.toshiba-lifestyle.com/us/ac", title: "Toshiba AC", score: 0.8 },
    ]);
    expect(pages.map((r) => r.title)).toEqual(["Toshiba AC"]);
  });

  test("a close call leaves the order alone", async () => {
    const list = [cand("A", "a"), cand("B", "b")];
    const out = await pickBest(jevEnv, item, list, jev([0.7, 0.65]));
    expect(out.map((c) => c.title)).toEqual(["A", "B"]);
    expect(out.some((c) => c.best)).toBe(false);
  });
});

describe("searchWeb", () => {
  const base = {
    SUPABASE_URL: "https://example-ref.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    SEARXNG_URL: "https://search.example.com/",
    SEARXNG_ACCESS_ID: "id.access",
    SEARXNG_ACCESS_SECRET: "secret",
  };
  const answer = (searx: Response) => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.startsWith("https://search.example.com")) return searx.clone();
      return Response.json({
        results: [{ url: "https://t.example/a.pdf", title: "T", score: 0.9 }],
      });
    }) as unknown as typeof fetch;
    return { calls, impl };
  };
  const SEARX = Response.json({
    results: [
      { url: "https://a.example/one.pdf", title: "One" },
      { url: "https://b.example/two.pdf", title: "Two" },
    ],
  });

  test("asks SearXNG first, through Cloudflare Access, and ranks by position", async () => {
    const { calls, impl } = answer(SEARX);
    const out = await searchWeb(readEnv({ ...base, SEARCH_API_KEY: "tvly" }), "lg manual", impl);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://search.example.com/search?q=lg+manual&format=json");
    expect(calls[0]?.headers["CF-Access-Client-Id"]).toBe("id.access");
    expect(out.map((r) => r.score)).toEqual([1, 0.5]);
  });

  test("falls back to Tavily when SearXNG is blocked or finds nothing", async () => {
    for (const searx of [new Response("no", { status: 403 }), Response.json({ results: [] })]) {
      const { calls, impl } = answer(searx);
      const out = await searchWeb(readEnv({ ...base, SEARCH_API_KEY: "tvly" }), "lg", impl);
      expect(calls.map((c) => new URL(c.url).hostname)).toEqual([
        "search.example.com",
        "api.tavily.com",
      ]);
      expect(out[0]?.url).toBe("https://t.example/a.pdf");
    }
  });

  test("without Tavily, a SearXNG failure is the error", async () => {
    const { impl } = answer(new Response("no", { status: 403 }));
    await expect(searchWeb(readEnv(base), "lg", impl)).rejects.toThrow("403");
  });
});

describe("opening a maker's page for its PDF links", () => {
  const crawl = {
    baseUrl: "https://cr.example.com",
    token: "tok",
    accessId: "id",
    accessSecret: "s",
  };
  const item = { brand: "Toshiba", model: "RAC-PD0811CRU" };

  test("only the maker's pages or ones naming the model, never PDFs or listing sites", () => {
    const picked = pagesWorthOpening(
      [
        { url: "https://www.toshiba-lifestyle.com/us/support/ac", title: "Support", score: 0.5 },
        { url: "https://shop.example.com/rac-pd0811cru", title: "Buy it", score: 0.9 },
        { url: "https://www.toshiba-lifestyle.com/m.pdf", title: "PDF", score: 1 },
        { url: "https://www.manualslib.com/x/RAC-PD0811CRU.html", title: "x", score: 1 },
        { url: "https://blog.example.com/ac-tips", title: "Tips", score: 1 },
      ],
      item,
    );
    expect(picked.map((r) => r.url)).toEqual([
      "https://shop.example.com/rac-pd0811cru",
      "https://www.toshiba-lifestyle.com/us/support/ac",
    ]);
  });

  test("keeps the PDF links on the page, scored just under it", async () => {
    let sent: { headers: Record<string, string>; body: string } | undefined;
    const impl = (async (_u: string, init: RequestInit) => {
      sent = { headers: init.headers as Record<string, string>, body: String(init.body) };
      return Response.json({
        results: [
          {
            url: "https://www.toshiba-lifestyle.com/us/ac",
            links: {
              internal: [
                { href: "/files/RAC-PD0811CRU-manual.pdf", text: "Owner's Manual" },
                { href: "/us/contact", text: "Contact" },
              ],
              external: [{ href: "http://insecure.example/m.pdf", text: "old" }],
            },
          },
        ],
      });
    }) as unknown as typeof fetch;
    const out = await pdfLinksFromPages(
      crawl,
      [{ url: "https://www.toshiba-lifestyle.com/us/ac", title: "AC", score: 0.8 }],
      impl,
    );
    expect(sent?.headers.authorization).toBe("Bearer tok");
    expect(sent?.headers["CF-Access-Client-Id"]).toBe("id");
    expect(out).toEqual([
      {
        url: "https://www.toshiba-lifestyle.com/files/RAC-PD0811CRU-manual.pdf",
        title: "Owner's Manual",
        score: 0.79,
      },
    ]);
  });

  test("a crawler that's down finds nothing instead of failing the search", async () => {
    const down = (async () => new Response("no", { status: 502 })) as unknown as typeof fetch;
    const page = { url: "https://www.toshiba-lifestyle.com/us/ac", title: "AC", score: 1 };
    expect(await pdfLinksFromPages(crawl, [page], down)).toEqual([]);
  });
});

describe("the pick without asking Jev", () => {
  test("the only PDF that prints the model is the best match", async () => {
    const env = readEnv({
      SUPABASE_URL: "https://example-ref.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    });
    const c = (title: string, has_model: boolean) => ({
      url: `https://e.example/${title}.pdf`,
      title,
      host: "e.example",
      official: false,
      named: false,
      has_model,
      match: has_model ? ("exact" as const) : undefined,
      excerpt: "text",
    });
    const out = await pickBest(env, { model: "RAC-PD0811CRU" }, [c("P14", false), c("P08", true)]);
    expect(out.map((x) => [x.title, x.best ?? false])).toEqual([
      ["P08", true],
      ["P14", false],
    ]);
  });

  test("listing sites aren't opened with the crawler", () => {
    const picked = pagesWorthOpening(
      [
        {
          url: "https://manuals.plus/toshiba/rac-pd0811cru-manual",
          title: "RAC-PD0811CRU",
          score: 1,
        },
      ],
      { brand: "Toshiba", model: "RAC-PD0811CRU" },
    );
    expect(picked).toEqual([]);
  });
});

describe("sheets that aren't the manual", () => {
  test.each([
    "55 dBA Front Control Dishwasher WDF330PAH Key Features & Benefits",
    "/content/dam/global/documents/202001/specification-sheet-wdf330pahspecsheetv01.pdf",
    "/pdf/whirlpool/dishwasher/WDF330PAHS_quick-specs.pdf",
    "/pdf/whirlpool/dishwasher/WDF330PAHS_energy-guide.pdf",
    "Dimension Guide (WDF330PAHS_dimension-guide.pdf)",
    "Installation Instructions",
  ])("%s is a sheet", (text) => {
    expect(isSheet(text)).toBe(true);
  });

  test.each([
    "Dishwasher User Instructions - Owner's Manual",
    "/pdf/whirlpool/dishwasher/WDF330PAHS_owners-manual.pdf",
    "Installation Instructions and Use & Care Guide",
    "GSWWD09S1A09A-User-Manual.pdf",
  ])("%s is a manual", (text) => {
    expect(isSheet(text)).toBe(false);
  });

  test("a spec sheet naming the model ranks below the maker's manual that doesn't", () => {
    const ranked = rankResults(
      [
        {
          url: "https://www.whirlpool.com/content/dam/global/documents/202001/specification-sheet-wdf330pahspecsheetv01.pdf",
          title: "55 dBA Front Control Dishwasher WDF330PAH Key Features & Benefits",
          score: 0.9,
        },
        {
          url: "https://www.whirlpool.com/content/dam/global/documents/201508/owners-manual-W10717214-RevA.pdf",
          title: "Dishwasher User Instructions - Owner's Manual",
          score: 0.5,
        },
      ],
      { brand: "Whirlpool", model: "WDF330PAHS" },
    );
    expect(ranked.map((c) => [c.url.split("/").pop(), c.sheet ?? false])).toEqual([
      ["owners-manual-W10717214-RevA.pdf", false],
      ["specification-sheet-wdf330pahspecsheetv01.pdf", true],
    ]);
  });

  test("a one-page PDF that reads like a spec sheet is one, whatever its link says", async () => {
    const site = (async () =>
      new Response(
        tinyPdf(["WDF330PAHS Key Features and Benefits. Dimensions 24 in."]),
      )) as unknown as typeof fetch;
    const c = await checkCandidate(
      {
        url: "https://shop.example.com/d/WDF330PAHS.pdf",
        title: "",
        host: "shop.example.com",
        official: false,
        named: true,
      },
      "WDF330PAHS",
      site,
    );
    expect(c.has_model).toBe(true);
    expect(c.sheet).toBe(true);
  });
});

describe("a maker's site that blocks apps", () => {
  const env = readEnv({
    SUPABASE_URL: "https://example-ref.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    SEARCH_API_KEY: "tvly_test",
    CRAWL4AI_URL: "https://cr.example.com",
    CRAWL4AI_API_TOKEN: "tok",
  });
  const item = { brand: "Whirlpool", model: "WDF330PAHS", nickname: "Dishwasher" };
  const DOCS = "https://www.whirlpool.com/content/dam/global/documents";
  const SHEET = `${DOCS}/202001/specification-sheet-wdf330pahspecsheetv01.pdf`;
  const MIRROR = "https://www.canadianappliance.ca/pdf/whirlpool/dishwasher";
  const RETAILER =
    "https://www.canadianappliance.ca/product/Whirlpool_WDF330PAHS_Dishwasher_Whirlpool_WDF330PAHS.html";
  // Shapes from a real search for this model, 2026-11-01: every PDF is on whirlpool.com.
  const RESULTS = [
    {
      url: SHEET,
      title: "55 dBA Front Control Dishwasher WDF330PAH Key Features & Benefits",
      score: 0.9,
    },
    {
      url: `${DOCS}/201508/owners-manual-W10717214-RevA.pdf`,
      title: "Dishwasher User Instructions - Owner's Manual",
      score: 0.8,
    },
    {
      url: `${DOCS}/201701/owners-manual-W10903644-RevA.pdf`,
      title: "Dishwasher User Instructions - Owner's Manual",
      score: 0.6,
    },
    {
      url: "https://www.whirlpool.com/owners-center-pdp.WDF330PAHS.html",
      title: "WDF330PAHS - Whirlpool",
      score: 1,
    },
    { url: RETAILER, title: "Whirlpool WDF330PAHS - Dishwashers", score: 0.2 },
  ];
  const net = (crawl: (body: string) => Response) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("tavily")) return Response.json({ results: RESULTS });
      if (url.startsWith("https://cr.example.com")) return crawl(String(init?.body));
      if (url.includes("whirlpool.com")) return new Response("Access Denied", { status: 403 });
      if (url.endsWith("_owners-manual.pdf"))
        return new Response(
          tinyPdf(["DISHWASHER USER INSTRUCTIONS", "Load the racks", "Clean the filter"]),
        );
      if (url.endsWith("_quick-specs.pdf"))
        return new Response(tinyPdf(["WDF330PAHS Quick Specs. Dimensions 24 in."]));
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

  test("looks for a copy elsewhere, and offers it instead of the spec sheet", async () => {
    const crawled: string[] = [];
    const impl = net((body) => {
      crawled.push(body);
      return Response.json({
        results: [
          {
            url: RETAILER,
            links: {
              internal: [
                { href: `${MIRROR}/WDF330PAHS_quick-specs.pdf`, text: "Quick Specs" },
                { href: `${MIRROR}/WDF330PAHS_owners-manual.pdf`, text: "Owner's Manual" },
              ],
            },
          },
        ],
      });
    });
    const found = await findManual(env, item, impl);
    expect(found.candidates.map((c) => c.url)).toEqual([`${MIRROR}/WDF330PAHS_owners-manual.pdf`]);
    expect(found.candidates[0]).toMatchObject({ named: true, has_model: false, page_count: 3 });
    // The crawler is never sent to the site that turned us away.
    expect(crawled).toHaveLength(1);
    expect(crawled[0]).toContain("canadianappliance.ca");
    expect(crawled[0]).not.toContain("whirlpool.com");
    // The maker's PDFs were tried and marked as turned away, for the log.
    expect(found.tried.filter((c) => c.blocked).map((c) => c.host)).toEqual([
      "www.whirlpool.com",
      "www.whirlpool.com",
      "www.whirlpool.com",
    ]);
    expect(found.tried.some((c) => c.url.endsWith("_quick-specs.pdf") && c.sheet)).toBe(true);
  });

  test("with no copy elsewhere, the maker's link stays, marked as turned away", async () => {
    const found = await findManual(
      env,
      item,
      net(() => new Response("down", { status: 502 })),
    );
    expect(found.candidates).toEqual([
      expect.objectContaining({
        url: SHEET,
        official: true,
        blocked: true,
        unchecked: true,
        sheet: true,
      }),
    ]);
  });

  test("a site that never answers is marked turned away too", async () => {
    const hang = ((_u: URL, init: RequestInit) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted")));
      })) as unknown as typeof fetch;
    const c = await checkCandidate(
      { url: SHEET, title: "sheet", host: "www.whirlpool.com", official: true, named: true },
      "WDF330PAHS",
      hang,
      5_000,
      50,
    );
    expect(c).toMatchObject({ blocked: true, unchecked: true });
  });

  test("the message names the maker and says what to do", () => {
    expect(blockedMessage(new SiteBlockedError("www.whirlpool.com", "refused"), "Whirlpool")).toBe(
      "Whirlpool's site won't let apps download its manuals. Tap Open, save the PDF on your phone, then add it with Upload a PDF.",
    );
    expect(
      blockedMessage(new SiteBlockedError("www.mirror.example", "silent"), "Whirlpool"),
    ).toStartWith("Mirror.example didn't answer.");
  });
});
