import { describe, expect, test } from "bun:test";
import { quickOrBackground } from "../src/background.js";

const after = <T>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("quickOrBackground", () => {
  test("a quick answer comes back as usual", async () => {
    expect(await quickOrBackground(after(5, "Already read."), 200)).toEqual({
      done: true,
      value: "Already read.",
    });
  });

  test("a long one is left running and reported as started", async () => {
    let finished = false;
    const long = after(80, "read").then((v) => {
      finished = true;
      return v;
    });
    expect(await quickOrBackground(long, 10)).toEqual({ done: false });
    expect(finished).toBe(false);
    await long;
    expect(finished).toBe(true);
  });

  test("a quick failure is still an error the caller can answer", async () => {
    const busy = Promise.reject(new Error("busy"));
    await expect(quickOrBackground(busy, 200)).rejects.toThrow("busy");
  });
});
