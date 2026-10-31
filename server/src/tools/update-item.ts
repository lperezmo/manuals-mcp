import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ChildRow } from "../db.js";
import type { Env } from "../env.js";
import { findItem, guarded, ITEM_COLUMNS, isUuid, itemLabel, reply, session } from "./context.js";

// Chat-only: saves what the user tells Muse about a thing they already added
// (when it was bought, who it's for, how often it's used). Runs as the user,
// so RLS keeps it to their own household.

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "update_item",
    {
      title: "Update a thing's details",
      description:
        "Saves details the user gives about a thing already added: nickname, brand, model, serial, purchase date, uses a week, who it's for (a child's id or nickname), notes. Only pass what the user said.",
      inputSchema: z.object({
        item: z.string().min(1).describe("Item id or name."),
        nickname: z.string().min(1).max(80).optional(),
        brand: z.string().max(80).optional(),
        model: z.string().max(80).optional(),
        serial: z.string().max(80).optional(),
        purchased_on: z.iso.date().optional().describe("YYYY-MM-DD"),
        uses_per_week: z.number().positive().max(100).optional(),
        child: z
          .string()
          .min(1)
          .max(60)
          .optional()
          .describe(
            "Child id or nickname this belongs to. Add the child first with record_measurement if new.",
          ),
        notes: z.string().max(500).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ item: ref, child, ...fields }, ctx) =>
      guarded(async () => {
        const { db } = await session(env, ctx);
        const item = await findItem(db, ref);
        const change: Record<string, unknown> = Object.fromEntries(
          Object.entries(fields).filter(([, v]) => v !== undefined),
        );
        if (child) {
          const { data, error } = await db.from("children").select("id, nickname, birth_date");
          if (error) throw new Error(error.message);
          const kids = (data ?? []) as ChildRow[];
          const hit =
            (isUuid(child) && kids.find((c) => c.id === child)) ||
            kids.find((c) => c.nickname.toLowerCase() === child.toLowerCase());
          if (!hit) {
            const names = kids.map((c) => c.nickname).join(", ") || "none yet";
            throw new Error(
              `No child called "${child}" (children: ${names}). Add them with record_measurement first.`,
            );
          }
          change.child_id = hit.id;
        }
        if (!Object.keys(change).length) throw new Error("Nothing to change.");
        const { data, error } = await db
          .from("items")
          .update(change)
          .eq("id", item.id)
          .select(ITEM_COLUMNS)
          .single();
        if (error) throw new Error(`Couldn't save it: ${error.message}`);
        return reply(`Saved ${Object.keys(change).join(", ")} for ${itemLabel(item)}.`, {
          item: data,
        });
      }),
  );
}
