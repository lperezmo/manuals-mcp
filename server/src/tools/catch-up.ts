import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  applyPlan,
  askForPlan,
  describeHistory,
  type History,
  historySchema,
  loadHistory,
  PlanError,
  planInputs,
  saveHistory,
} from "../catch-up.js";
import type { Db, ItemRow } from "../db.js";
import type { Env } from "../env.js";
import { relativeDay } from "../lib/schedule.js";
import { BUDGET_USED, logRun, modelRunsTodayAll, runsToday } from "../runs.js";
import { findItem, guarded, itemLabel, reply, session } from "./context.js";

// "This washer was never maintained, fix the schedule": saves what the user
// says about a thing's past and has Muse turn it into a catch-up plan. The
// website's "Catch up" button and the add-a-thing wizard call this too.

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "catch_up",
    {
      title: "Catch up a thing that isn't new",
      description: [
        "For a thing that isn't new: used for years, never maintained, or coming out of storage.",
        "Saves what the user says about its history, then Muse plans catch-up or recommissioning steps (cited to manual pages where the manual covers them, flagged for review where it's general advice) and reschedules its upkeep:",
        "tasks the user already does are dated from when they last did them, tasks never done or unknown come due now or over the next few weeks, and catch-up steps are added as one-time tasks.",
        "Run it after the manual is read. Pass only what the user said; a saved history is reused when nothing new is given. Running it again replaces the earlier plan's steps that aren't done.",
      ].join(" "),
      inputSchema: historySchema.partial().extend({
        item: z.string().min(1).describe("Item id or name."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ item: ref, ...given }, ctx) =>
      guarded(async () => {
        const { db, householdId } = await session(env, ctx);
        const item = await findItem(db, ref);
        const saved = await loadHistory(db, item.id);
        const condition = given.condition ?? saved?.condition;
        if (!condition) {
          throw new Error(
            "Ask whether it's new, used for a while, or coming out of storage, and what has been done to it, then pass condition and done.",
          );
        }
        const fresh = Object.values(given).some((v) => v !== undefined);
        const history: History = fresh
          ? { ...given, condition }
          : {
              condition,
              age_years: saved?.age_years,
              idle_months: saved?.idle_months,
              done: saved?.done,
              goal: saved?.goal,
            };
        if (fresh) await saveHistory(db, item.id, history);
        const label = itemLabel(item);
        if (condition === "new") {
          return reply(
            `${label} is new, so there's nothing to catch up. Its schedule counts from the day it was added.`,
            { item_id: item.id, history },
          );
        }
        return reply(...(await catchUp(env, db, householdId, item, history)));
      }),
  );
}

async function catchUp(
  env: Env,
  db: Db,
  householdId: string,
  item: ItemRow,
  history: History,
): Promise<[string, unknown]> {
  if (!env.reader) throw new Error("Muse isn't set up here, so it can't make a plan.");
  if ((await runsToday(db, "plan")) >= env.planDailyLimit) {
    throw new Error(
      `That's all the catch-up plans for today (${env.planDailyLimit}). It resets within a day.`,
    );
  }
  if ((await modelRunsTodayAll(db)) >= env.globalDailyLimit) throw new Error(BUDGET_USED);

  const label = itemLabel(item);
  const { tasks, pages, manualId } = await planInputs(db, item.id);
  const started = Date.now();
  let asked: Awaited<ReturnType<typeof askForPlan>>;
  try {
    asked = await askForPlan(env, { itemLabel: label, history, tasks, pages });
  } catch (err) {
    await logRun(db, {
      kind: "plan",
      ok: false,
      model: err instanceof PlanError ? (err.usage?.model ?? env.reader.model) : env.reader.model,
      error: (err as Error).message,
      ms: Date.now() - started,
      tokens_in: err instanceof PlanError ? err.usage?.tokens_in : null,
      tokens_out: err instanceof PlanError ? err.usage?.tokens_out : null,
      item_id: item.id,
      manual_id: manualId ?? undefined,
      raw_output: err instanceof PlanError ? err.raw : null,
    });
    throw new Error("Muse couldn't make a catch-up plan this time. Try again in a bit.");
  }
  await logRun(db, {
    kind: "plan",
    ok: true,
    model: asked.usage.model,
    ms: Date.now() - started,
    tokens_in: asked.usage.tokens_in,
    tokens_out: asked.usage.tokens_out,
    item_id: item.id,
    manual_id: manualId ?? undefined,
    pages_sent: pages.map((p) => p.page_number),
    chars_sent: pages.reduce((n, p) => n + p.content.length, 0),
    raw_output: asked.raw,
  });

  const seeded = await applyPlan({ db, householdId, item, manualId, plan: asked.plan });
  const toCheck = seeded.steps.filter((s) => !s.cited).length;
  const parts = [
    seeded.steps.length
      ? `${seeded.steps.length} catch-up ${seeded.steps.length === 1 ? "step" : "steps"}${toCheck ? ` (${toCheck} general advice, flagged to check)` : ""}`
      : "",
    seeded.done
      ? `${seeded.done} ${seeded.done === 1 ? "task" : "tasks"} you already do kept on ${seeded.done === 1 ? "its" : "their"} dates`
      : "",
    seeded.due
      ? `${seeded.due} due ${seeded.through && relativeDay(seeded.through) !== "today" ? `between today and ${seeded.through}, a couple at a time` : "today"}`
      : "",
  ].filter(Boolean);
  const summary = [
    `Caught up ${label}${parts.length ? `: ${parts.join("; ")}.` : "."}`,
    seeded.summary,
    manualId ? "" : "No manual is read yet, so none of it is from the manual.",
  ]
    .filter(Boolean)
    .join(" ");
  return [
    summary,
    {
      item_id: item.id,
      history: describeHistory(history),
      plan: seeded,
      pages_read: pages.map((p) => p.page_number),
    },
  ];
}
