import type { SeatModeRow } from "../db.js";
import { addDays, ageInMonths, daysBetween } from "./schedule.js";
import { round, showCm, showKg } from "./units.js";

// Compares a child's latest measurements to a seat's limits from its manual,
// mode by mode. Seats are used in the earliest mode that still fits
// (rear-facing as long as the seat allows). It never predicts growth: it says
// how much room is left and when to measure again, sooner when a limit is close.

export const MODE_ORDER: SeatModeRow["mode"][] = [
  "rear_facing",
  "forward_facing",
  "booster_high_back",
  "booster_backless",
];

export const MODE_NAMES: Record<SeatModeRow["mode"], string> = {
  rear_facing: "rear-facing",
  forward_facing: "forward-facing with harness",
  booster_high_back: "high-back booster",
  booster_backless: "backless booster",
};

/** Share of a limit used before we suggest measuring again within a month. */
const CLOSE = 0.9;

export interface Reading {
  value: number;
  on: string;
}

export interface ChildFacts {
  birthDate: string | null;
  weightKg: Reading | null;
  heightCm: Reading | null;
}

export type Fit = "fits" | "too_small" | "too_young" | "outgrown" | "unknown";

export interface ModeCheck {
  mode: SeatModeRow["mode"];
  name: string;
  fit: Fit;
  limits: string[];
  /** For the mode the child fits: what's left before each upper limit. */
  room_left: string[];
  manual_page: number | null;
  fit_note: string | null;
}

export interface SeatCheck {
  modes: ModeCheck[];
  current_mode: string | null;
  /** The upper limit closest to being reached, as a share used (0 to 1). */
  closest_limit: { by: "weight" | "height"; used: number } | null;
  remeasure_by: string;
  stale_measurements: boolean;
  caveats: string[];
}

export function checkSeat(modes: SeatModeRow[], child: ChildFacts, today: string): SeatCheck {
  const sorted = [...modes].sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode));
  const age = child.birthDate ? ageInMonths(child.birthDate, today) : null;
  const checks = sorted.map((m) => checkMode(m, child, age));
  const currentIndex = checks.findIndex((c) => c.fit === "fits");
  const current = currentIndex >= 0 ? (sorted[currentIndex] as SeatModeRow) : null;

  const used: { by: "weight" | "height"; used: number }[] = [];
  if (current?.max_weight_kg && child.weightKg) {
    used.push({ by: "weight", used: child.weightKg.value / current.max_weight_kg });
  }
  if (current?.max_height_cm && child.heightCm) {
    used.push({ by: "height", used: child.heightCm.value / current.max_height_cm });
  }
  const closest = used.sort((a, b) => b.used - a.used)[0] ?? null;

  const newest = [child.weightKg?.on, child.heightCm?.on].filter(Boolean).sort().pop();
  const stale = !newest || daysBetween(newest, today) > 60;
  const remeasure = addDays(today, closest && closest.used >= CLOSE ? 30 : 90);

  const caveats = [
    "Limits come from the seat's manual; check the cited pages and any fit rules that aren't numbers.",
    "A certified child passenger safety technician can check the fit in person.",
  ];
  if (stale) {
    caveats.unshift(
      "The latest measurement is over two months old (or missing); measure again before relying on this.",
    );
  }

  return {
    modes: checks,
    current_mode: current ? MODE_NAMES[current.mode] : null,
    closest_limit: closest ? { by: closest.by, used: round(closest.used, 2) } : null,
    remeasure_by: remeasure,
    stale_measurements: stale,
    caveats,
  };
}

function checkMode(m: SeatModeRow, child: ChildFacts, age: number | null): ModeCheck {
  const limits: string[] = [];
  if (m.min_weight_kg != null || m.max_weight_kg != null) {
    limits.push(`weight ${range(m.min_weight_kg, m.max_weight_kg, showKg)}`);
  }
  if (m.min_height_cm != null || m.max_height_cm != null) {
    limits.push(`height ${range(m.min_height_cm, m.max_height_cm, showCm)}`);
  }
  if (m.min_age_months != null) limits.push(`at least ${m.min_age_months} months old`);

  const w = child.weightKg?.value;
  const h = child.heightCm?.value;
  let fit: Fit = "unknown";
  if (w != null || h != null) {
    const over =
      (w != null && m.max_weight_kg != null && w > m.max_weight_kg) ||
      (h != null && m.max_height_cm != null && h > m.max_height_cm);
    const under =
      (w != null && m.min_weight_kg != null && w < m.min_weight_kg) ||
      (h != null && m.min_height_cm != null && h < m.min_height_cm);
    const young = age != null && m.min_age_months != null && age < m.min_age_months;
    fit = over ? "outgrown" : under ? "too_small" : young ? "too_young" : "fits";
  }

  const room_left: string[] = [];
  if (fit === "fits") {
    if (w != null && m.max_weight_kg != null)
      room_left.push(`${showKg(m.max_weight_kg - w)} of weight`);
    if (h != null && m.max_height_cm != null)
      room_left.push(`${showCm(m.max_height_cm - h)} of height`);
  }

  return {
    mode: m.mode,
    name: MODE_NAMES[m.mode],
    fit,
    limits,
    room_left,
    manual_page: m.source_page,
    fit_note: m.fit_note,
  };
}

function range(min: number | null, max: number | null, show: (n: number) => string): string {
  if (min != null && max != null) return `${show(min)} to ${show(max)}`;
  if (max != null) return `up to ${show(max)}`;
  return `from ${show(min ?? 0)}`;
}
