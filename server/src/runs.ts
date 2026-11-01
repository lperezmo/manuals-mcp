import type { Db } from "./db.js";

// The model_runs log: one row per manual read, chat turn, search, label photo or catch-up plan, written as the
// user so it lands in their household. Logging never breaks the real work.

const MAX_RAW_CHARS = 20_000;

export interface ModelRun {
  kind: "read" | "chat" | "search" | "snap" | "plan";
  ok: boolean;
  model?: string | null;
  error?: string | null;
  ms?: number;
  tokens_in?: number | null;
  tokens_out?: number | null;
  item_id?: string;
  manual_id?: string;
  pages_sent?: number[];
  chars_sent?: number;
  tools_used?: string[];
  raw_output?: string | null;
}

export async function logRun(db: Db, run: ModelRun): Promise<void> {
  try {
    await db
      .from("model_runs")
      .insert({ ...run, raw_output: run.raw_output?.slice(0, MAX_RAW_CHARS) ?? null });
  } catch {}
}

/** How many runs of this kind the household made in the last 24 hours. */
export async function runsToday(db: Db, kind: ModelRun["kind"]): Promise<number> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count, error } = await db
    .from("model_runs")
    .select("id", { count: "exact", head: true })
    .eq("kind", kind)
    .gte("created_at", since);
  if (error) throw new Error(`Couldn't check today's usage: ${error.message}`);
  return count ?? 0;
}

/** Model calls (reads, chats, label photos, catch-up plans) across every household in the last 24 hours. */
export async function modelRunsTodayAll(db: Db): Promise<number> {
  const { data, error } = await db.rpc("model_runs_today_all");
  if (error) throw new Error(`Couldn't check today's usage: ${error.message}`);
  return typeof data === "number" ? data : 0;
}

export const BUDGET_USED =
  "Manuals has used its model budget for today. It resets within a day; everything else still works.";
