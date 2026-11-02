import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { runChat } from "../src/chat.js";
import { readEnv } from "../src/env.js";
import { markPhoto, markPrompt } from "../src/mark-photo.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
  META_READER_API_KEY: "meta_test",
  META_READER_BASE_URL: "https://api.meta.example/v1",
});

/** A small PNG, as the image model would send it back. */
async function png(w = 64, h = 48): Promise<string> {
  const c = createCanvas(w, h);
  const g = c.getContext("2d");
  g.fillStyle = "#3a8";
  g.fillRect(0, 0, w, h);
  return (await c.encode("png")).toString("base64");
}

const photo = { mime: "image/jpeg", base64: "AAAA" };
const auth = { token: "t", clientId: "c", scopes: [], extra: { sub: "u" } } as never;

describe("photo markup", () => {
  test("the image model is asked to circle it and change nothing else", () => {
    const p = markPrompt("Circle the round gray cup in the middle.");
    expect(p).toStartWith("Circle the round gray cup in the middle. Point it out");
    expect(p).toContain("nothing added or removed");
  });

  test("env reads the Meta key for images, capped at 140 unless set", () => {
    expect(env.image).toMatchObject({
      baseUrl: "https://api.meta.example/v1",
      model: "muse-image-1.0",
      cap: 140,
    });
    expect(
      readEnv({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_PUBLISHABLE_KEY: "x" }).image,
    ).toBeUndefined();
  });

  test("markPhoto sends the photo to images/edits and returns a JPEG", async () => {
    const b64 = await png();
    const seen: { url: string; body: any }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({
        data: [{ b64_json: b64 }],
        usage: { input_tokens: 900, output_tokens: 40 },
      });
    }) as unknown as typeof fetch;
    const out = await markPhoto(env, photo, "Circle the cup", fake);
    expect(seen[0]?.url).toBe("https://api.meta.example/v1/images/edits");
    expect(seen[0]?.body.model).toBe("muse-image-1.0");
    expect(seen[0]?.body.images[0].image_url).toBe("data:image/jpeg;base64,AAAA");
    expect(out.image).toStartWith("data:image/jpeg;base64,");
    expect(out.tokens_in).toBe(900);
  });

  test("Muse calls mark_photo once and the marked photo comes back with the reply", async () => {
    let step = 0;
    const offered: string[][] = [];
    const muse = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      offered.push((body.tools ?? []).map((t: any) => t.function.name));
      step++;
      if (step === 1)
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "a",
                    type: "function",
                    function: {
                      name: "mark_photo",
                      arguments: '{"instruction":"Circle the round cup"}',
                    },
                  },
                ],
              },
            },
          ],
        });
      return Response.json({ choices: [{ message: { content: "That's the cup filter." } }] });
    }) as unknown as typeof fetch;
    const asked: string[] = [];
    const out = await runChat(
      env,
      auth,
      [{ role: "user", content: "which is the top filter?" }],
      muse,
      undefined,
      [],
      {
        image: photo,
        mark: async (instruction) => {
          asked.push(instruction);
          return { image: "data:image/jpeg;base64,MARKED" };
        },
      },
    );
    expect(offered[0]).toContain("mark_photo");
    expect(asked).toEqual(["Circle the round cup"]);
    expect(out.marked).toBe("data:image/jpeg;base64,MARKED");
    expect(out.tools_used).toContain("mark_photo");
    expect(out.reply).toBe("That's the cup filter.");
  });

  test("no photo, no mark_photo offered", async () => {
    const offered: string[][] = [];
    const muse = (async (_url: string, init: RequestInit) => {
      offered.push((JSON.parse(String(init.body)).tools ?? []).map((t: any) => t.function.name));
      return Response.json({ choices: [{ message: { content: "Hi." } }] });
    }) as unknown as typeof fetch;
    await runChat(env, auth, [{ role: "user", content: "hello" }], muse, undefined, []);
    expect(offered[0] ?? []).not.toContain("mark_photo");
  });

  test("a failed markup still gets an answer in words", async () => {
    let step = 0;
    const toolResults: string[] = [];
    const muse = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      for (const m of body.messages) if (m.role === "tool") toolResults.push(m.content);
      step++;
      if (step === 1)
        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "a",
                    type: "function",
                    function: { name: "mark_photo", arguments: '{"instruction":"Circle the cup"}' },
                  },
                ],
              },
            },
          ],
        });
      return Response.json({
        choices: [{ message: { content: "It's the round cup in the middle." } }],
      });
    }) as unknown as typeof fetch;
    const out = await runChat(
      env,
      auth,
      [{ role: "user", content: "where?" }],
      muse,
      undefined,
      [],
      {
        image: photo,
        mark: async () => ({ error: "budget used up" }),
      },
    );
    expect(out.marked).toBeUndefined();
    expect(toolResults[0]).toContain("Couldn't mark the photo: budget used up");
    expect(out.reply).toBe("It's the round cup in the middle.");
  });
});
