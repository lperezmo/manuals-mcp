import { describe, expect, test } from "bun:test";
import { anyWords } from "../src/tools/ask-manual.js";

describe("anyWords", () => {
  test("drops filler and joins the rest with or", () => {
    expect(anyWords("where is the overfill float location")).toBe("overfill or float");
    expect(anyWords("How do I remove the upper filter?")).toBe("remove or upper or filter");
  });
  test("one word, or none, needs no second search", () => {
    expect(anyWords("E4")).toBeNull();
    expect(anyWords("where is it")).toBeNull();
  });
});

import { readEnv } from "../src/env.js";
import { fixQuery, synonymFor } from "../src/tools/ask-manual.js";

describe("fixQuery", () => {
  test("swaps misspelled words for the manual's own", () => {
    expect(
      fixQuery(
        ["overfil", "flote"],
        [
          { word: "overfil", closest: "overfill", edits: 1 },
          { word: "overfil", closest: "overflow", edits: 3 },
          { word: "flote", closest: "float", edits: 2 },
          { word: "flote", closest: "flat", edits: 2 },
        ],
      ),
    ).toEqual({
      query: "overfill float",
      note: 'Read "overfil" as "overfill", "flote" as "float".',
    });
  });
  test("a tie between look-alikes tries both", () => {
    expect(
      fixQuery(
        ["cup", "filtr"],
        [
          { word: "cup", closest: "cup", edits: 0 },
          { word: "filtr", closest: "filtre", edits: 1 },
          { word: "filtr", closest: "filter", edits: 1 },
        ],
      )?.query,
    ).toBe("cup or filtre or filter");
  });
  test("words already in the manual, or nothing close, need no fix", () => {
    expect(fixQuery(["spray"], [{ word: "spray", closest: "spray", edits: 0 }])).toBeNull();
    expect(fixQuery(["zzzz"], [{ word: "zzzz", closest: "zone", edits: 3 }])).toBeNull();
  });
});

describe("synonymFor", () => {
  const env = readEnv({
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "x",
    JEV_API_KEY: "j",
  });
  const q = (rows: unknown[]) => {
    const o: any = {
      select: () => o,
      eq: () => o,
      in: () => o,
      limit: async () => ({ data: rows }),
    };
    return o;
  };
  const db: any = {
    from: (t: string) =>
      q(t === "manual_facts" ? [{ label: "Lower filter" }] : [{ title: "Check overfill float" }]),
  };
  const jev = (probabilities: Record<string, number>) =>
    (async () => {
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0];
      return Response.json({ answers: { means: { type: "choice", choice, probabilities } } });
    }) as unknown as typeof fetch;
  test("a clear pick over none is the manual's name", async () => {
    expect(
      await synonymFor(env, db, "flood switch", "i", jev({ n0: 0.1, n1: 0.7, none: 0.2 })),
    ).toBe("Check overfill float");
  });
  test("a weak pick, or none, is no synonym", async () => {
    expect(
      await synonymFor(env, db, "warranty", "i", jev({ n0: 0.3, n1: 0.2, none: 0.5 })),
    ).toBeNull();
    expect(
      await synonymFor(env, db, "warranty", "i", jev({ n0: 0.34, n1: 0.33, none: 0.33 })),
    ).toBeNull();
  });
});
