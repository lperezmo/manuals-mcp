import { describe, expect, test } from "bun:test";
import { knowledgeSchema } from "../src/finder/knowledge.js";
import { usesPerWeek } from "../src/tools/record-measurement.js";
import { columnsFor } from "../src/tools/revise-fact.js";

describe("revise_fact changes", () => {
  test("keeps only the columns a fact has", () => {
    expect(columnsFor("fact", { value: "Warm water only", title: "ignored" })).toEqual({
      value: "Warm water only",
    });
  });

  test("converts seat limits to kg and cm", () => {
    expect(
      columnsFor("seat_limit", {
        max_weight: 40,
        weight_unit: "lb",
        max_height: 40,
        height_unit: "in",
      }),
    ).toEqual({ max_weight_kg: 18.14, max_height_cm: 101.6 });
  });

  test("task changes map to task columns", () => {
    expect(
      columnsFor("task", { interval_unit: "months", interval_value: 3, active: false }),
    ).toEqual({ interval_unit: "months", interval_value: 3, active: false });
  });
});

describe("cycle readings", () => {
  test("two readings a week or more apart give uses per week", () => {
    expect(
      usesPerWeek([
        { measured_on: "2026-10-01", value: 200 },
        { measured_on: "2026-10-15", value: 212 },
      ]),
    ).toBe(6);
  });

  test("too close together, or going backwards, gives nothing", () => {
    expect(
      usesPerWeek([
        { measured_on: "2026-10-01", value: 200 },
        { measured_on: "2026-10-03", value: 204 },
      ]),
    ).toBeNull();
    expect(
      usesPerWeek([
        { measured_on: "2026-10-01", value: 200 },
        { measured_on: "2026-10-20", value: 10 },
      ]),
    ).toBeNull();
  });
});

describe("reader output", () => {
  test("facts carry a kind and an unsure flag", () => {
    const k = knowledgeSchema.parse({
      facts: [
        { kind: "error_code", label: "E4", value: "Drain blocked", source_page: 38, unsure: true },
      ],
    });
    expect(k.facts[0]).toMatchObject({ kind: "error_code", unsure: true });
  });

  test("a fact without a kind is other", () => {
    const k = knowledgeSchema.parse({ facts: [{ label: "Max load", value: "8 kg" }] });
    expect(k.facts[0]?.kind).toBe("other");
  });
});
