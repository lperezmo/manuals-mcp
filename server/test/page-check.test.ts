import { describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { checkPage } from "../src/photo-check.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  JEV_API_KEY: "jev_test",
});
const photo = { mime: "image/jpeg", base64: "AAAA" };
const jev = (answers: Record<string, number>) =>
  (async () =>
    Response.json({
      answers: Object.fromEntries(
        Object.entries(answers).map(([k, noul]) => [k, { type: "noul", noul }]),
      ),
      usage: { input_tokens: 40 },
    })) as unknown as typeof fetch;

describe("checkPage", () => {
  test("a sharp English page is kept", async () => {
    expect(
      await checkPage(env, photo, jev({ page: 0.9, sharp: 0.8, english: 0.95 })),
    ).toMatchObject({
      retake: null,
      english: true,
    });
  });
  test("a blurry page asks for a retake", async () => {
    expect(
      (await checkPage(env, photo, jev({ page: 0.9, sharp: 0.05, english: 0.9 })))?.retake,
    ).toBe("blurry");
  });
  test("something that isn't a page asks for a retake first", async () => {
    expect(
      (await checkPage(env, photo, jev({ page: 0.02, sharp: 0.05, english: 0.9 })))?.retake,
    ).toBe("not_a_page");
  });
  test("a confident not-English page is marked", async () => {
    expect(
      (await checkPage(env, photo, jev({ page: 0.9, sharp: 0.9, english: 0.03 })))?.english,
    ).toBe(false);
  });
  test("Jev down keeps the page", async () => {
    const down = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await checkPage(env, photo, down)).toBeNull();
  });
  test("WebP skips Jev", async () => {
    expect(await checkPage(env, { mime: "image/webp", base64: "AAAA" }, jev({}))).toBeNull();
  });
});
