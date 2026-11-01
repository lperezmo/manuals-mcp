import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../env.js";
import { LIMITS } from "../finder/knowledge.js";
import { today } from "../lib/schedule.js";
import { round, toCm, toKg } from "../lib/units.js";
import { guarded, reply, session } from "./context.js";

// Facts, tasks and seat limits start as what the reader (Muse Spark) pulled
// out of a manual. Any assistant can check one against its page and revise
// it; the user always has the last word. Every change keeps its before and
// after in public.revisions.

const TABLES = {
  fact: {
    table: "manual_facts",
    columns: "id, item_id, kind, label, value, source_page, source, status",
  },
  task: {
    table: "tasks",
    columns:
      "id, item_id, title, details, interval_unit, interval_value, last_done_on, source_page, source, status, active",
  },
  seat_limit: {
    table: "seat_modes",
    columns:
      "id, item_id, mode, min_weight_kg, max_weight_kg, min_height_cm, max_height_cm, fit_note, source_page, source, status",
  },
} as const;

type Kind = keyof typeof TABLES;

const changesSchema = z
  .object({
    label: z.string().min(1).max(120).optional().describe("fact"),
    value: z.string().min(1).max(1000).optional().describe("fact"),
    kind: z.enum(["error_code", "part", "spec", "safety", "other"]).optional().describe("fact"),
    title: z.string().min(1).max(160).optional().describe("task"),
    details: z.string().max(1000).optional().describe("task"),
    interval_unit: z
      .enum(["days", "weeks", "months", "cycles", "once", "as_needed"])
      .optional()
      .describe("task"),
    interval_value: z.number().int().positive().optional().describe("task"),
    active: z.boolean().optional().describe("task: false to stop reminding"),
    min_weight: z.number().positive().optional().describe("seat_limit"),
    max_weight: z.number().positive().optional().describe("seat_limit"),
    weight_unit: z.enum(["kg", "lb"]).default("kg"),
    min_height: z.number().positive().optional().describe("seat_limit"),
    max_height: z.number().positive().optional().describe("seat_limit"),
    height_unit: z.enum(["cm", "in"]).default("cm"),
    fit_note: z.string().max(LIMITS.fit_note).optional().describe("seat_limit"),
    source_page: z.number().int().positive().optional(),
  })
  .partial();

/** Maps the tool's loose changes onto real columns for one table. */
export function columnsFor(kind: Kind, c: z.infer<typeof changesSchema>) {
  const pick = (keys: string[]) =>
    Object.fromEntries(
      keys
        .map((k) => [k, (c as Record<string, unknown>)[k]] as const)
        .filter(([, v]) => v !== undefined),
    );
  if (kind === "fact") return pick(["label", "value", "kind", "source_page"]);
  if (kind === "task") {
    return pick(["title", "details", "interval_unit", "interval_value", "active", "source_page"]);
  }
  const wu = c.weight_unit ?? "kg";
  const hu = c.height_unit ?? "cm";
  return {
    ...pick(["fit_note", "source_page"]),
    ...(c.min_weight === undefined ? {} : { min_weight_kg: round(toKg(c.min_weight, wu), 2) }),
    ...(c.max_weight === undefined ? {} : { max_weight_kg: round(toKg(c.max_weight, wu), 2) }),
    ...(c.min_height === undefined ? {} : { min_height_cm: round(toCm(c.min_height, hu), 1) }),
    ...(c.max_height === undefined ? {} : { max_height_cm: round(toCm(c.max_height, hu), 1) }),
  };
}

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "revise_fact",
    {
      title: "Correct or confirm a fact",
      description: [
        "Corrects or confirms one fact, upkeep task or car seat limit that was read from a manual.",
        'Use it when the user says something "doesn\'t sound right": first read the source page with ask_manual (item and page), compare, then pass the corrected fields in changes and a short reason that cites the page.',
        "Pass no changes to confirm it as checked.",
        'Pass not_applicable true when the user says a line is for a part or feature their model does not have ("my washer has no lint filter"): it stops the reminder and drops it from review and from what ask_manual returns, and the history keeps it.',
        'Set source to "user" only when the user states the value themselves ("trust me, it\'s 2 hours"); otherwise "assistant".',
        "Sources rank user over assistant over the manual reader: an assistant can't change something the user set, so ask them instead. The old value is always kept in the history.",
      ].join(" "),
      inputSchema: z.object({
        id: z.uuid().describe("The fact, task or seat limit id from ask_manual or upcoming."),
        type: z.enum(["fact", "task", "seat_limit"]).describe("What the id points at."),
        changes: changesSchema.optional(),
        not_applicable: z
          .boolean()
          .optional()
          .describe("true: this doesn't apply to the user's model, so stop showing it."),
        reason: z.string().min(1).max(1000).describe('e.g. "Page 38 says warm water, no vinegar."'),
        source: z.enum(["assistant", "user"]).default("assistant"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, type, changes, not_applicable, reason, source }, ctx) =>
      guarded(async () => {
        const { db, householdId } = await session(env, ctx);
        const { table, columns } = TABLES[type];
        const { data: before, error } = await db
          .from(table)
          .select(columns)
          .eq("id", id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!before)
          throw new Error(`No ${type.replace("_", " ")} with that id in this household.`);
        const current = before as unknown as Record<string, unknown>;

        const update: Record<string, unknown> = changes ? columnsFor(type, changes) : {};
        if (not_applicable && type === "task") update.active = false;
        const changing = Object.keys(update).length > 0 || !!not_applicable;
        if (changing && current.source === "user" && source === "assistant") {
          return reply(
            "The user set this one themselves, so it isn't changed. Tell them what the manual says and ask; if they agree, call again with source user.",
            { current },
          );
        }

        update.source = changing ? source : current.source;
        update.status = not_applicable ? "not_applicable" : changing ? "revised" : "confirmed";

        if (type === "task" && (update.interval_unit || update.interval_value)) {
          const unit = (update.interval_unit ?? current.interval_unit) as string;
          const amount = (update.interval_value ?? current.interval_value) as number | null;
          const { data: item } = await db
            .from("items")
            .select("uses_per_week")
            .eq("id", current.item_id as string)
            .single();
          const { data: next } = await db.rpc("next_due", {
            unit,
            amount,
            from_day: (current.last_done_on as string | null) ?? today(),
            uses_per_week: item?.uses_per_week ?? null,
          });
          update.next_due_on = next ?? null;
        }

        const { data: after, error: updateError } = await db
          .from(table)
          .update(update)
          .eq("id", id)
          .select(columns)
          .single();
        if (updateError) throw new Error(`Couldn't save it: ${updateError.message}`);

        const { error: logError } = await db.from("revisions").insert({
          household_id: householdId,
          target_table: table,
          target_id: id,
          before: current,
          after,
          source,
          reason,
        });
        if (logError) throw new Error(`Saved, but couldn't log the change: ${logError.message}`);

        return reply(
          not_applicable
            ? "Marked as not applying to this one. It's kept in the history."
            : changing
              ? `Revised. The earlier version is kept in the history.`
              : `Confirmed as checked.`,
          { before: current, after },
        );
      }),
  );
}
