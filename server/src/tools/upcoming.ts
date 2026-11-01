import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../env.js";
import { addDays, describeInterval, relativeDay, today } from "../lib/schedule.js";
import { guarded, reply, session } from "./context.js";

type Named = { id: string; nickname: string } | { id: string; nickname: string }[] | null;
const itemName = (items: Named) => (Array.isArray(items) ? items[0] : items)?.nickname;

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "upcoming",
    {
      title: "What's coming up",
      description: [
        "One list across the whole household: upkeep tasks that are overdue or due soon, plus anything read from a manual that a person should check (status needs_review).",
        'Use it for "what\'s due this week?", "anything I should know?" or a weekly home check.',
        "For a review item, read its page with ask_manual and fix or confirm it with revise_fact.",
        "If the user wants tasks on their calendar, add them with your own calendar tools.",
      ].join(" "),
      inputSchema: z.object({
        days: z.number().int().min(1).max(90).default(7).describe("How far ahead to look."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ days }, ctx) =>
      guarded(async () => {
        const { db } = await session(env, ctx);
        const now = today();
        const until = addDays(now, days);
        const [tasks, facts, taskReview, seats] = await Promise.all([
          db
            .from("tasks")
            .select(
              "id, title, interval_unit, interval_value, next_due_on, source_page, items!inner(id, nickname, archived_at)",
            )
            .eq("active", true)
            .is("items.archived_at", null)
            .lte("next_due_on", until)
            .order("next_due_on"),
          db
            .from("manual_facts")
            .select("id, kind, label, value, source_page, items!inner(id, nickname, archived_at)")
            .eq("status", "needs_review")
            .is("items.archived_at", null),
          db
            .from("tasks")
            .select("id, title, details, source_page, items!inner(id, nickname, archived_at)")
            .eq("status", "needs_review")
            .is("items.archived_at", null),
          db
            .from("seat_modes")
            .select("id, mode, fit_note, source_page, items!inner(id, nickname, archived_at)")
            .eq("status", "needs_review")
            .is("items.archived_at", null),
        ]);
        for (const r of [tasks, facts, taskReview, seats]) {
          if (r.error) throw new Error(r.error.message);
        }

        const due = (tasks.data ?? []).map((t) => ({
          task_id: t.id,
          item: itemName(t.items as Named),
          title: t.title,
          due_on: t.next_due_on,
          when: relativeDay(t.next_due_on as string, now),
          overdue: (t.next_due_on as string) < now,
          how_often: describeInterval(t.interval_unit, t.interval_value),
          page: t.source_page,
        }));
        const review = [
          ...(facts.data ?? []).map((f) => ({
            id: f.id,
            type: "fact",
            item: itemName(f.items as Named),
            what: `${f.label}: ${f.value}`,
            page: f.source_page,
          })),
          ...(taskReview.data ?? []).map((t) => ({
            id: t.id,
            type: "task",
            item: itemName(t.items as Named),
            what: t.details ? `${t.title}: ${t.details}` : t.title,
            page: t.source_page,
          })),
          ...(seats.data ?? []).map((s) => ({
            id: s.id,
            type: "seat_limit",
            item: itemName(s.items as Named),
            what: `${s.mode.replace(/_/g, " ")} limits${s.fit_note ? ` (${s.fit_note})` : ""}`,
            page: s.source_page,
          })),
        ];

        if (!due.length && !review.length) {
          return reply(`Nothing due in the next ${days} days, and nothing to review.`);
        }
        const overdue = due.filter((d) => d.overdue).length;
        return reply(
          `${due.length} task(s) due in the next ${days} days${overdue ? ` (${overdue} overdue)` : ""}, and ${review.length} thing(s) to review.`,
          { due, needs_review: review },
        );
      }),
  );
}
