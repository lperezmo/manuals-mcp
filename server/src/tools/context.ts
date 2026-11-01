import type { CallToolResult, ServerContext } from "@modelcontextprotocol/server";
import { getPublicOrigin } from "mcp-handler";
import { userFrom } from "../auth.js";
import { type Db, householdId, type ItemRow, userDb } from "../db.js";
import type { Env } from "../env.js";

/**
 * Where a tool is offered: over MCP to the person's own AI app, or in the
 * website's chat (Muse), which has no sandbox and can't download files.
 */
export type Surface = "mcp" | "chat";

export interface Session {
  db: Db;
  userId: string;
  householdId: string;
}

/** Opens the caller's household with their own token. */
export async function session(env: Env, ctx: ServerContext): Promise<Session> {
  const auth = ctx.http?.authInfo;
  const { userId } = userFrom(auth);
  const db = userDb(env, auth?.token ?? "");
  return { db, userId, householdId: await householdId(db) };
}

/** The thing's page on the website, where the person can tap Upload a PDF. */
export function itemPageUrl(env: Env, ctx: ServerContext, itemId: string): string {
  const req = ctx.http?.req;
  const origin = env.publicUrl ?? (req ? getPublicOrigin(req) : "");
  return `${origin}/things?id=${itemId}`;
}

/**
 * A tool result: one plain sentence for the model to relay, then the data as
 * JSON so it can answer follow-ups without another call.
 */
export function reply(summary: string, data?: unknown): CallToolResult {
  const text = data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 2)}`;
  return { content: [{ type: "text", text }] };
}

export function problem(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Runs a tool body and turns thrown errors into readable tool errors. */
export async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    return problem(err instanceof Error ? err.message : String(err));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export const ITEM_COLUMNS =
  "id, household_id, kind, category, nickname, brand, model, serial, purchased_on, uses_per_week, child_id, notes";

/**
 * Finds one item from an id or a loose name ("washer", "the car seat",
 * "Graco"). Throws with the candidates when the name is ambiguous.
 */
export async function findItem(db: Db, ref: string): Promise<ItemRow> {
  const { data, error } = await db
    .from("items")
    .select(ITEM_COLUMNS)
    .is("archived_at", null)
    .order("created_at");
  if (error) throw new Error(`Couldn't read your things: ${error.message}`);
  const items = (data ?? []) as ItemRow[];
  if (isUuid(ref)) {
    const hit = items.find((i) => i.id === ref);
    if (hit) return hit;
    throw new Error("No item with that id in this household.");
  }
  const words = normalize(ref)
    .split(" ")
    .filter((w) => w && !["the", "our", "my", "a"].includes(w));
  const scored = items
    .map((item) => {
      const hay = normalize(
        [item.nickname, item.category?.replace(/_/g, " "), item.brand, item.model].join(" "),
      );
      const score = words.filter((w) => hay.includes(w)).length;
      return { item, score, exact: normalize(item.nickname) === words.join(" ") };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
  const best = scored[0];
  if (!best) {
    const names = items.map((i) => i.nickname).join(", ") || "nothing yet";
    throw new Error(`No item matches "${ref}". This household has: ${names}.`);
  }
  const tied = scored.filter((s) => s.score === best.score && s.exact === best.exact);
  if (tied.length > 1) {
    const names = tied.map((s) => `${s.item.nickname} (${s.item.id})`).join(", ");
    throw new Error(`"${ref}" could be several things: ${names}. Ask which one, then pass its id.`);
  }
  return best.item;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function itemLabel(item: Pick<ItemRow, "nickname" | "brand" | "model">): string {
  const make = [item.brand, item.model].filter(Boolean).join(" ");
  return make ? `${item.nickname} (${make})` : item.nickname;
}
