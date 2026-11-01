import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../env.js";
import { latestReceipts, warrantyStatus } from "../receipt.js";
import { findItem, guarded, itemLabel, reply, session } from "./context.js";

// Whether a thing is still under warranty, from the receipt or warranty card
// the household saved (a photo read on the website, or typed in).

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "warranty_status",
    {
      title: "Check a thing's warranty",
      description: [
        "Says whether a thing is likely still under warranty: purchase date, store, price, warranty length and end date, from the receipt or warranty card the household saved.",
        "Call it whenever the user says something broke, stopped working, shows an error or needs a repair or a part, before suggesting they pay for one.",
        "If it's likely covered, say so first and suggest contacting the maker or store with the receipt. If nothing is saved, suggest adding a receipt photo on the thing's page.",
      ].join(" "),
      inputSchema: z.object({
        item: z.string().min(1).describe("Item id or name."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ item: ref }, ctx) =>
      guarded(async () => {
        const { db } = await session(env, ctx);
        const item = await findItem(db, ref);
        const receipts = await latestReceipts(db, [item.id]);
        const receipt = receipts?.get(item.id) ?? null;
        const warranty = warrantyStatus(
          receipt ??
            (item.purchased_on
              ? { purchased_on: item.purchased_on, warranty_months: null, warranty_ends_on: null }
              : null),
        );
        return reply(`${itemLabel(item)}: ${warranty.summary}`, {
          item: { id: item.id, name: itemLabel(item) },
          warranty,
          receipt: receipt
            ? {
                kind: receipt.kind,
                purchased_on: receipt.purchased_on,
                store: receipt.store,
                price: receipt.price,
                currency: receipt.currency,
                warranty_months: receipt.warranty_months,
                warranty_note: receipt.warranty_note,
                photo_saved: !!receipt.image_path,
              }
            : null,
        });
      }),
  );
}
