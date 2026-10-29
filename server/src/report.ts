import { z } from "zod";
import type { Db } from "./db.js";
import type { Env } from "./env.js";

// "Report an issue": saved to issue_reports as the user, then pushed to the
// maintainer's phone through ntfy when NTFY_TOPIC is set. The push never
// decides whether the report counts; the saved row does.

export const REPORT_DAILY_LIMIT = 10;

export const reportSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  page: z.string().max(200).optional(),
  run_id: z.uuid().optional(),
  debug: z.string().max(20_000).optional(),
});

export type Report = z.infer<typeof reportSchema>;

/** How many reports the household filed in the last 24 hours. */
export async function reportsToday(db: Db): Promise<number> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count, error } = await db
    .from("issue_reports")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since);
  if (error) throw new Error(`Couldn't check today's reports: ${error.message}`);
  return count ?? 0;
}

export async function saveReport(
  db: Db,
  report: Report,
  userAgent: string | null,
): Promise<string> {
  const { data, error } = await db
    .from("issue_reports")
    .insert({ ...report, user_agent: userAgent?.slice(0, 400) ?? null })
    .select("id")
    .single();
  if (error) throw new Error(`Couldn't save the report: ${error.message}`);
  return (data as { id: string }).id;
}

/** Pushes a short note to the maintainer's phone. Returns whether it went out. */
export async function pushReport(
  env: Env,
  report: Report & { id: string; email?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!env.notify) return false;
  const lines = [
    report.message,
    "",
    report.page ? `Page: ${report.page}` : null,
    report.run_id ? `Run: ${report.run_id}` : null,
    report.email ? `From: ${report.email}` : null,
    `Report: ${report.id}`,
  ].filter((l) => l !== null);
  try {
    const res = await fetchImpl(`${env.notify.url}/${encodeURIComponent(env.notify.topic)}`, {
      method: "POST",
      headers: {
        Title: "Manuals: issue reported",
        Tags: "warning",
        ...(env.publicUrl ? { Click: `${env.publicUrl}/runs` } : {}),
      },
      body: lines.join("\n"),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
