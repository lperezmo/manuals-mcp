import { z } from "zod";
import type { Db } from "./db.js";
import type { Env } from "./env.js";
import { today } from "./lib/schedule.js";
import { buildPulse, type Chip, gatherEvents } from "./pulse.js";
import type { Spent } from "./runs.js";

// The questions a new Muse chat from Home offers, written for what this
// household has coming up. Jev picks what matters (the Household Pulse's
// ranked lines go first, then whatever else is due soonest); Muse turns the
// top few into short questions in the person's own voice. Home shows its plain
// templates until these arrive, and keeps them when anything here fails, so a
// chat never opens blank.

/** How many things Muse is told about, and how many questions come back. */
export const MAX_PICKS = 5;
export const MAX_STARTERS = 3;
/** Longest question kept: a chip is one line on a phone. */
export const MAX_CHARS = 72;
/** Most Muse calls for starters one household makes a day; after that Home keeps its templates. */
export const STARTERS_DAILY = 12;
/** The same things coming up get the same questions for this long. */
const CACHE_MS = 6 * 60 * 60_000;

export interface Pick {
  key: string;
  title: string;
  nickname: string;
  sub: string;
  chip: Chip | null;
}

export interface Starter {
  label: string;
  text: string;
}

const cache = new Map<string, { at: number; starters: Starter[] }>();

export function resetStartersCache(): void {
  cache.clear();
}

const WHY: Record<Chip, string> = {
  safety: "safety",
  money: "money at stake",
  worse: "gets worse if left",
  quick: "a five-minute job",
};

/** Pulse lines first (Jev's order), then the rest of what's coming, latest first. */
export function choosePicks(
  cards: {
    key: string;
    title: string;
    sub: string;
    chip: Chip | null;
    item: { nickname: string };
  }[],
  events: { key: string; title: string; sub: string; late: number; item: { nickname: string } }[],
  max = MAX_PICKS,
): Pick[] {
  const picks: Pick[] = cards.map((c) => ({
    key: c.key,
    title: c.title,
    nickname: c.item.nickname,
    sub: c.sub,
    chip: c.chip,
  }));
  const seen = new Set(picks.map((p) => p.key));
  const rest = events.filter((e) => !seen.has(e.key)).sort((a, b) => b.late - a.late);
  for (const e of rest) {
    picks.push({ key: e.key, title: e.title, nickname: e.item.nickname, sub: e.sub, chip: null });
  }
  return picks.slice(0, max);
}

export const INSTRUCTIONS = `You write the suggested questions shown when someone opens a chat with Muse, the assistant in their household app. Muse knows each thing's manual, its upkeep schedule, when jobs were last done and its warranty.
You get the household's things that need attention, most pressing first. Write up to ${MAX_STARTERS} questions the person might tap to ask Muse about them.
Each question is in the person's own voice ("my", "I"), names the thing by its nickname, ends with "?", and is under ${MAX_CHARS - 12} characters. Plain everyday words, no jargon, no emoji.
Cover different things when there are several, the most pressing first. Vary them: how to do a job, whether it can wait, when it was last done, what the warranty covers. Never state a fact that isn't in the list.
Return only JSON: {"questions": ["...", "..."]}.`;

/** The lines Muse reads, one per thing. */
export function picksPrompt(picks: Pick[]): string {
  return picks
    .map((p) => `- ${p.title} (${p.nickname}): ${p.sub}${p.chip ? `, ${WHY[p.chip]}` : ""}`)
    .join("\n");
}

const answerSchema = z.object({ questions: z.array(z.unknown()).catch([]) });

/** Muse's JSON to at most MAX_STARTERS clean, distinct one-line questions. */
export function parseStarters(raw: string): Starter[] {
  const text = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const { success, data } = answerSchema.safeParse(parsed);
  if (!success) return [];
  const out: Starter[] = [];
  const seen = new Set<string>();
  for (const q of data.questions) {
    if (typeof q !== "string") continue;
    const line = q.replace(/\s+/g, " ").trim();
    if (!line.endsWith("?") || line.length < 8 || line.length > MAX_CHARS) continue;
    if (/[<>]|https?:/i.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: line, text: line });
    if (out.length >= MAX_STARTERS) break;
  }
  return out;
}

/** One Muse call: the picks in, a few questions out. Throws when Muse is down or unset. */
export async function askMuse(
  env: Env,
  picks: Pick[],
  fetchImpl: typeof fetch = fetch,
  spent?: Spent,
): Promise<Starter[]> {
  const reader = env.reader;
  if (!reader) throw new Error("Muse isn't configured.");
  const res = await fetchImpl(`${reader.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(reader.apiKey ? { authorization: `Bearer ${reader.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: env.chatModel ?? reader.model,
      response_format: { type: "json_object" },
      // Muse thinks before it answers; too low a cap cuts the JSON off.
      max_tokens: 3000,
      messages: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: `Coming up:\n${picksPrompt(picks)}` },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Muse answered ${res.status}.`);
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  if (spent) {
    spent.tokens_in += body.usage?.prompt_tokens ?? 0;
    spent.tokens_out += body.usage?.completion_tokens ?? 0;
  }
  return parseStarters(body.choices?.[0]?.message?.content ?? "");
}

export interface StartersResult {
  starters: Starter[];
  /** Set when this call asked Muse (a cache hit asks nothing). */
  muse: { ms: number; spent: Spent; picks: string[] } | null;
}

/**
 * Questions for this household's new chats, read as the user (RLS). Null
 * when there's nothing coming up, Muse is unset, or the day's calls are used:
 * Home then keeps its templates.
 */
export async function buildStarters(
  env: Env,
  db: Db,
  userId: string,
  fetchImpl: typeof fetch = fetch,
  opts: { now?: string; usedToday?: () => Promise<number> } = {},
): Promise<StartersResult | null> {
  if (!env.reader) return null;
  const now = opts.now ?? today();
  // Jev's ranking when it's there; without it (or when it's down) just what's due.
  const pulse = await buildPulse(env, db, userId, fetchImpl, now).catch(() => null);
  const { events } = await gatherEvents(db, now);
  const picks = choosePicks(pulse?.cards ?? [], events);
  if (!picks.length) return null;

  const key = `${userId}|${picks.map((p) => p.key).join(",")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { starters: hit.starters, muse: null };
  if (opts.usedToday && (await opts.usedToday()) >= STARTERS_DAILY) return null;

  const spent: Spent = { tokens_in: 0, tokens_out: 0 };
  const started = Date.now();
  const starters = await askMuse(env, picks, fetchImpl, spent);
  const ms = Date.now() - started;
  if (starters.length) {
    cache.set(key, { at: Date.now(), starters });
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  }
  return { starters, muse: { ms, spent, picks: picks.map((p) => p.key) } };
}
