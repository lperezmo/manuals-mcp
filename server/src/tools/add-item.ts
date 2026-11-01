import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { historySchema, saveHistory } from "../catch-up.js";
import type { ItemRow } from "../db.js";
import type { Env } from "../env.js";
import {
  ATTACH_TIMEOUT_MS,
  FetchPdfError,
  fetchPdf,
  SiteBlockedError,
} from "../finder/fetch-pdf.js";
import { ingestPdf } from "../finder/ingest.js";
import { findItem, guarded, ITEM_COLUMNS, itemLabel, reply, session } from "./context.js";

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "add_item",
    {
      title: "Add a thing and its manual",
      description: [
        "Adds an appliance, piece of baby gear, vehicle or other thing to the household, and attaches its manual.",
        "Brand and model are what find the right manual, so ask for them if the user knows (the model number is usually on a label inside the door, on the back, or under the base).",
        "For the manual: search the web for the brand, model number and \"owner's manual PDF\", prefer the maker's own support site, and pass the direct PDF link as pdf_url.",
        "The server reads the manual and saves its upkeep tasks, error codes, parts, specs and car seat limits, each with its page. Some may come back flagged for review.",
        "To attach a manual to something already added, pass attach_to with its id or name, plus pdf_url.",
      ].join(" "),
      inputSchema: z.object({
        attach_to: z
          .string()
          .optional()
          .describe("Id or name of an existing item, to attach a manual instead of adding one."),
        nickname: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe('What the household calls it, e.g. "Washer", "Big car seat".'),
        kind: z.enum(["appliance", "baby_gear", "vehicle", "other"]).default("appliance"),
        category: z
          .string()
          .max(40)
          .optional()
          .describe(
            "Short type in snake_case: washer, dishwasher, espresso_machine, car_seat, crib, stroller...",
          ),
        brand: z.string().max(80).optional(),
        model: z
          .string()
          .max(80)
          .optional()
          .describe("Model number exactly as printed on the label."),
        serial: z.string().max(80).optional(),
        purchased_on: z.iso.date().optional().describe("YYYY-MM-DD"),
        uses_per_week: z
          .number()
          .positive()
          .max(100)
          .optional()
          .describe(
            'Rough uses a week (e.g. 6 washer loads). Turns "every 30 cycles" tasks into dates.',
          ),
        child_id: z.uuid().optional().describe("For a car seat or gear that belongs to one child."),
        notes: z.string().max(500).optional(),
        pdf_url: z.url().optional().describe("Direct https link to the manual PDF."),
        official: z
          .boolean()
          .optional()
          .describe("True when the PDF is on the manufacturer's own website."),
        history: historySchema
          .optional()
          .describe(
            "For a thing that isn't new: what the user said about its past. Saved for catch_up, which plans its catch-up once the manual is read.",
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ attach_to, pdf_url, official, history, ...fields }, ctx) =>
      guarded(async () => {
        const { db, householdId } = await session(env, ctx);

        let item: ItemRow;
        let added = false;
        if (attach_to) {
          item = await findItem(db, attach_to);
        } else {
          if (!fields.nickname) throw new Error("Give the thing a nickname, e.g. Washer.");
          const { data, error } = await db
            .from("items")
            .insert({ ...fields, household_id: householdId })
            .select(ITEM_COLUMNS)
            .single();
          if (error) throw new Error(`Couldn't add it: ${error.message}`);
          item = data as ItemRow;
          added = true;
        }
        const label = itemLabel(item);
        if (history) await saveHistory(db, item.id, history);
        const notNew = history && history.condition !== "new";

        if (!pdf_url) {
          const query = [item.brand, item.model, "owner's manual pdf"].filter(Boolean).join(" ");
          return reply(
            `${added ? `Added ${label}.` : `${label} is already saved.`} No manual yet: search for "${query}"${item.model ? "" : " (ask the user for the model number first)"} and call add_item again with attach_to and pdf_url.${notNew ? " It isn't new: once the manual is read, call catch_up to seed its schedule from its history." : ""}`,
            { item, suggested_search: query },
          );
        }

        let fetched: Awaited<ReturnType<typeof fetchPdf>>;
        try {
          fetched = await fetchPdf(pdf_url, fetch, ATTACH_TIMEOUT_MS);
        } catch (err) {
          if (err instanceof FetchPdfError) {
            // A site that blocks apps won't change its mind on a retry.
            const next =
              err instanceof SiteBlockedError
                ? " Look for a copy on another site, or save the PDF in a browser and upload it."
                : "";
            return reply(
              `${added ? `Added ${label}, but couldn't` : "Couldn't"} use that link: ${err.message}${next}`,
              { item },
            );
          }
          throw err;
        }
        const outcome = await ingestPdf({
          env,
          db,
          householdId,
          item,
          bytes: fetched.bytes,
          source: "url",
          sourceUrl: fetched.finalUrl,
          official,
        });
        const d = outcome.distilled;
        const read = d
          ? `Read it: ${d.tasks} upkeep tasks, ${d.facts} facts${d.seat_modes ? `, ${d.seat_modes} car seat modes` : ""}.${d.needs_review ? ` ${d.needs_review} need a person to check (see upcoming).` : ""}`
          : (outcome.note ?? "");
        const next = notNew
          ? " It isn't new: call catch_up next to seed its schedule from its history."
          : "";
        return reply(
          `${added ? `Added ${label} with` : `Attached`} a ${outcome.page_count ?? "?"}-page manual${added ? "" : ` to ${label}`}. ${read}${next}`,
          { item, manual: outcome },
        );
      }),
  );
}
