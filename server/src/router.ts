import type { Env } from "./env.js";

// Jev (TypeSafe AI) reads each chat message and picks what kind of turn it is.
// It isn't a chat model: it answers a fixed question with probabilities, in a
// few milliseconds, for a tiny fraction of a Muse call. The route decides
// which tools Muse is offered, so it reads less and picks the right one.
// When Jev is unsure, unset or down, Muse gets every tool, as before.

export const ROUTES = {
  ask: "Asks how to do something, what a manual or error code says, what is due, whether a car seat still fits, or says something broke or is under warranty.",
  log: "Says they did some upkeep, or gives a reading: a cycle count, hours, a child's weight or height.",
  fix: "Says a saved fact, task or limit is wrong, or doubts what the manual says.",
  add: "Wants to add a new thing they own, or attach a manual or PDF link.",
  setup:
    "Wants to set up or tell Muse about a thing they already added: when it was bought, who it is for, how often it is used, or how it was kept and what upkeep it has had.",
  answer: "Answers a question Muse just asked, or sends the answers from a form Muse showed.",
  smalltalk: "Greets, thanks or chats, with nothing to look up or save.",
  off_topic:
    "Is not about the household's things, manuals, upkeep or the children's car seats and gear.",
} as const;

export type Route = keyof typeof ROUTES;

const LOOKUP = ["list_items"];
/** Tools offered per route. show_card is offered on every route that has tools. */
export const ROUTE_TOOLS: Record<Route, string[]> = {
  ask: [
    ...LOOKUP,
    "ask_manual",
    "car_seat_status",
    "upcoming",
    "pulse",
    "warranty_status",
    "house_atlas",
  ],
  log: [...LOOKUP, "log_done", "record_measurement", "upcoming"],
  fix: [...LOOKUP, "revise_fact", "ask_manual", "catch_up"],
  add: [...LOOKUP, "add_item", "update_item"],
  setup: [
    ...LOOKUP,
    "update_item",
    "record_measurement",
    "revise_fact",
    "upcoming",
    "car_seat_status",
    "catch_up",
  ],
  answer: [
    ...LOOKUP,
    "update_item",
    "record_measurement",
    "revise_fact",
    "log_done",
    "car_seat_status",
    "upcoming",
    "catch_up",
  ],
  smalltalk: [],
  off_topic: [],
};

/** Below this, Muse gets every tool. */
export const MIN_CONFIDENCE = 0.6;
/** Off-topic only skips Muse when Jev is this sure. */
export const OFF_TOPIC_CONFIDENCE = 0.85;

export interface RouteDecision {
  route: Route;
  confidence: number;
  ms: number;
  tokens_in: number | null;
}

export async function routeTurn(
  env: Env,
  turn: { previous?: string; message: string },
  fetchImpl: typeof fetch = fetch,
): Promise<RouteDecision | null> {
  const router = env.router;
  if (!router) return null;
  const started = Date.now();
  try {
    const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${router.apiKey}`,
      },
      body: JSON.stringify({
        model: router.model,
        state: {
          app: "Household manuals and upkeep: appliances, baby gear, car seats.",
          muse_said_last: turn.previous?.slice(0, 800) ?? null,
          user_message: turn.message.slice(0, 2_000),
        },
        questions: {
          intent: {
            type: "choice",
            instructions: "What is the user's message doing?",
            criteria: ROUTES,
          },
        },
      }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      answers?: { intent?: { choice?: string; confidence?: number } };
      usage?: { input_tokens?: number };
    };
    const choice = body.answers?.intent?.choice;
    const confidence = body.answers?.intent?.confidence;
    if (!choice || !(choice in ROUTES) || typeof confidence !== "number") return null;
    return {
      route: choice as Route,
      confidence,
      ms: Date.now() - started,
      tokens_in: body.usage?.input_tokens ?? null,
    };
  } catch {
    return null;
  }
}

/** The "Set it up with Muse" button's message on a thing's page: a setup turn, no need to ask Jev. */
export const SETUP_MESSAGE = /^Set up the .{1,80} with me\b/;

/** A setup turn Muse must end with a form or a question. */
export function isSetup(decision: RouteDecision | null): boolean {
  return decision?.route === "setup" && decision.confidence >= MIN_CONFIDENCE;
}

/** The tool names to offer, or null for every tool. */
export function toolsFor(decision: RouteDecision | null): string[] | null {
  if (!decision || decision.confidence < MIN_CONFIDENCE) return null;
  return ROUTE_TOOLS[decision.route];
}

export const OFF_TOPIC_REPLY =
  "I can only help with the things in your home: their manuals, upkeep, and your children's car seats and gear. What would you like to know about one of them?";
