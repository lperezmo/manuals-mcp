import { describe, expect, test } from "bun:test";
import { ANSWER_WITHIN_MS, stillReading } from "../src/tools/add-item.js";

describe("add_item answers before a client gives up", () => {
  test("it waits well under the 45 seconds the Muse app allows", () => {
    expect(ANSWER_WITHIN_MS).toBeLessThan(45_000);
  });
  test("the still-reading answer says not to add it again and where to look", () => {
    const text = stillReading("the Dishwasher", true, false);
    expect(text).toContain("Added the Dishwasher");
    expect(text).toContain("Don't add it again");
    expect(text).toContain("list_items");
    expect(stillReading("the Dishwasher", false, true)).toContain("catch_up");
  });
});
