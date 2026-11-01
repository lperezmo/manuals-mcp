import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../env.js";
import { buildPulse, pulseLog, pulseSummary } from "../pulse.js";
import { logRun } from "../runs.js";
import { guarded, reply, session } from "./context.js";

// Household Pulse as a tool: "anything I should know about the house?"
// The same few lines the home page shows (pulse.ts), from one Jev call.

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "pulse",
    {
      title: "Anything I should know about the house?",
      description: [
        "The few upcoming things worth doing now, out of everything due in the next two weeks and warranties ending soon: safety first, then what gets worse, saves money or takes five minutes. At most three, unless more are about safety.",
        'Use it for "anything I should know?", "what matters this week?" or a quick check-in. For the full list of what\'s due, use upcoming.',
        "Each line says why it's shown (safety, money at stake, gets worse if left, a five-minute job).",
      ].join(" "),
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (_args, ctx) =>
      guarded(async () => {
        const { db, userId } = await session(env, ctx);
        const pulse = await buildPulse(env, db, userId);
        if (!pulse) {
          return reply(
            "Pulse isn't available right now (the classifier is unset or down). Use upcoming for the full list of what's due.",
          );
        }
        if (pulse.jev && env.router) {
          await logRun(db, {
            kind: "pulse",
            ok: true,
            model: env.router.model,
            ms: pulse.jev.ms,
            tokens_in: pulse.jev.tokens_in,
            raw_output: pulseLog(pulse),
          });
        }
        return reply(pulseSummary(pulse), {
          now: pulse.cards.map((c) => ({
            item: c.item.nickname,
            item_id: c.item.id,
            what: c.title,
            when: c.sub,
            task_id: c.task_id,
            why: c.chip,
          })),
          considered: pulse.considered,
          put_off: pulse.snoozed,
        });
      }),
  );
}
