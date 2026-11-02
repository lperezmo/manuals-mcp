import { describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { autoApplies, type Check, checkLine, type Flagged, quoteFound } from "../src/recheck.js";
import { verdictLine } from "../src/tools/check-flagged.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
});

const pages = [
  {
    page_number: 15,
    content:
      "Do not use adapter or extension cords. Doing so may result in serious injury.\nFor best performance, plug the appliance into its own individual outlet.",
  },
];
const line: Flagged = {
  id: "975e0e51-261e-41b4-bbb4-4d99ef4d1295",
  type: "fact",
  item_id: "i",
  item: "Washer",
  page: 15,
  line: { kind: "spec", label: "Electrical requirements", value: "Extension cord up to 3 feet" },
};
const museSays = (answer: unknown) =>
  (async () =>
    Response.json({
      choices: [{ message: { content: JSON.stringify(answer) } }],
      usage: { prompt_tokens: 900, completion_tokens: 60 },
    })) as unknown as typeof fetch;

describe("the second read", () => {
  test("a quote counts however the PDF broke its lines", () => {
    expect(quoteFound("Do not use adapter or\nextension cords.", pages)).toBe(true);
    expect(quoteFound("Use an extension cord up to 3 feet", pages)).toBe(false);
    expect(quoteFound("cords", pages)).toBe(false);
  });

  test("a fix that quotes the page is kept, and tokens are counted", async () => {
    const usage = { tokens_in: 0, tokens_out: 0 };
    const out = await checkLine(
      env,
      line,
      pages,
      usage,
      museSays({
        verdict: "fix",
        quote: "Do not use adapter or extension cords.",
        reason: "Page 15 says no extension cords at all.",
        changes: { value: "No adapter or extension cord" },
      }),
    );
    expect(out.verdict).toBe("fix");
    expect(out.changes).toEqual({ value: "No adapter or extension cord" });
    expect(usage).toEqual({ tokens_in: 900, tokens_out: 60 });
  });

  test("a verdict whose quote isn't on the page stays unsure", async () => {
    const out = await checkLine(
      env,
      line,
      pages,
      { tokens_in: 0, tokens_out: 0 },
      museSays({
        verdict: "confirm",
        quote: "Extension cords up to 3 feet are fine",
        reason: "ok",
      }),
    );
    expect(out.verdict).toBe("unsure");
    expect(out.reason).toContain("couldn't quote");
  });

  test("a fix with fields that don't fit stays unsure", async () => {
    const out = await checkLine(
      env,
      line,
      pages,
      { tokens_in: 0, tokens_out: 0 },
      museSays({
        verdict: "fix",
        quote: "Do not use adapter or extension cords.",
        reason: "x",
        changes: { interval_value: "monthly" },
      }),
    );
    expect(out.verdict).toBe("unsure");
  });

  test("no page saved, or Muse down, means unsure, not an error", async () => {
    const usage = { tokens_in: 0, tokens_out: 0 };
    expect((await checkLine(env, line, [], usage)).verdict).toBe("unsure");
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    expect((await checkLine(env, line, pages, usage, down)).verdict).toBe("unsure");
  });

  test("after a read it saves confirmations and fixes, but never a changed car seat limit", () => {
    const c = (type: Check["type"], verdict: Check["verdict"]): Check => ({
      id: "x",
      type,
      item: "Car seat",
      page: 9,
      what: "w",
      verdict,
      reason: "r",
    });
    expect(autoApplies(c("fact", "confirm"))).toBe(true);
    expect(autoApplies(c("task", "fix"))).toBe(true);
    expect(autoApplies(c("seat_limit", "confirm"))).toBe(true);
    expect(autoApplies(c("seat_limit", "fix"))).toBe(false);
    expect(autoApplies(c("fact", "unsure"))).toBe(false);
  });

  test("each verdict reads as one line with its page", () => {
    expect(
      verdictLine({
        id: "x",
        type: "fact",
        item: "Washer",
        page: 15,
        what: "Electrical requirements: Extension cord up to 3 feet",
        verdict: "fix",
        reason: "Page 15 says no extension cords.",
        changes: { value: "No adapter or extension cord" },
      }),
    ).toBe(
      'Washer: Electrical requirements: Extension cord up to 3 feet (p. 15). the page says something else. Page 15 says no extension cords. Fix: {"value":"No adapter or extension cord"}.',
    );
  });
});
