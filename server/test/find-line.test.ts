import { describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import {
  findLine,
  LINE_CHARS,
  MAX_LINES,
  manualLines,
  type SearchedPage,
  splitLines,
} from "../src/finder/find-line.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  JEV_API_KEY: "jev_test",
});

const PAGE: SearchedPage = {
  item: "Washer",
  page: 31,
  text: [
    "Troubleshooting",
    "E4 Drain error. Check the drain hose for kinks and clean the pump filter.",
    "E5 Door lock error. Close the door firmly and restart the cycle.",
    "If the display shows nothing, check that the washer is plugged in.",
  ].join("\n"),
};

/** A Jev stand-in that answers with `answers` and keeps what it was sent. */
function jev(answers: Record<string, unknown>, status = 200) {
  const sent: any[] = [];
  const impl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return status === 200
      ? Response.json({ answers, usage: { input_tokens: 900 } })
      : new Response("down", { status });
  }) as typeof fetch;
  return { impl, sent };
}

describe("findLine", () => {
  test("returns the line that answers, with its page, when Jev is sure", async () => {
    const lines = splitLines(PAGE.text);
    const e4 = lines.findIndex((l) => l.includes("E4 Drain")) + 1;
    expect(e4).toBeGreaterThan(0);
    const id = `L${String(e4).padStart(3, "0")}`;
    const { impl, sent } = jev({
      line: { choice: id, confidence: 0.91, probabilities: { [id]: 0.91, L003: 0.04 } },
      exists: { noul: 0.88 },
    });
    const found = await findLine(env, "What does E4 mean?", [PAGE], impl);
    expect(found?.verdict).toBe("found");
    expect(found?.line?.page).toBe(31);
    expect(found?.line?.text).toContain("E4 Drain error");
    expect(found?.confidence).toBe(0.91);
    // One call: a Choice over line ids and an exists Noul.
    expect(sent).toHaveLength(1);
    expect(sent[0].questions.line.type).toBe("choice");
    expect(sent[0].questions.exists.type).toBe("noul");
    expect(sent[0].state.manual).toContain(`${id}| Washer, p. 31: Troubleshooting E4 Drain error`);
  });

  test("says the manual doesn't cover it when exists is low", async () => {
    const { impl } = jev({
      line: { choice: "L001", confidence: 0.3, probabilities: { L001: 0.3 } },
      exists: { noul: 0.12 },
    });
    const found = await findLine(env, "Can I wash a down comforter?", [PAGE], impl);
    expect(found?.verdict).toBe("absent");
    expect(found?.line).toBeNull();
  });

  test("leaves the pages alone in the middle band", async () => {
    const { impl } = jev({
      line: { choice: "L002", confidence: 0.92, probabilities: { L002: 0.92 } },
      exists: { noul: 0.5 },
    });
    const unsureExists = await findLine(env, "Why is it loud?", [PAGE], impl);
    expect(unsureExists?.verdict).toBe("unsure");
    expect(unsureExists?.line).toBeNull();

    const { impl: shaky } = jev({
      line: { choice: "L002", confidence: 0.45, probabilities: { L002: 0.45, L003: 0.4 } },
      exists: { noul: 0.9 },
    });
    expect((await findLine(env, "Why is it loud?", [PAGE], shaky))?.verdict).toBe("unsure");
  });

  test("returns null when Jev is down, slow or unset", async () => {
    expect(await findLine(env, "What does E4 mean?", [PAGE], jev({}, 503).impl)).toBeNull();
    const thrown = (async () => {
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    expect(await findLine(env, "What does E4 mean?", [PAGE], thrown)).toBeNull();
    // No exists answer: can't tell either way.
    const partial = jev({ line: { choice: "L001", confidence: 0.9 } }).impl;
    expect(await findLine(env, "What does E4 mean?", [PAGE], partial)).toBeNull();
    const { impl, sent } = jev({ exists: { noul: 0.9 } });
    const bare = { ...env, router: undefined };
    expect(await findLine(bare, "What does E4 mean?", [PAGE], impl)).toBeNull();
    expect(sent).toHaveLength(0);
  });
});

describe("splitLines", () => {
  test("cuts a long page without line breaks at sentences", () => {
    const sentence = (n: number) =>
      `Step ${n}: remove the filter cover, rinse the mesh screen under warm water and dry it before refitting.`;
    const text = Array.from({ length: 40 }, (_, i) => sentence(i + 1)).join(" ");
    expect(text).not.toContain("\n");
    const lines = splitLines(text);
    expect(lines.length).toBeGreaterThanOrEqual(20);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(LINE_CHARS);
    expect(lines[0]).toStartWith("Step 1:");
    expect(lines.join(" ")).toBe(text);
  });

  test("cuts a sentence with no stops between words", () => {
    const text = "word ".repeat(400).trim();
    const lines = splitLines(text);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(LINE_CHARS);
  });

  test("joins a heading or a wrapped line to its neighbor", () => {
    const lines = splitLines("E4\nDrain error. Check the drain\nhose for kinks.\n\n---\n12");
    expect(lines[0]).toBe("E4 Drain error. Check the drain hose for kinks.");
    expect(lines).toHaveLength(2);
  });
});

describe("manualLines", () => {
  test("sends at most 255 lines, dropping the ones that share the fewest words", async () => {
    const filler = Array.from({ length: 300 }, (_, i) => `Filler line ${i} about laundry symbols.`);
    filler.splice(280, 0, "The rinse aid dial sets how much rinse aid each cycle uses.");
    const page: SearchedPage = { item: "Dishwasher", page: 12, text: filler.join("\n") };
    const lines = manualLines([page], "How do I set the rinse aid?");
    expect(lines).toHaveLength(MAX_LINES);
    expect(lines.some((l) => l.text.startsWith("The rinse aid dial"))).toBe(true);
    // Page order kept, and each line keeps its place on the page.
    expect(lines.map((l) => l.line)).toEqual([...lines.map((l) => l.line)].sort((a, b) => a - b));
    expect(lines.find((l) => l.text.startsWith("The rinse aid dial"))?.line).toBe(281);

    const { impl, sent } = jev({ exists: { noul: 0.2 } });
    await findLine(env, "How do I set the rinse aid?", [page], impl);
    expect(Object.keys(sent[0].questions.line.criteria)).toHaveLength(MAX_LINES);
  });

  test("reads only the top three pages", () => {
    const pages = [1, 2, 3, 4].map((n) => ({
      item: "Washer",
      page: n,
      text: `Page ${n} says something long enough to stand alone.`,
    }));
    expect(manualLines(pages, "anything").map((l) => l.page)).toEqual([1, 2, 3]);
  });
});
