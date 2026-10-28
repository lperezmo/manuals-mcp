import type { TaskRow } from "../db.js";

// Plain-words descriptions of upkeep intervals. The due-date math itself
// lives in the database (public.next_due) so the app and the server agree.

export type IntervalUnit = TaskRow["interval_unit"];

export function describeInterval(unit: IntervalUnit, value: number | null): string {
  const n = value ?? 1;
  switch (unit) {
    case "days":
      return n === 1 ? "every day" : `every ${n} days`;
    case "weeks":
      return n === 1 ? "every week" : `every ${n} weeks`;
    case "months":
      return n === 1 ? "every month" : `every ${n} months`;
    case "cycles":
      return `every ${n} uses`;
    case "once":
      return "once";
    case "as_needed":
      return "as needed";
  }
}

export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** "today", "tomorrow", "in 5 days", "3 days ago" */
export function relativeDay(day: string, from: string = today()): string {
  const d = daysBetween(from, day);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}
