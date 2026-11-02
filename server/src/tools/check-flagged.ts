import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../env.js";
import { applyChecks, type Check, RECHECK_MAX, recheckFlagged } from "../recheck.js";
import { findItem, guarded, reply, session } from "./context.js";

// check_flagged: the second read on demand. Without apply it looks again at
// every line still flagged "not sure" and answers with a verdict per line
// (confirm, fix, doesn't apply, still unsure), each quoting its page. It saves
// nothing. With apply (the run id it gave) it saves those same verdicts, so
// what's saved is exactly what the person was shown.

const VERDICT_WORDS: Record<Check["verdict"], string> = {
  confirm: "the page confirms it",
  fix: "the page says something else",
  not_applicable: "doesn't apply to this model",
  unsure: "still not sure",
};

/** One verdict as a line for the assistant to show. */
export function verdictLine(c: Check): string {
  const page = c.page ? ` (p. ${c.page})` : "";
  const fix = c.changes ? ` Fix: ${JSON.stringify(c.changes)}.` : "";
  return `${c.item}: ${c.what}${page}. ${VERDICT_WORDS[c.verdict]}. ${c.reason}${fix}`;
}

export function register(server: McpServer, env: Env) {
  server.registerTool(
    "check_flagged",
    {
      title: "Double-check unsure lines",
      description: [
        `A second, separate read of the lines Muse flagged as not sure (needs_review), up to ${RECHECK_MAX} at a time, each against its own page.`,
        "Call it with no apply first: it saves nothing and returns a verdict per line (confirm, fix with the new fields, not_applicable, or unsure), each with a quote from the page.",
        'Show the verdicts briefly with their pages, then ask the user "Apply these?". On yes, call it again with apply set to the run_id it returned (and only, to apply some of them). Lines still unsure stay flagged for the user to look at.',
      ].join(" "),
      inputSchema: z.object({
        item: z
          .string()
          .optional()
          .describe("Only this thing's lines (its id or name). Leave out for the whole house."),
        apply: z
          .uuid()
          .optional()
          .describe("The run_id from an earlier check_flagged call, once the user said yes."),
        only: z
          .array(z.uuid())
          .optional()
          .describe("With apply: just these line ids, when the user said yes to some."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ item, apply, only }, ctx) =>
      guarded(async () => {
        const { db, householdId } = await session(env, ctx);
        if (apply) {
          const { data: run, error } = await db
            .from("model_runs")
            .select("raw_output")
            .eq("id", apply)
            .eq("kind", "recheck")
            .maybeSingle();
          if (error) throw new Error(error.message);
          if (!run?.raw_output) throw new Error("No check with that run_id in this household.");
          const saved = (JSON.parse(run.raw_output as string) as { checks?: Check[] }).checks ?? [];
          const picked = only?.length ? saved.filter((c) => only.includes(c.id)) : saved;
          const { applied, skipped } = await applyChecks(db, householdId, picked);
          const left = picked.filter((c) => c.verdict === "unsure").length;
          return reply(
            `Saved ${applied.length} of them${skipped.length ? `; ${skipped.length} weren't changed` : ""}.${left ? ` ${left} still need a person to look at.` : ""} Each change keeps the old version in the history.`,
            { applied: applied.map((c) => c.id), skipped, still_unsure: left },
          );
        }
        if (!env.reader)
          throw new Error("Muse isn't set up here, so it can't read the pages again.");
        const itemId = item ? (await findItem(db, item)).id : undefined;
        const { checks, run_id, more } = await recheckFlagged(env, db, { itemId });
        if (!checks.length) return reply("Nothing is flagged as not sure. All checked.");
        const settled = checks.filter((c) => c.verdict !== "unsure").length;
        return reply(
          `Looked again at ${checks.length} unsure line${checks.length === 1 ? "" : "s"}${more ? ` (${more} more after these)` : ""}: ${settled} settled by the page, ${checks.length - settled} still unsure. Nothing is saved yet.\n${checks.map((c) => `- ${verdictLine(c)}`).join("\n")}`,
          { run_id, checks },
        );
      }),
  );
}
