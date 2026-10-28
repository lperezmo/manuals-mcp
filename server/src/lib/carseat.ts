import type { SeatModeRow } from "../db.js";
import { addDays, type GrowthSex, type Projection, projectToLimit } from "./growth.js";
import { daysBetween } from "./schedule.js";
import { showCm, showKg } from "./units.js";

// Compares a child to a seat's limits, mode by mode, and estimates when the
// child outgrows the mode they fit now. Seats are used in the earliest mode
// that still fits (rear-facing as long as the seat allows), so the "next
// switch" is when that mode's first limit is reached.

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

export interface Reading {
  value: number;
  on: string;
}

export interface ChildFacts {
  birthDate: string | null;
  sex: GrowthSex | null;
  weightKg: Reading | null;
  heightCm: Reading | null;
}

export type Fit = "fits" | "too_small" | "outgrown" | "unknown";

export interface ModeCheck {
  mode: SeatModeRow["mode"];
  name: string;
  fit: Fit;
  limits: string[];
  manual_page: number | null;
  fit_note: string | null;
  outgrows_on: string | null;
  outgrown_by: "weight" | "height" | null;
}

export interface SeatCheck {
  modes: ModeCheck[];
  current_mode: string | null;
  next_switch_on: string | null;
  remeasure_by: string;
  stale_measurements: boolean;
  caveats: string[];
}

export function checkSeat(modes: SeatModeRow[], child: ChildFacts, today: string): SeatCheck {
  const sorted = [...modes].sort((a, b) => MODE_ORDER.indexOf(a.mode) - MODE_ORDER.indexOf(b.mode));
  const checks = sorted.map((m) => checkMode(m, child));
  const current = checks.find((c) => c.fit === "fits") ?? null;
  const next = current?.outgrows_on ?? null;

  const newest = [child.weightKg?.on, child.heightCm?.on].filter(Boolean).sort().pop();
  const stale = !newest || daysBetween(newest, today) > 60;

  let remeasure = addDays(today, 90);
  if (next) {
    const early = addDays(next, -30);
    if (early < remeasure) remeasure = early;
  }
  if (remeasure < addDays(today, 7)) remeasure = addDays(today, 7);

  const caveats = [
    "Dates are estimates from WHO growth curves, assuming the child keeps growing along the same percentile.",
    "Limits come from the seat's manual; check the cited pages and any fit rules that aren't numbers.",
    "A certified child passenger safety technician can check the fit in person.",
  ];
  if (stale)
    caveats.unshift(
      "The latest measurement is over two months old (or missing); re-measure before relying on this.",
    );
  if (!child.birthDate)
    caveats.unshift(
      "No birth date saved, so no growth projection; only the current fit is checked.",
    );
  if (child.birthDate && !child.sex) {
    caveats.push(
      "No growth table chosen for this child, so the earlier of the two WHO tables is used.",
    );
  }

  return {
    modes: checks,
    current_mode: current?.name ?? null,
    next_switch_on: next,
    remeasure_by: remeasure,
    stale_measurements: stale,
    caveats,
  };
}

function checkMode(m: SeatModeRow, child: ChildFacts): ModeCheck {
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
    fit = over ? "outgrown" : under ? "too_small" : "fits";
  }

  let outgrows_on: string | null = null;
  let outgrown_by: ModeCheck["outgrown_by"] = null;
  if (fit === "fits" && child.birthDate) {
    const projections: { by: "weight" | "height"; p: Projection }[] = [];
    if (child.weightKg && m.max_weight_kg != null) {
      projections.push({
        by: "weight",
        p: projectToLimit({
          metric: "weight_kg",
          sex: child.sex,
          birthDate: child.birthDate,
          measuredOn: child.weightKg.on,
          value: child.weightKg.value,
          limit: m.max_weight_kg,
        }),
      });
    }
    if (child.heightCm && m.max_height_cm != null) {
      projections.push({
        by: "height",
        p: projectToLimit({
          metric: "height_cm",
          sex: child.sex,
          birthDate: child.birthDate,
          measuredOn: child.heightCm.on,
          value: child.heightCm.value,
          limit: m.max_height_cm,
        }),
      });
    }
    const dated = projections
      .filter((x) => x.p.reachesOn)
      .sort((a, b) => (a.p.reachesOn ?? "").localeCompare(b.p.reachesOn ?? ""));
    if (dated[0]) {
      outgrows_on = dated[0].p.reachesOn;
      outgrown_by = dated[0].by;
    }
  }

  return {
    mode: m.mode,
    name: MODE_NAMES[m.mode],
    fit,
    limits,
    manual_page: m.source_page,
    fit_note: m.fit_note,
    outgrows_on,
    outgrown_by,
  };
}

function range(min: number | null, max: number | null, show: (n: number) => string): string {
  if (min != null && max != null) return `${show(min)} to ${show(max)}`;
  if (max != null) return `up to ${show(max)}`;
  return `from ${show(min ?? 0)}`;
}
