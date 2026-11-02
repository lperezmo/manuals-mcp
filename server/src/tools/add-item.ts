import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { quickOrBackground } from "../background.js";
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
import { discardUpload, readUpload, UploadError } from "../finder/upload-slot.js";
import {
  findItem,
  guarded,
  ITEM_COLUMNS,
  itemLabel,
  itemPageUrl,
  reply,
  type Surface,
  session,
} from "./context.js";

/** What add_item says after a site blocked the download, by where it was called from. */
export function blockedNext(surface: Surface, itemId: string, pageUrl: string): string {
  if (surface === "chat") {
    return " Look for a copy on another site, or save the PDF in a browser and upload it on the Things page.";
  }
  return ` If you can download it yourself (a code sandbox or browser with network access), call request_manual_upload with item "${itemId}", send the PDF there, then call add_item with attach_to and upload_id. Otherwise look for a copy on another site, or ask the person to open ${pageUrl} and tap Upload a PDF.`;
}

/**
 * How long add_item waits for the read before answering "still reading". Some
 * MCP clients give up on a call after 45 seconds (the Muse app does), and a
 * timed-out client may retry and add the manual twice; the read carries on in
 * the background either way.
 */
export const ANSWER_WITHIN_MS = 35_000;

/** add_item's answer while Muse is still reading the manual. */
export function stillReading(label: string, added: boolean, notNew: boolean | undefined): string {
  return `${added ? `Added ${label}. Its` : `Attached the`} manual is saved and Muse is still reading it, about a minute more. Don't add it again: call list_items or upcoming in a minute to see its tasks.${notNew ? " It isn't new: once the read is done, call catch_up to seed its schedule from its history." : ""}`;
}

export function register(server: McpServer, env: Env, surface: Surface = "mcp") {
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
        ...(surface === "mcp"
          ? [
              "If the maker's site won't let our server download the PDF but you can, use request_manual_upload and pass its upload_id here instead of pdf_url.",
            ]
          : []),
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
        pdf_url: z
          .url()
          .optional()
          .describe(
            "Direct https link to the manual PDF. With upload_id, it is only saved as where the PDF came from.",
          ),
        upload_id: z
          .string()
          .max(200)
          .optional()
          .describe(
            "From request_manual_upload, after you sent the PDF to its upload_url. Used instead of downloading pdf_url.",
          ),
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
    async ({ attach_to, pdf_url, upload_id, official, history, ...fields }, ctx) => {
      const started = Date.now();
      const left = () => Math.max(5_000, ANSWER_WITHIN_MS - (Date.now() - started));
      return guarded(async () => {
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

        if (upload_id) {
          let upload: Awaited<ReturnType<typeof readUpload>>;
          try {
            upload = await readUpload(db, householdId, upload_id);
          } catch (err) {
            if (err instanceof UploadError) {
              return reply(
                `${added ? `Added ${label}, but couldn't` : "Couldn't"} use that upload: ${err.message}`,
                { item },
              );
            }
            throw err;
          }
          const read = await quickOrBackground(
            ingestPdf({
              env,
              db,
              householdId,
              item,
              bytes: upload.bytes,
              source: "pdf_upload",
              sourceUrl: pdf_url,
              official,
            }).then(async (outcome) => {
              // The manual has its own copy now; the slot's file isn't needed.
              await discardUpload(db, upload.path);
              return outcome;
            }),
            left(),
          );
          if (!read.done) return reply(stillReading(label, added, notNew), { item, reading: true });
          return reply(attachedSentence(read.value, label, added, notNew), {
            item,
            manual: read.value,
          });
        }

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
                ? blockedNext(surface, item.id, itemPageUrl(env, ctx, item.id))
                : "";
            return reply(
              `${added ? `Added ${label}, but couldn't` : "Couldn't"} use that link: ${err.message}${next}`,
              { item },
            );
          }
          throw err;
        }
        const read = await quickOrBackground(
          ingestPdf({
            env,
            db,
            householdId,
            item,
            bytes: fetched.bytes,
            source: "url",
            sourceUrl: fetched.finalUrl,
            official,
          }),
          left(),
        );
        if (!read.done) return reply(stillReading(label, added, notNew), { item, reading: true });
        return reply(attachedSentence(read.value, label, added, notNew), {
          item,
          manual: read.value,
        });
      });
    },
  );
}

function attachedSentence(
  outcome: Awaited<ReturnType<typeof ingestPdf>>,
  label: string,
  added: boolean,
  notNew: boolean | undefined,
): string {
  const d = outcome.distilled;
  const read = d
    ? `Read it: ${d.tasks} upkeep tasks, ${d.facts} facts${d.seat_modes ? `, ${d.seat_modes} car seat modes` : ""}.${d.needs_review ? ` ${d.needs_review} need a person to check (see upcoming).` : ""}`
    : (outcome.note ?? "");
  const next = notNew
    ? " It isn't new: call catch_up next to seed its schedule from its history."
    : "";
  return `${added ? `Added ${label} with` : `Attached`} a ${outcome.page_count ?? "?"}-page manual${added ? "" : ` to ${label}`}. ${read}${next}`;
}
