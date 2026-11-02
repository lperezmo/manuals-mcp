import { describe, expect, test } from "bun:test";
import { anyWords } from "../src/tools/ask-manual.js";

describe("anyWords", () => {
  test("drops filler and joins the rest with or", () => {
    expect(anyWords("where is the overfill float location")).toBe("overfill or float");
    expect(anyWords("How do I remove the upper filter?")).toBe("remove or upper or filter");
  });
  test("one word, or none, needs no second search", () => {
    expect(anyWords("E4")).toBeNull();
    expect(anyWords("where is it")).toBeNull();
  });
});
