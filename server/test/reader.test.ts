import { describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { cut, knowledgeSchema, LIMITS, readKnowledge } from "../src/finder/knowledge.js";
import { distill, ReaderError, selectPages } from "../src/finder/reader.js";

describe("server reader", () => {
  test("keeps upkeep pages when a manual is over budget", () => {
    const filler = { page_number: 1, content: "Safety warnings and legal text. ".repeat(40) };
    const upkeep = {
      page_number: 42,
      content: "Clean the filter every month. Run Tub Clean every 30 washes.",
    };
    const picked = selectPages(
      [filler, { ...filler, page_number: 2 }, upkeep],
      upkeep.content.length + 10,
    );
    expect(picked.map((p) => p.page_number)).toEqual([42]);
  });

  test("parses an OpenAI-compatible JSON answer", async () => {
    const env = readEnv({
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "k",
      READER_BASE_URL: "https://reader.example.com/v1",
      READER_MODEL: "some-model",
    });
    let sent: any;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                tasks: [
                  {
                    title: "Clean the filter",
                    interval_unit: "months",
                    interval_value: 1,
                    source_page: 42,
                  },
                ],
                facts: [],
                seat_modes: [],
              }),
            },
          },
        ],
      });
    }) as unknown as typeof fetch;
    const { knowledge: k, usage } = await distill(
      env,
      { itemLabel: "Washer", pages: [{ page_number: 42, content: "..." }] },
      fake,
    );
    expect(sent.model).toBe("some-model");
    expect(k.tasks[0]?.source_page).toBe(42);
    expect(usage).toEqual({ model: "some-model", tokens_in: null, tokens_out: null });
  });

  test("a garbled answer keeps what was sent and what came back", async () => {
    const env = readEnv({
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "k",
      READER_BASE_URL: "https://reader.example.com/v1",
      READER_MODEL: "some-model",
    });
    const fake = (async () =>
      Response.json({
        choices: [{ message: { content: "Sure! Here are the tasks: {oops" } }],
        usage: { prompt_tokens: 50, completion_tokens: 9 },
      })) as unknown as typeof fetch;
    const err = await distill(
      env,
      { itemLabel: "Washer", pages: [{ page_number: 7, content: "Clean the filter." }] },
      fake,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ReaderError);
    expect(err.trace.pages_sent).toEqual([7]);
    expect(err.trace.raw_output).toBe("Sure! Here are the tasks: {oops");
    expect(err.trace.usage.tokens_out).toBe(9);
  });

  test("car seat limits default to pounds and inches", () => {
    const k = knowledgeSchema.parse({
      seat_modes: [{ mode: "rear_facing", max_weight: 40, max_height: 40 }],
    });
    expect(k.seat_modes[0]?.weight_unit).toBe("lb");
    expect(k.seat_modes[0]?.height_unit).toBe("in");
    expect(k.tasks).toEqual([]);
  });

  test("a long car seat manual still distills when a fit note runs over", async () => {
    const env = readEnv({
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "k",
      READER_BASE_URL: "https://reader.example.com/v1",
      READER_MODEL: "some-model",
    });
    const longNote =
      "Top of the child's head must be at least 1 inch below the top of the headrest, and the harness straps must be at or below the shoulders. ".repeat(
        8,
      );
    let sent: any;
    const fake = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                tasks: [],
                facts: [
                  { kind: "safety", label: "Expiration", value: "10 years", source_page: 12 },
                ],
                seat_modes: [
                  { mode: "rear_facing", max_weight: 40, fit_note: longNote, source_page: 20 },
                  { mode: "forward_facing", min_weight: 22, max_weight: 65, fit_note: longNote },
                ],
              }),
            },
          },
        ],
      });
    }) as unknown as typeof fetch;
    const out = await distill(
      env,
      { itemLabel: "Car Seat", pages: [{ page_number: 20, content: "rear-facing 4-40 lb" }] },
      fake,
    );
    expect(sent.messages[0].content).toContain(`"fit_note" at most ${LIMITS.fit_note}`);
    expect(out.knowledge.seat_modes).toHaveLength(2);
    expect(out.knowledge.facts).toHaveLength(1);
    expect(out.trimmed).toBe(2);
    expect(out.dropped).toBe(0);
    for (const s of out.knowledge.seat_modes) {
      expect(s.fit_note!.length).toBeLessThanOrEqual(LIMITS.fit_note);
      expect(s.fit_note!.endsWith("\u2026")).toBe(true);
      expect(s.unsure).toBe(true);
    }
    expect(out.knowledge.seat_modes[0]?.source_page).toBe(20);
  });

  test("every text field is trimmed, not just the fit note", () => {
    const r = readKnowledge({
      tasks: [
        {
          title: "T".repeat(LIMITS.task_title + 40),
          details: "word ".repeat(400),
          interval_unit: "months",
          interval_value: 6,
        },
      ],
      facts: [{ label: "L".repeat(200), value: "v".repeat(1500) }],
    });
    expect(r.trimmed).toBe(2);
    expect(r.knowledge.tasks[0]!.title.length).toBeLessThanOrEqual(LIMITS.task_title);
    expect(r.knowledge.tasks[0]!.details!.length).toBeLessThanOrEqual(LIMITS.task_details);
    expect(r.knowledge.facts[0]!.label.length).toBeLessThanOrEqual(LIMITS.fact_label);
    expect(r.knowledge.facts[0]!.value.length).toBeLessThanOrEqual(LIMITS.fact_value);
    expect(r.knowledge.facts[0]!.unsure).toBe(true);
    expect(r.knowledge.seat_modes).toEqual([]);
  });

  test("an entry that can't fit is left out and the rest are kept", () => {
    const r = readKnowledge({
      tasks: [
        { title: "Clean the filter", interval_unit: "months", interval_value: 1 },
        { title: "Mystery", interval_unit: "fortnights" },
        "not an entry",
      ],
      facts: Array.from({ length: LIMITS.facts + 5 }, (_, i) => ({ label: `E${i}`, value: "x" })),
      seat_modes: { mode: "rear_facing" },
    });
    expect(r.knowledge.tasks.map((t) => t.title)).toEqual(["Clean the filter"]);
    expect(r.knowledge.facts).toHaveLength(LIMITS.facts);
    expect(r.knowledge.seat_modes).toEqual([]);
    expect(r.dropped).toBe(2 + 5 + 1);
    expect(r.trimmed).toBe(0);
  });

  test("a non-object answer still fails as unreadable", () => {
    expect(() => readKnowledge([1, 2])).toThrow();
    expect(() => readKnowledge(null)).toThrow();
  });

  test("cut stops at a word and stays within the limit", () => {
    expect(cut("short", 10)).toBe("short");
    const c = cut("one two three four five six seven", 20);
    expect(c.length).toBeLessThanOrEqual(20);
    expect(c).toBe("one two three four\u2026");
  });
});
