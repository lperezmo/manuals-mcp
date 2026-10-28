import { describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { knowledgeSchema } from "../src/finder/knowledge.js";
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
});
