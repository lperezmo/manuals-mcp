import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { TaskRow } from "../db.js";
import type { Env } from "../env.js";
import { addDays, relativeDay, today } from "../lib/schedule.js";
import { findItem, guarded, isUuid, itemLabel, reply, session } from "./context.js";

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "log_done",
    {
      title: "Mark an upkeep task done",
      description:
        'Marks an upkeep task done (today unless the user says otherwise) and starts its next interval. "I just ran the tub clean" means find the washer\'s tub clean task and log it. Pass the task id, or the item plus a few words of the task title.',
      inputSchema: z.object({
        task: z.string().min(1).describe("Task id, or words from its title."),
        item: z.string().optional().describe("Item id or name, to narrow the task search."),
        days_ago: z
          .number()
          .int()
          .min(0)
          .max(3650)
          .optional()
          .describe(
            'How many days ago it was done, for "yesterday" (1), "a week ago" (7) and the like. Prefer this over done_on: the server knows the date.',
          ),
        done_on: z.iso.date().optional().describe("YYYY-MM-DD, only when the user names a date."),
        note: z.string().max(300).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ task, item, days_ago, done_on, note }, ctx) =>
      guarded(async () => {
        const { db } = await session(env, ctx);
        let taskId = isUuid(task) ? task : null;
        let label = "";
        if (!taskId) {
          let q = db
            .from("tasks")
            .select("id, title, item_id, items!inner(archived_at)")
            .eq("active", true)
            .is("items.archived_at", null);
          if (item) {
            const it = await findItem(db, item);
            label = ` for ${itemLabel(it)}`;
            q = q.eq("item_id", it.id);
          }
          const { data, error } = await q;
          if (error) throw new Error(error.message);
          const words = task
            .toLowerCase()
            .split(/\W+/)
            .filter((w) => w.length > 2);
          const scored = (data ?? [])
            .map((t) => ({
              t,
              score: words.filter((w) => t.title.toLowerCase().includes(w)).length,
            }))
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score);
          const first = scored[0];
          if (!first)
            throw new Error(
              `No upkeep task${label} matches "${task}". Check the schedule with ask_manual.`,
            );
          if (scored[1] && scored[1].score === first.score) {
            const options = scored
              .filter((s) => s.score === first.score)
              .map((s) => `${s.t.title} (${s.t.id})`);
            throw new Error(`Several tasks match: ${options.join(", ")}. Ask which one.`);
          }
          taskId = first.t.id;
        }
        // Relative days are counted here: a model often doesn't know today's date.
        const day = days_ago != null ? addDays(today(), -days_ago) : (done_on ?? today());
        const { data, error } = await db.rpc("log_task_done", {
          p_task: taskId,
          p_done_on: day,
          p_note: note ?? null,
        });
        if (error) throw new Error(`Couldn't log it: ${error.message}`);
        const t = data as TaskRow;
        const next = t.next_due_on
          ? ` Next due ${t.next_due_on} (${relativeDay(t.next_due_on)}).`
          : "";
        const when = day === today() ? "today" : `on ${day} (${relativeDay(day)})`;
        return reply(`Logged "${t.title}" as done ${when}.${next}`, t);
      }),
  );
}
