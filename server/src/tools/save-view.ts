import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { scoreView, VIEW_BAR } from "../atlas.js";
import type { Env } from "../env.js";
import { guarded, reply, session } from "./context.js";
import { loadAtlas, scoresFor } from "./house-atlas.js";

// Keeps a House Atlas view in the household's own words, so it shows as a
// chip on the Atlas page and refreshes itself when things change.

/** Most saved views per household. */
export const MAX_VIEWS = 24;

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "save_view",
    {
      title: "Save or remove an atlas view",
      description:
        'Saves a view in the user\'s own words ("baby safety", "before the first frost") so it shows as a chip on the Atlas page and refreshes itself when things are added. Pass remove true to delete a saved view.',
      inputSchema: z.object({
        phrase: z.string().trim().min(2).max(120).describe("The view, in the user's words."),
        remove: z.boolean().default(false).describe("Delete the saved view with this phrase."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ phrase, remove }, ctx) =>
      guarded(async () => {
        const { db, householdId } = await session(env, ctx);
        if (remove) {
          // Matched here rather than with a LIKE pattern, so a "*" or "%" in the words is just a character.
          const { data: rows, error: readError } = await db
            .from("saved_views")
            .select("id, phrase")
            .eq("household_id", householdId);
          if (readError) throw new Error(`Couldn't remove the view: ${readError.message}`);
          const ids = (rows ?? [])
            .filter((v) => String(v.phrase).toLowerCase() === phrase.toLowerCase())
            .map((v) => v.id as string);
          if (!ids.length) return reply(`There was no saved "${phrase}" view.`);
          const { error } = await db.from("saved_views").delete().in("id", ids);
          if (error) throw new Error(`Couldn't remove the view: ${error.message}`);
          return reply(`Removed the "${phrase}" view.`);
        }
        const loaded = await loadAtlas(env, db);
        const views = loaded.views.filter((v) => !v.household_id || v.household_id === householdId);
        const existing = views.find((v) => v.phrase.toLowerCase() === phrase.toLowerCase());
        if (existing) {
          return reply(`"${existing.phrase}" is already saved.`, {
            id: existing.id,
            phrase: existing.phrase,
          });
        }
        if (views.length >= MAX_VIEWS) {
          throw new Error(`That's ${MAX_VIEWS} saved views already. Remove one first.`);
        }
        const mine = loaded.input.items.filter(
          (i) => !i.household_id || i.household_id === householdId,
        );
        const scored = await scoreView(
          env,
          phrase,
          mine,
          loaded.input.tasks.filter((t) => mine.some((i) => i.id === t.item_id)),
        );
        const { data, error } = await db
          .from("saved_views")
          .insert({
            household_id: householdId,
            phrase,
            scores: scoresFor(scored.scores, mine, householdId),
            mode: scored.mode,
          })
          .select("id, phrase")
          .single();
        if (error) throw new Error(`Couldn't save the view: ${error.message}`);
        const fits = Object.values(scored.scores).filter((p) => p >= VIEW_BAR).length;
        return reply(
          `Saved "${phrase}": ${fits} thing${fits === 1 ? "" : "s"} fit right now. It refreshes when things change.`,
          data,
        );
      }),
  );
}
