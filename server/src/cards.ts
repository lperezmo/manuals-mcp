import { z } from "zod";

// A card is a small form Muse can attach to a chat reply: a date picker, a
// number with units, a choice, a checklist. Muse only picks from these few
// shapes; the website draws them with its own components and inserts every
// string as plain text. A filled card comes back as an ordinary chat message,
// so nothing is saved until Muse calls one of the regular tools.

const text = (max: number) => z.string().trim().min(1).max(max);
const base = {
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,30}$/)
    .describe("snake_case name for the answer"),
  label: text(80).describe("The question, shown above the input."),
};

export const UNITS = ["lb", "kg", "in", "cm", "per_week", "months", "years"] as const;

export const cardField = z.discriminatedUnion("type", [
  z.object({ type: z.literal("date"), ...base }),
  z.object({
    type: z.literal("number"),
    ...base,
    units: z.array(z.enum(UNITS)).min(1).max(3).optional().describe("The user picks one."),
  }),
  z.object({
    type: z.literal("choice"),
    ...base,
    options: z.array(text(40)).min(2).max(6),
  }),
  z.object({
    type: z.literal("checklist"),
    ...base,
    options: z
      .array(
        z.object({
          value: z.string().max(60).describe("e.g. a task id"),
          label: text(80),
          checked: z.boolean().default(true),
        }),
      )
      .min(1)
      .max(12),
  }),
  z.object({ type: z.literal("text"), ...base, placeholder: text(60).optional() }),
]);

export const cardSchema = z
  .object({
    title: text(80),
    fields: z.array(cardField).min(1).max(4),
    submit: text(24).default("Send"),
  })
  .refine((c) => new Set(c.fields.map((f) => f.key)).size === c.fields.length, {
    message: "Each field needs its own key.",
  });

export type Card = z.infer<typeof cardSchema>;

/** One line per field, so the chat history remembers what was asked. */
export function describeCard(card: Card): string {
  const lines = card.fields.map((f) => {
    if (f.type === "choice") return `- ${f.label} (${f.options.join(" / ")})`;
    if (f.type === "checklist")
      return `- ${f.label}: ${f.options.map((o) => `${o.label} [${o.value}]`).join("; ")}`;
    if (f.type === "number" && f.units) return `- ${f.label} (${f.units.join(" or ")})`;
    return `- ${f.label} (${f.type})`;
  });
  return `[Form: ${card.title}]\n${lines.join("\n")}`;
}
