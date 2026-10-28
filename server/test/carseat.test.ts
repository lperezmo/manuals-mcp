import { describe, expect, test } from "bun:test";
import type { SeatModeRow } from "../src/db.js";
import { checkSeat } from "../src/lib/carseat.js";
import { addDays } from "../src/lib/growth.js";

const TODAY = "2026-10-22";

function mode(partial: Partial<SeatModeRow> & Pick<SeatModeRow, "mode">): SeatModeRow {
  return {
    id: crypto.randomUUID(),
    item_id: "seat",
    min_weight_kg: null,
    max_weight_kg: null,
    min_height_cm: null,
    max_height_cm: null,
    min_age_months: null,
    fit_note: null,
    source_page: null,
    ...partial,
  };
}

const seat = [
  mode({
    mode: "forward_facing",
    min_weight_kg: 10,
    max_weight_kg: 29.5,
    max_height_cm: 125,
    source_page: 31,
  }),
  mode({
    mode: "rear_facing",
    min_weight_kg: 2.3,
    max_weight_kg: 18,
    max_height_cm: 102,
    source_page: 24,
  }),
];

describe("car seat check", () => {
  test("a 20-month-old fits rear-facing and gets a switch estimate", () => {
    const result = checkSeat(
      seat,
      {
        birthDate: addDays(TODAY, -608),
        sex: "female",
        weightKg: { value: 11, on: addDays(TODAY, -10) },
        heightCm: { value: 82, on: addDays(TODAY, -10) },
      },
      TODAY,
    );
    expect(result.current_mode).toBe("rear-facing");
    expect(result.modes[0]?.mode).toBe("rear_facing");
    expect(result.modes[0]?.manual_page).toBe(24);
    expect(result.next_switch_on).not.toBeNull();
    expect(result.next_switch_on! > TODAY).toBe(true);
    expect(result.remeasure_by >= addDays(TODAY, 7)).toBe(true);
    expect(result.remeasure_by <= addDays(TODAY, 90)).toBe(true);
    expect(result.stale_measurements).toBe(false);
    expect(result.caveats.join(" ")).toContain("estimate");
    expect(result.caveats.join(" ")).toContain("technician");
  });

  test("over the rear-facing height limit moves to forward-facing", () => {
    const result = checkSeat(
      seat,
      {
        birthDate: "2022-01-01",
        sex: "male",
        weightKg: { value: 16, on: TODAY },
        heightCm: { value: 104, on: TODAY },
      },
      TODAY,
    );
    expect(result.modes.find((m) => m.mode === "rear_facing")?.fit).toBe("outgrown");
    expect(result.current_mode).toBe("forward-facing with harness");
  });

  test("old or missing measurements are flagged", () => {
    const result = checkSeat(
      seat,
      {
        birthDate: null,
        sex: null,
        weightKg: { value: 11, on: addDays(TODAY, -120) },
        heightCm: null,
      },
      TODAY,
    );
    expect(result.stale_measurements).toBe(true);
    expect(result.next_switch_on).toBeNull();
    expect(result.caveats[0]).toContain("birth date");
  });
});
