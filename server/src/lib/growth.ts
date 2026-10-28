import who from "../data/who-lms.json" with { type: "json" };

// WHO Child Growth Standards, 0-60 months, as LMS parameters. A child's
// measurement becomes a z-score on the curve for their age; assuming they
// keep tracking that z-score, we can estimate when they'll reach a limit.
// It's an estimate, and every answer built on it has to say so.

export type Metric = "weight_kg" | "height_cm";
export type GrowthSex = "female" | "male";

type Row = [month: number, l: number, m: number, s: number];
const TABLES = who as unknown as Record<Metric, Record<GrowthSex, Row[]>>;

export const WHO_MAX_MONTHS = 60;
const DAYS_PER_MONTH = 30.4375;
const MS_PER_DAY = 86_400_000;

export function ageInMonths(birthDate: string, on: string): number {
  return (Date.parse(on) - Date.parse(birthDate)) / MS_PER_DAY / DAYS_PER_MONTH;
}

export function addDays(day: string, days: number): string {
  return new Date(Date.parse(day) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** LMS parameters at a (fractional) age, interpolated between whole months. */
export function lmsAt(metric: Metric, sex: GrowthSex, months: number): [number, number, number] {
  const rows = TABLES[metric][sex];
  const clamped = Math.min(Math.max(months, 0), WHO_MAX_MONTHS);
  const lo = Math.floor(clamped);
  const hi = Math.min(lo + 1, WHO_MAX_MONTHS);
  const a = rows[lo];
  const b = rows[hi];
  if (!a || !b) throw new Error(`No WHO row for month ${lo}`);
  const t = clamped - lo;
  return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

export function zScore(value: number, [l, m, s]: [number, number, number]): number {
  return l === 0 ? Math.log(value / m) / s : ((value / m) ** l - 1) / (l * s);
}

export function valueAtZ(z: number, [l, m, s]: [number, number, number]): number {
  return l === 0 ? m * Math.exp(s * z) : m * (1 + l * s * z) ** (1 / l);
}

/** Percentile (0-100) for a z-score, via the normal CDF. */
export function percentile(z: number): number {
  // Abramowitz-Stegun 7.1.26 approximation of erf.
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  const cdf = 0.5 * (1 + Math.sign(z) * erf);
  return Math.round(cdf * 1000) / 10;
}

export interface Projection {
  metric: Metric;
  limit: number;
  /** Day the child is estimated to reach the limit, or null when it isn't reached by 60 months. */
  reachesOn: string | null;
  alreadyReached: boolean;
  zScore: number;
  percentile: number;
}

/**
 * Estimates when a measurement taken on `measuredOn` grows past `limit`,
 * assuming the child keeps the same z-score. With no sex given, uses
 * whichever table reaches the limit first, so reminders err early.
 */
export function projectToLimit(args: {
  metric: Metric;
  sex: GrowthSex | null;
  birthDate: string;
  measuredOn: string;
  value: number;
  limit: number;
}): Projection {
  const sexes: GrowthSex[] = args.sex ? [args.sex] : ["female", "male"];
  const results = sexes.map((sex) => projectOne({ ...args, sex }));
  results.sort((a, b) => (a.reachesOn ?? "9999").localeCompare(b.reachesOn ?? "9999"));
  const first = results[0];
  if (!first) throw new Error("no projection");
  return first;
}

function projectOne(args: {
  metric: Metric;
  sex: GrowthSex;
  birthDate: string;
  measuredOn: string;
  value: number;
  limit: number;
}): Projection {
  const age = ageInMonths(args.birthDate, args.measuredOn);
  const z = Math.max(-3.5, Math.min(3.5, zScore(args.value, lmsAt(args.metric, args.sex, age))));
  const base = { metric: args.metric, limit: args.limit, zScore: z, percentile: percentile(z) };
  if (args.value >= args.limit) {
    return { ...base, reachesOn: args.measuredOn, alreadyReached: true };
  }
  // Step a week at a time to the end of the WHO range, then refine by day.
  const endDays = Math.ceil((WHO_MAX_MONTHS - age) * DAYS_PER_MONTH);
  for (let d = 7; d <= endDays + 7; d += 7) {
    const months = age + d / DAYS_PER_MONTH;
    if (months > WHO_MAX_MONTHS) break;
    if (valueAtZ(z, lmsAt(args.metric, args.sex, months)) >= args.limit) {
      let day = d - 6;
      while (
        day < d &&
        valueAtZ(z, lmsAt(args.metric, args.sex, age + day / DAYS_PER_MONTH)) < args.limit
      ) {
        day++;
      }
      return { ...base, reachesOn: addDays(args.measuredOn, day), alreadyReached: false };
    }
  }
  return { ...base, reachesOn: null, alreadyReached: false };
}
