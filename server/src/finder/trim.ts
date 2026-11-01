import type { Env } from "../env.js";
import type { Knowledge } from "./knowledge.js";

// Manuals are full of things nobody needs saved: "supervise children", legal
// and regulatory text, labels copied off the product diagram. After the read,
// Jev answers one yes/no per candidate in one call: would an owner actually
// look this up? Confident noes are dropped. Error codes, specs and recurring
// upkeep are always kept, and so is every safety entry on baby gear.

/** Below this, an entry counts as common sense or boilerplate. */
export const KEEP_THRESHOLD = 0.25;

interface Candidate {
  list: "facts" | "tasks";
  index: number;
  text: string;
}

export interface Trimmed {
  knowledge: Knowledge;
  dropped: string[];
  tokens_in: number;
}

export async function trimTrivia(
  env: Env,
  knowledge: Knowledge,
  item: { label: string; kind: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Trimmed> {
  const router = env.router;
  const unchanged = { knowledge, dropped: [], tokens_in: 0 };
  if (!router) return unchanged;
  const candidates: Candidate[] = [];
  knowledge.facts.forEach((f, index) => {
    if (f.kind === "error_code" || f.kind === "spec") return;
    if (f.kind === "safety" && item.kind === "baby_gear") return;
    candidates.push({ list: "facts", index, text: `${f.label}: ${f.value}` });
  });
  knowledge.tasks.forEach((t, index) => {
    if (!["once", "as_needed"].includes(t.interval_unit)) return;
    candidates.push({ list: "tasks", index, text: `${t.title}. ${t.details ?? ""}` });
  });
  if (!candidates.length) return unchanged;

  try {
    const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${router.apiKey}` },
      body: JSON.stringify({
        model: router.model,
        state: {
          thing: item.label,
          entries: Object.fromEntries(candidates.map((c, i) => [`e${i}`, c.text.slice(0, 500)])),
        },
        questions: Object.fromEntries(
          candidates.map((_, i) => [
            `e${i}`,
            {
              type: "noul",
              instructions: `Would the owner of this thing actually want entry e${i} saved to look up later?`,
              criteria: {
                true: "Specific to this product and useful: a part they may replace or care for, a non-obvious rule, a feature they'd forget how to use.",
                false:
                  "Common sense anyone knows (supervise children, don't use it if broken), legal or regulatory text (FCC, Prop 65, warranty), or just a label from the product diagram.",
              },
            },
          ]),
        ),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return unchanged;
    const body = (await res.json()) as {
      answers?: Record<string, { noul?: number }>;
      usage?: { input_tokens?: number };
    };
    const drop = new Set<string>();
    candidates.forEach((c, i) => {
      const p = body.answers?.[`e${i}`]?.noul;
      if (typeof p === "number" && p < KEEP_THRESHOLD) drop.add(`${c.list}:${c.index}`);
    });
    return {
      knowledge: {
        tasks: knowledge.tasks.filter((_, i) => !drop.has(`tasks:${i}`)),
        facts: knowledge.facts.filter((_, i) => !drop.has(`facts:${i}`)),
        seat_modes: knowledge.seat_modes,
      },
      dropped: candidates
        .filter((c) => drop.has(`${c.list}:${c.index}`))
        .map((c) => c.text.slice(0, 120)),
      tokens_in: body.usage?.input_tokens ?? 0,
    };
  } catch {
    return unchanged;
  }
}
