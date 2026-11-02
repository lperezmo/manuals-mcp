import { describe, expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { runChat } from "../src/chat.js";
import { drawMarked, padBox, union } from "../src/diagram.js";
import { readEnv } from "../src/env.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
});
const auth = { token: "t", clientId: "c", scopes: [], extra: { sub: "u" } } as never;

async function page(): Promise<string> {
  const c = createCanvas(400, 500);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, 400, 500);
  return (await c.encode("png")).toString("base64");
}

describe("manual drawings", () => {
  test("padBox and union stay inside the page", () => {
    expect(padBox({ top: 0.01, bottom: 0.99, left: 0.5, right: 0.6 }, 0.05)).toEqual({
      top: 0,
      bottom: 1,
      left: 0.45,
      right: 0.65,
    });
    expect(
      union(
        { top: 0.2, bottom: 0.3, left: 0.1, right: 0.2 },
        { top: 0.1, bottom: 0.4, left: 0.15, right: 0.5 },
      ),
    ).toEqual({
      top: 0.1,
      bottom: 0.4,
      left: 0.1,
      right: 0.5,
    });
  });

  test("drawMarked cuts out the drawing and draws a teal circle on the page's own pixels", async () => {
    const out = await drawMarked(
      await page(),
      { top: 0, bottom: 0.5, left: 0, right: 1 },
      { top: 0.1, bottom: 0.3, left: 0.3, right: 0.7 },
    );
    expect(out).toStartWith("data:image/jpeg;base64,");
    const img = await loadImage(Buffer.from(out.split(",")[1] as string, "base64"));
    // A crop of the top half, scaled up: wider than tall.
    expect(img.width).toBeGreaterThan(img.height);
    const c = createCanvas(img.width, img.height);
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    // The circle's left edge crosses the middle row near x = 0.3 of the width.
    const row = g.getImageData(0, Math.round(img.height * 0.4), img.width, 1).data;
    let teal = 0;
    for (let x = 0; x < img.width; x++) {
      const [r, gr, b] = [row[x * 4], row[x * 4 + 1], row[x * 4 + 2]] as number[];
      if ((r as number) < 120 && (gr as number) > 140 && (b as number) > 120) teal++;
    }
    expect(teal).toBeGreaterThan(0);
  });

  test("Muse's show_diagram call comes back as the reply's drawing", async () => {
    let step = 0;
    const muse = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect((body.tools ?? []).map((t: any) => t.function.name)).toContain("show_diagram");
      step++;
      if (step === 1)
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "d",
                    type: "function",
                    function: {
                      name: "show_diagram",
                      arguments: JSON.stringify({
                        item: "Dishwasher",
                        page: 11,
                        part: "the cup filter",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      return Response.json({ choices: [{ message: { content: "It's the round cup." } }] });
    }) as unknown as typeof fetch;
    const asked: unknown[] = [];
    const out = await runChat(
      env,
      auth,
      [{ role: "user", content: "where's the cup filter?" }],
      muse,
      undefined,
      null,
      {
        diagram: async (args) => {
          asked.push(args);
          return { image: "data:image/jpeg;base64,D", page: 11, circled: true };
        },
      },
    );
    expect(asked).toEqual([{ item: "Dishwasher", page: 11, part: "the cup filter" }]);
    expect(out.diagram).toEqual({ image: "data:image/jpeg;base64,D", page: 11, circled: true });
    expect(out.tools_used).toContain("show_diagram");
  });

  test("a drawing that can't be found becomes words, not an error", async () => {
    let step = 0;
    const results: string[] = [];
    const muse = (async (_u: string, init: RequestInit) => {
      for (const m of JSON.parse(String(init.body)).messages)
        if (m.role === "tool") results.push(m.content);
      step++;
      if (step === 1)
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "d",
                    type: "function",
                    function: {
                      name: "show_diagram",
                      arguments: '{"item":"x","page":3,"part":"the pump"}',
                    },
                  },
                ],
              },
            },
          ],
        });
      return Response.json({ choices: [{ message: { content: "Behind the kick plate." } }] });
    }) as unknown as typeof fetch;
    const out = await runChat(
      env,
      auth,
      [{ role: "user", content: "where's the pump?" }],
      muse,
      undefined,
      null,
      {
        diagram: async () => {
          throw new Error("There's no manual PDF saved for the x.");
        },
      },
    );
    expect(results[0]).toContain("Couldn't show the drawing");
    expect(out.diagram).toBeUndefined();
    expect(out.reply).toBe("Behind the kick plate.");
  });
});
