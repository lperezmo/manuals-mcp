import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ChildRow, Db } from "../db.js";
import type { Env } from "../env.js";
import { today } from "../lib/schedule.js";
import { round, toCm, toKg } from "../lib/units.js";
import { findItem, guarded, isUuid, itemLabel, reply, session } from "./context.js";

/** Uses a week from cycle readings at least a week apart, or null. */
export function usesPerWeek(readings: { measured_on: string; value: number }[]): number | null {
  if (readings.length < 2) return null;
  const sorted = [...readings].sort((a, b) => a.measured_on.localeCompare(b.measured_on));
  const first = sorted[0] as { measured_on: string; value: number };
  const last = sorted[sorted.length - 1] as { measured_on: string; value: number };
  const days = (Date.parse(last.measured_on) - Date.parse(first.measured_on)) / 86_400_000;
  const used = last.value - first.value;
  if (days < 7 || used <= 0) return null;
  return Math.min(100, Math.round((used / days) * 7 * 10) / 10);
}

async function recordReading(
  db: Db,
  householdId: string,
  ref: string,
  kind: "cycles" | "hours",
  value: number,
  on: string,
) {
  const item = await findItem(db, ref);
  const { error } = await db
    .from("item_readings")
    .insert({ household_id: householdId, item_id: item.id, measured_on: on, kind, value });
  if (error) throw new Error(`Couldn't save it: ${error.message}`);
  let rate: number | null = null;
  if (kind === "cycles") {
    const { data } = await db
      .from("item_readings")
      .select("measured_on, value")
      .eq("item_id", item.id)
      .eq("kind", "cycles")
      .gte("measured_on", addDaysIso(on, -180));
    rate = usesPerWeek((data ?? []).map((r) => ({ ...r, value: Number(r.value) })));
    if (rate) await db.from("items").update({ uses_per_week: rate }).eq("id", item.id);
  }
  return reply(
    `Saved ${value} ${kind} for ${itemLabel(item)}.${rate ? ` That's about ${rate} uses a week, so cycle-based tasks now get dates from it.` : ""}`,
    { item_id: item.id, measured_on: on, kind, value, uses_per_week: rate },
  );
}

function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "record_measurement",
    {
      title: "Save a measurement or reading",
      description: [
        "Saves a reading for a child or a thing.",
        "For a child: height and/or weight, which car_seat_status compares with the seat's limits. Pass the child's id or nickname; for a child not saved yet, add birth_date. Accepts pounds and inches.",
        "For a thing: its cycle count (washes, loads, brews) or hours used, from its display or counter. Two cycle readings a week or more apart set how often it's used, so 'every 30 washes' tasks get real dates.",
      ].join(" "),
      inputSchema: z.object({
        child: z.string().min(1).max(60).optional().describe("Child id or nickname."),
        item: z.string().optional().describe("Item id or name, for a cycle count or hours."),
        cycles: z.number().nonnegative().optional(),
        hours: z.number().nonnegative().optional(),
        height: z.number().positive().optional(),
        height_unit: z.enum(["cm", "in"]).default("cm"),
        weight: z.number().positive().optional(),
        weight_unit: z.enum(["kg", "lb"]).default("kg"),
        measured_on: z.iso.date().optional().describe("YYYY-MM-DD, if not today."),
        birth_date: z.iso.date().optional().describe("Only needed to add a new child."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input, ctx) =>
      guarded(async () => {
        const { db, householdId } = await session(env, ctx);
        if (input.item) {
          const kind = input.cycles != null ? "cycles" : input.hours != null ? "hours" : null;
          if (!kind) throw new Error("Give the item's cycles or hours.");
          const value = (kind === "cycles" ? input.cycles : input.hours) as number;
          return recordReading(
            db,
            householdId,
            input.item,
            kind,
            value,
            input.measured_on ?? today(),
          );
        }
        if (!input.child) throw new Error("Say which child, or which item for a cycle count.");
        if (input.height == null && input.weight == null)
          throw new Error("Give a height, a weight, or both.");
        const childRef = input.child;
        const { data: kids, error } = await db.from("children").select("id, nickname, birth_date");
        if (error) throw new Error(error.message);
        const children = (kids ?? []) as ChildRow[];
        let child =
          (isUuid(childRef) && children.find((c) => c.id === childRef)) ||
          children.find((c) => c.nickname.toLowerCase() === childRef.toLowerCase()) ||
          (children.length === 1 && !input.birth_date ? children[0] : undefined);
        if (!child) {
          if (!input.birth_date) {
            const names = children.map((c) => c.nickname).join(", ") || "none yet";
            throw new Error(
              `No child called "${childRef}" (saved: ${names}). To add them, include birth_date.`,
            );
          }
          const created = await db
            .from("children")
            .insert({
              household_id: householdId,
              nickname: childRef,
              birth_date: input.birth_date,
            })
            .select("id, nickname, birth_date")
            .single();
          if (created.error) throw new Error(`Couldn't add the child: ${created.error.message}`);
          child = created.data as ChildRow;
        } else if (input.birth_date && !child.birth_date) {
          await db.from("children").update({ birth_date: input.birth_date }).eq("id", child.id);
          child = { ...child, birth_date: input.birth_date };
        }

        const on = input.measured_on ?? today();
        const height_cm =
          input.height == null ? null : round(toCm(input.height, input.height_unit), 1);
        const weight_kg =
          input.weight == null ? null : round(toKg(input.weight, input.weight_unit), 2);
        const { error: insertError } = await db.from("measurements").insert({
          household_id: householdId,
          child_id: child.id,
          measured_on: on,
          height_cm,
          weight_kg,
          source: "ai",
        });
        if (insertError) throw new Error(`Couldn't save it: ${insertError.message}`);

        return reply(
          `Saved for ${child.nickname}. Compare with the car seat using car_seat_status.`,
          {
            child_id: child.id,
            measured_on: on,
            height_cm,
            weight_kg,
          },
        );
      }),
  );
}
