import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../env.js";
import { relativeDay, today } from "../lib/schedule.js";
import { guarded, ITEM_COLUMNS, reply, session } from "./context.js";

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "list_items",
    {
      title: "List household items",
      description:
        "Lists the appliances, baby gear and other things registered in the user's household, with each one's manual status, its next upkeep task, and how many facts need review. Call this first when the user mentions a thing by a loose name and you need its id, or asks what they have registered.",
      inputSchema: z.object({
        kind: z
          .enum(["appliance", "baby_gear", "vehicle", "other"])
          .optional()
          .describe("Only list this kind of thing."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ kind }, ctx) =>
      guarded(async () => {
        const { db } = await session(env, ctx);
        let query = db
          .from("items")
          .select(
            `${ITEM_COLUMNS}, manuals(id, status, page_count), tasks(title, next_due_on, active), manual_facts(status)`,
          )
          .order("created_at");
        if (kind) query = query.eq("kind", kind);
        const { data, error } = await query;
        if (error) throw new Error(`Couldn't read your things: ${error.message}`);
        const now = today();
        const items = (data ?? []).map((row) => {
          const tasks = (
            (row.tasks ?? []) as { title: string; next_due_on: string | null; active: boolean }[]
          )
            .filter((t) => t.active && t.next_due_on)
            .sort((a, b) => (a.next_due_on ?? "").localeCompare(b.next_due_on ?? ""));
          const next = tasks[0];
          const manuals = (row.manuals ?? []) as { status: string; page_count: number | null }[];
          const facts = (row.manual_facts ?? []) as { status: string }[];
          return {
            id: row.id,
            nickname: row.nickname,
            kind: row.kind,
            category: row.category,
            brand: row.brand,
            model: row.model,
            manual: manuals[0] ? { status: manuals[0].status, pages: manuals[0].page_count } : null,
            next_task: next
              ? {
                  title: next.title,
                  due_on: next.next_due_on,
                  when: relativeDay(next.next_due_on ?? now, now),
                }
              : null,
            facts: facts.length,
            needs_review: facts.filter((f) => f.status === "needs_review").length,
          };
        });
        if (items.length === 0) {
          return reply(
            "Nothing is registered yet. Offer to add things with add_item (brand and model help find the manual).",
          );
        }
        return reply(
          `${items.length} item${items.length === 1 ? "" : "s"} in this household.`,
          items,
        );
      }),
  );
}
