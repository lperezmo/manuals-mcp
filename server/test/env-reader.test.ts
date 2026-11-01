import { describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";

const base = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "pk",
  READER_BASE_URL: "https://baseten.example/v1",
  READER_MODEL: "muse-baseten",
  READER_API_KEY: "bt",
  META_READER_BASE_URL: "https://meta.example/v1/",
  META_READER_MODEL: "muse-meta",
  META_READER_API_KEY: "mk",
};

describe("which Muse the reader uses", () => {
  test("READER_* by default, as on Vercel", () => {
    expect(readEnv(base).reader).toMatchObject({
      baseUrl: "https://baseten.example/v1",
      model: "muse-baseten",
      apiKey: "bt",
    });
  });

  test("READER_PROVIDER=meta switches to the META_READER_* keys", () => {
    expect(readEnv({ ...base, READER_PROVIDER: "meta" }).reader).toMatchObject({
      baseUrl: "https://meta.example/v1",
      model: "muse-meta",
      apiKey: "mk",
    });
  });

  test("meta with its keys missing leaves the reader off instead of mixing providers", () => {
    expect(
      readEnv({ ...base, READER_PROVIDER: "meta", META_READER_MODEL: "" }).reader,
    ).toBeUndefined();
  });
});
