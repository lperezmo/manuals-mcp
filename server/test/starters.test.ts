import { describe, expect, test } from "bun:test";

// The chips a new Muse chat from Home offers (plain JS, served as /starters.js).
type Starter = { label: string; text: string; draft?: boolean };
const { homeStarters } = (await import(
  String(new URL("../public/starters.js", import.meta.url))
)) as { homeStarters: (due?: unknown[]) => Starter[] };

const task = (title: string, next_due_on: string, nickname?: string) => ({
  title,
  next_due_on,
  items: nickname ? [{ nickname }] : null,
});

describe("Home's chat starters", () => {
  test("ask about the two soonest jobs, then what's due and a job done", () => {
    const s = homeStarters([
      task("Descale the kettle", "2026-11-20", "Kettle"),
      task("Clean the filter", "2026-11-02", "Dishwasher"),
      task("Check the HEPA filter", "2026-11-05", "Air purifier"),
    ]);
    expect(s.map((x) => x.text)).toEqual([
      "When did I last clean the filter on the Dishwasher?",
      "How do I check the HEPA filter on the Air purifier?",
      "What's due this week?",
      "I just ",
    ]);
    expect(s[3]?.draft).toBe(true);
    expect(s[0]?.label).toBe(s[0]?.text);
  });

  test("doesn't name the thing twice, and keeps capitals like HEPA", () => {
    const [first] = homeStarters([task("Dishwasher filter rinse", "2026-11-02", "Dishwasher")]);
    expect(first?.text).toBe("When did I last dishwasher filter rinse?");
    const [hepa] = homeStarters([task("HEPA swap", "2026-11-02")]);
    expect(hepa?.text).toBe("When did I last HEPA swap?");
  });

  test("with nothing due, it still never opens blank", () => {
    const s = homeStarters([]);
    expect(s).toHaveLength(2);
    expect(s[0]?.label).toBe("What should I keep an eye on?");
  });
});
