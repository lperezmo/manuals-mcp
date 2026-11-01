import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { scoreView, VIEW_BAR } from "../atlas.js";
import type { Env } from "../env.js";
import { guarded, reply, session } from "./context.js";
import { loadAtlas } from "./house-atlas.js";

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
          const { data, error } = await db
            .from("saved_views")
            .delete()
            .ilike(
              "phrase",
              phrase.replace(/[\\%_]/g, (c) => `\\${c}`),
            )
            .select("id");
          if (error) throw new Error(`Couldn't remove the view: ${error.message}`);
          return reply(
            data?.length ? `Removed the "${phrase}" view.` : `There was no saved "${phrase}" view.`,
          );
        }
        const loaded = await loadAtlas(env, db);
        const existing = loaded.views.find((v) => v.phrase.toLowerCase() === phrase.toLowerCase());
        if (existing) {
          return reply(`"${existing.phrase}" is already saved.`, {
            id: existing.id,
            phrase: existing.phrase,
          });
        }
        if (loaded.views.length >= MAX_VIEWS) {
          throw new Error(`That's ${MAX_VIEWS} saved views already. Remove one first.`);
        }
        const scored = await scoreView(env, phrase, loaded.input.items, loaded.input.tasks);
        const { data, error } = await db
          .from("saved_views")
          .insert({
            household_id: householdId,
            phrase,
            scores: scored.scores,
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
