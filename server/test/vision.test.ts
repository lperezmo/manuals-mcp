import { describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { englishPages, transcribePages } from "../src/finder/vision.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
  JEV_API_KEY: "jev_test",
});
const img = (n: number) => ({ page_number: n, png_base64: "iVBORw0KGgo=" });

describe("transcribePages", () => {
  test("sends page images a few at a time and keeps only the pages asked for", async () => {
    const sent: any[] = [];
    const muse = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      const asked = body.messages[1].content
        .filter((c: any) => c.type === "text")
        .map((c: any) => Number(c.text.match(/\d+/)[0]));
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                pages: [
                  ...asked.map((n: number) => ({ page: n, text: `Text of page ${n}` })),
                  { page: 999, text: "not asked" },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
    }) as unknown as typeof fetch;
    const { pages, usage } = await transcribePages(env, [1, 2, 3, 4, 5, 6].map(img), muse);
    expect(sent).toHaveLength(2);
    expect(sent[0].messages[1].content[1]).toMatchObject({ type: "image_url" });
    expect(pages.map((p) => p.page_number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pages[0]?.content).toBe("Text of page 1");
    expect(usage).toEqual({ calls: 2, tokens_in: 200, tokens_out: 100, failed: 0 });
  });

  test("a failed batch loses its pages, not the manual", async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      if (n === 1) return new Response("busy", { status: 503 });
      return Response.json({
        choices: [{ message: { content: '{"pages":[{"page":5,"text":"ok"}]}' } }],
      });
    }) as unknown as typeof fetch;
    const { pages, usage } = await transcribePages(env, [1, 2, 3, 4, 5].map(img), flaky);
    expect(pages).toEqual([{ page_number: 5, content: "ok" }]);
    expect(usage.failed).toBe(1);
  });
});

describe("englishPages", () => {
  const jev = (english: (page: number) => number) => {
    let i = 0;
    return (async () =>
      Response.json({
        answers: { english: { type: "noul", noul: english(++i) } },
        usage: { input_tokens: 2500 },
      })) as unknown as typeof fetch;
  };

  test("drops pages Jev is sure aren't English", async () => {
    const { english, tokens_in } = await englishPages(
      env,
      [1, 2, 3, 4].map(img),
      jev((i) => (i <= 2 ? 0.95 : 0.03)),
    );
    expect(english.map((p) => p.page_number)).toEqual([1, 2]);
    expect(tokens_in).toBe(10_000);
  });

  test("keeps everything when hardly any page is English", async () => {
    const { english } = await englishPages(
      env,
      [1, 2, 3, 4].map(img),
      jev(() => 0.02),
    );
    expect(english).toHaveLength(4);
  });
});
