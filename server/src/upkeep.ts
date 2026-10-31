import type { Env } from "./env.js";

// Sorts a thing's upkeep tasks into a few groups the page shows as tiles
// ("What do you want to work on?"). Jev answers one choice question per task,
// all in one call. When it's unsure or unavailable, the page keeps its own
// keyword guess, so the tiles never wait on this.

export const GROUPS = {
  cleaning: "Cleaning: washing, wiping, descaling, deodorizing, removing buildup.",
  parts: "Filters and parts: cleaning or replacing filters, bulbs, batteries, seals, accessories.",
  checks: "Checks: inspecting, testing or looking for wear, damage, leaks or loose parts.",
  safety: "Safety: warnings and precautions, unplugging or power, child safety, expiry, recalls.",
  setup: "Setup and use: installation, settings, how to use a feature or program.",
} as const;

export type Group = keyof typeof GROUPS;

/** Below this, the page keeps its keyword guess for that task. */
const MIN_CONFIDENCE = 0.5;

export async function groupTasks(
  env: Env,
  item: string,
  tasks: { id: string; title: string; details: string | null }[],
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, Group>> {
  const router = env.router;
  if (!router || !tasks.length) return {};
  const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${router.apiKey}` },
    body: JSON.stringify({
      model: router.model,
      state: {
        thing: item,
        tasks: Object.fromEntries(
          tasks.map((t, i) => [`t${i}`, `${t.title}. ${t.details ?? ""}`.slice(0, 600)]),
        ),
      },
      questions: Object.fromEntries(
        tasks.map((_, i) => [
          `t${i}`,
          {
            type: "choice",
            instructions: `What kind of upkeep is task t${i}?`,
            criteria: GROUPS,
          },
        ]),
      ),
    }),
    signal: AbortSignal.timeout(6_000),
  });
  if (!res.ok) throw new Error(`Jev answered ${res.status}.`);
  const body = (await res.json()) as {
    answers?: Record<string, { choice?: string; confidence?: number }>;
  };
  const out: Record<string, Group> = {};
  tasks.forEach((t, i) => {
    const a = body.answers?.[`t${i}`];
    if (a?.choice && a.choice in GROUPS && (a.confidence ?? 0) >= MIN_CONFIDENCE) {
      out[t.id] = a.choice as Group;
    }
  });
  return out;
}
