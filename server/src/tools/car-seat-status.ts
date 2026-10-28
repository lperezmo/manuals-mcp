import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ChildRow, ItemRow, MeasurementRow, SeatModeRow } from "../db.js";
import type { Env } from "../env.js";
import { checkSeat, type Reading } from "../lib/carseat.js";
import { today } from "../lib/schedule.js";
import { findItem, guarded, ITEM_COLUMNS, itemLabel, reply, session } from "./context.js";

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "car_seat_status",
    {
      title: "Car seat fit check",
      description: [
        "Compares a child's latest height and weight with a car seat's limits from its manual, mode by mode:",
        "which mode fits now, how much room is left before its limits, and when to measure again (sooner when a limit is close).",
        "Use it for 'is she still OK rear-facing?' or 'when do we switch the car seat?'. It doesn't predict growth; for a date, measure again by remeasure_by.",
        "Cite the manual page for the limits and mention that a certified child passenger safety technician can check the fit.",
        "New measurements go in with record_measurement first. Offer to put the re-measure date on the user's calendar with your own calendar tools.",
      ].join(" "),
      inputSchema: z.object({
        seat: z
          .string()
          .optional()
          .describe("Car seat item id or name. Optional when there's only one."),
        child: z
          .string()
          .optional()
          .describe("Child id or nickname. Defaults to the seat's child."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ seat, child: childRef }, ctx) =>
      guarded(async () => {
        const { db } = await session(env, ctx);
        let item: ItemRow;
        if (seat) {
          item = await findItem(db, seat);
        } else {
          const { data } = await db.from("items").select(ITEM_COLUMNS).eq("category", "car_seat");
          const seats = (data ?? []) as ItemRow[];
          if (seats.length !== 1) {
            throw new Error(
              seats.length
                ? `There are ${seats.length} car seats: ${seats.map((s) => s.nickname).join(", ")}. Which one?`
                : "No car seat is saved. Add it with add_item (category car_seat).",
            );
          }
          item = seats[0] as ItemRow;
        }

        const { data: modeRows } = await db
          .from("seat_modes")
          .select(
            "id, item_id, mode, min_weight_kg, max_weight_kg, min_height_cm, max_height_cm, min_age_months, fit_note, source_page",
          )
          .eq("item_id", item.id);
        const modes = (modeRows ?? []) as SeatModeRow[];
        if (!modes.length) {
          return reply(
            `${itemLabel(item)} has no limits saved yet. Attach its manual with add_item (attach_to, pdf_url) and the limits are read from it.`,
          );
        }

        const { data: kids } = await db.from("children").select("id, nickname, birth_date");
        const children = (kids ?? []) as ChildRow[];
        const child =
          children.find(
            (c) => c.id === childRef || c.nickname.toLowerCase() === childRef?.toLowerCase(),
          ) ??
          children.find((c) => c.id === item.child_id) ??
          (children.length === 1 ? children[0] : undefined);
        if (!child) {
          throw new Error(
            children.length
              ? `Which child? Saved: ${children.map((c) => c.nickname).join(", ")}.`
              : "No child saved yet. Save a measurement with record_measurement (with birth_date) first.",
          );
        }

        const { data: ms } = await db
          .from("measurements")
          .select("id, child_id, measured_on, height_cm, weight_kg")
          .eq("child_id", child.id)
          .order("measured_on", { ascending: false })
          .limit(20);
        const measurements = (ms ?? []) as MeasurementRow[];
        const latest = (key: "height_cm" | "weight_kg"): Reading | null => {
          const m = measurements.find((x) => x[key] != null);
          return m ? { value: Number(m[key]), on: m.measured_on } : null;
        };

        const result = checkSeat(
          modes.map((m) => ({
            ...m,
            min_weight_kg: num(m.min_weight_kg),
            max_weight_kg: num(m.max_weight_kg),
            min_height_cm: num(m.min_height_cm),
            max_height_cm: num(m.max_height_cm),
          })),
          {
            birthDate: child.birth_date,
            weightKg: latest("weight_kg"),
            heightCm: latest("height_cm"),
          },
          today(),
        );

        const room = result.modes.find((m) => m.fit === "fits")?.room_left ?? [];
        const summary = result.current_mode
          ? `${child.nickname} fits ${itemLabel(item)} ${result.current_mode}${room.length ? `, with ${room.join(" and ")} left` : ""}. Measure again by ${result.remeasure_by}.`
          : `${child.nickname}'s latest numbers don't fit any saved mode of ${itemLabel(item)}; check the manual and the measurements.`;
        return reply(summary, {
          seat: itemLabel(item),
          child: child.nickname,
          latest: { weight: latest("weight_kg"), height: latest("height_cm") },
          ...result,
        });
      }),
  );
}

const num = (v: unknown) => (v == null ? null : Number(v));
