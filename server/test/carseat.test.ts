import { describe, expect, test } from "bun:test";
import type { SeatModeRow } from "../src/db.js";
import { checkSeat } from "../src/lib/carseat.js";
import { addDays } from "../src/lib/schedule.js";

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
    min_age_months: 24,
    source_page: 26,
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
  test("a 20-month-old fits rear-facing, with room left and a re-measure date", () => {
    const result = checkSeat(
      seat,
      {
        birthDate: addDays(TODAY, -608),
        weightKg: { value: 11, on: addDays(TODAY, -10) },
        heightCm: { value: 82, on: addDays(TODAY, -10) },
      },
      TODAY,
    );
    expect(result.current_mode).toBe("rear-facing");
    expect(result.modes[0]?.manual_page).toBe(24);
    expect(result.modes[0]?.room_left).toEqual([
      "7 kg (15.4 lb) of weight",
      "20 cm (7.9 in) of height",
    ]);
    expect(result.modes[1]?.fit).toBe("too_young");
    expect(result.closest_limit).toEqual({ by: "height", used: 0.8 });
    expect(result.remeasure_by).toBe(addDays(TODAY, 90));
    expect(result.stale_measurements).toBe(false);
    expect(result.caveats.join(" ")).toContain("technician");
    expect(JSON.stringify(result)).not.toContain("estimate");
  });

  test("close to a limit means measuring again within a month", () => {
    const result = checkSeat(
      seat,
      { birthDate: null, weightKg: { value: 17, on: TODAY }, heightCm: null },
      TODAY,
    );
    expect(result.closest_limit?.by).toBe("weight");
    expect(result.remeasure_by).toBe(addDays(TODAY, 30));
  });

  test("over the rear-facing height limit moves to forward-facing", () => {
    const result = checkSeat(
      seat,
      {
        birthDate: "2022-01-01",
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
      { birthDate: null, weightKg: { value: 11, on: addDays(TODAY, -120) }, heightCm: null },
      TODAY,
    );
    expect(result.stale_measurements).toBe(true);
    expect(result.caveats[0]).toContain("measure again");
  });
});
