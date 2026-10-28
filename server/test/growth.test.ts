import { describe, expect, test } from "bun:test";
import { addDays, lmsAt, percentile, projectToLimit, valueAtZ, zScore } from "../src/lib/growth.js";

describe("WHO growth curves", () => {
  test("the median is the 50th percentile", () => {
    const lms = lmsAt("weight_kg", "female", 12);
    expect(lms[1]).toBeCloseTo(8.9481, 4); // WHO girls, 12 months
    expect(zScore(lms[1], lms)).toBeCloseTo(0, 6);
    expect(percentile(0)).toBe(50);
  });

  test("z-score and value are inverses", () => {
    const lms = lmsAt("weight_kg", "male", 18.5);
    for (const z of [-2, -0.5, 0, 1.3, 2.5]) {
      expect(zScore(valueAtZ(z, lms), lms)).toBeCloseTo(z, 6);
    }
  });

  test("standing height is used from 24 months", () => {
    // WHO boys: length at 24 months is 87.82 cm, standing height 87.12 cm.
    expect(lmsAt("height_cm", "male", 24)[1]).toBeCloseTo(87.1161, 3);
    expect(lmsAt("height_cm", "male", 23)[1]).toBeCloseTo(86.941, 3);
  });

  test("a median boy reaches 18 kg shortly before age 5", () => {
    const birth = "2024-01-01";
    const measuredOn = addDays(birth, 365);
    const p = projectToLimit({
      metric: "weight_kg",
      sex: "male",
      birthDate: birth,
      measuredOn,
      value: lmsAt("weight_kg", "male", 365 / 30.4375)[1],
      limit: 18,
    });
    expect(p.alreadyReached).toBe(false);
    expect(p.reachesOn).not.toBeNull();
    const months = (Date.parse(p.reachesOn as string) - Date.parse(birth)) / 86_400_000 / 30.4375;
    expect(months).toBeGreaterThan(54);
    expect(months).toBeLessThan(60);
  });

  test("returns no date when the limit is past the WHO range", () => {
    const p = projectToLimit({
      metric: "weight_kg",
      sex: "female",
      birthDate: "2025-01-01",
      measuredOn: "2025-07-01",
      value: 7.3,
      limit: 30,
    });
    expect(p.reachesOn).toBeNull();
  });

  test("without a growth table, the earlier estimate wins", () => {
    const args = {
      metric: "height_cm" as const,
      birthDate: "2025-01-01",
      measuredOn: "2026-01-01",
      value: 76,
      limit: 100,
    };
    const both = projectToLimit({ ...args, sex: null });
    const girl = projectToLimit({ ...args, sex: "female" });
    const boy = projectToLimit({ ...args, sex: "male" });
    const earliest = [girl.reachesOn, boy.reachesOn].sort()[0];
    expect(both.reachesOn).toBe(earliest ?? null);
  });
});
