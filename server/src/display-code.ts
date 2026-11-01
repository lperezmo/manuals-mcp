import type { Env } from "./env.js";
import {
  answerFrom,
  type FastLane,
  type FastPick,
  isCarSeat,
  SAFETY_MAX,
  type Snapshot,
  type SnapshotItem,
  type SnapshotRow,
} from "./fastlane.js";
import { MIN_CONFIDENCE } from "./router.js";

// Reading an error code off a photo of a display (issue #16).
//
// Every code a display can show was saved when its manual was read: a
// manual_facts row with kind "error_code" and the code as displayed in its
// label. So reading the display is a closed-set question, which is what Jev's
// Choice is for. One Jev call gets the photo and a Choice over every saved
// error code in the household (the chat doesn't know which thing the photo is
// of, and the same code on two things is then just two options), plus yes/no
// questions: does the photo show a display with a code, is that code one of
// the saved ones, is it clear enough to read, is the photo about safety, and,
// when words came with the photo, do they ask about that code at all.
// TypeSafe's docs say a "none of the above" option works poorly, so the
// "is it one of these" Noul stands in for it (the semantic-find pattern).
//
// A confident read answers straight from the saved fact and its page, as an
// instant answer, with no Muse image read. Anything doubtful, a car seat, a
// safety matter, a Jev error or a timeout goes on to Muse exactly as before.

/** Jev's Choice takes at most 255 options. */
const MAX_OPTIONS = 250;

// The bars, all conservative because a wrong code is a wrong answer about a fault:
/**
 * The photo shows an appliance display with a code. 0.85 is the bar lookAtPhoto
 * uses for a yes/no read off a chat photo.
 */
export const DISPLAY_AT = 0.85;
/** The code on it is one of the saved ones: the Choice's companion "exists" Noul. */
export const LISTED_AT = 0.85;
/** Every character can be read (no blur, glare, cut-off or mid-blink). */
export const CLEAR_AT = 0.7;
/**
 * The code itself (its options added up across things that share it). 0.90 is
 * the scanned-record cookbook's bar for taking a read value without review,
 * the closest of TypeSafe's cookbooks to reading a display. Probabilities add
 * up to 1, so this also means every other code is at most 0.10 behind it.
 */
export const CODE_AT = 0.9;
/**
 * Words that came with the photo ask about the code on it ("what does this
 * mean?"), not about something else in the picture ("how often do I clean
 * this filter?"). The same bar as the display Noul.
 */
export const ABOUT_AT = 0.85;

/** One saved code on one thing: what Jev chooses between. */
export interface CodeOption {
  /** The fact id: the Choice option's name. */
  id: string;
  /** The code with spacing, dashes, "Er" and leading zeros smoothed out. */
  key: string;
  row: SnapshotRow;
  item: SnapshotItem;
}

/**
 * The same code however it's written: "E4", "E-4", "e 4", "Er4", "Err 4" and
 * "E04" are all "E4". Lookalike segments (5 and S, 8 and B) are left alone:
 * telling those apart is Jev's job, not a guess made here.
 */
export function codeKey(label: string): string {
  const flat = label.toUpperCase().replace(/[\s\-_.:]+/g, "");
  return flat.replace(/^ERR?(?=\d)/, "E").replace(/^([A-Z]+)0+(?=\d)/, "$1");
}

/** How a code may look on the display, for Jev: "E4", "E-4", "E04" and "Er4". */
function variants(key: string): string[] {
  const m = key.match(/^([A-Z]{1,3})(\d{1,3})$/);
  if (!m?.[1] || !m[2]) return [];
  const [, letters, digits] = m;
  const out = [key, `${letters}-${digits}`];
  if (digits.length === 1) out.push(`${letters}0${digits}`);
  if (letters === "E") out.push(`Er${digits}`);
  return out;
}

const STATUS_RANK: Record<string, number> = {
  confirmed: 0,
  revised: 1,
  extracted: 2,
  needs_review: 3,
};

function itemName(item: SnapshotItem): string {
  const make = [item.brand, item.model].filter(Boolean).join(" ");
  return make ? `${item.nickname} (${make})` : item.nickname;
}

/**
 * The household's saved error codes, one option per code per thing (a code
 * saved twice on one thing, as "E4" and "E-4", is one option: the best
 * checked row). A household with more than the Choice can take keeps the
 * things named in the question; past that, or with none saved, there's
 * nothing to choose from.
 */
export function codeOptions(snapshot: Snapshot, question = ""): CodeOption[] {
  const items = new Map(snapshot.items.map((i) => [i.id, i]));
  const best = new Map<string, CodeOption>();
  for (const row of snapshot.rows) {
    if (row.type !== "fact" || row.kind !== "error_code") continue;
    const item = items.get(row.item_id);
    const key = codeKey(row.label);
    if (!item || !key) continue;
    const slot = `${item.id}|${key}`;
    const held = best.get(slot);
    if (!held || (STATUS_RANK[row.status] ?? 2) < (STATUS_RANK[held.row.status] ?? 2)) {
      best.set(slot, { id: row.id, key, row, item });
    }
  }
  const all = [...best.values()];
  if (all.length <= MAX_OPTIONS) return all;
  const asked = question.toLowerCase();
  const named = all.filter((o) => {
    const name = o.item.nickname.toLowerCase().trim();
    return name.length > 1 && asked.includes(name);
  });
  return named.length && named.length <= MAX_OPTIONS ? named : [];
}

export interface DisplayRead {
  options: CodeOption[];
  /** Jev's probability per option id. */
  probs: Record<string, number>;
  /** `about` is 1 for a photo sent with no words: there's nothing else it could ask. */
  scores: { display: number; listed: number; clear: number; safety: number; about: number };
  tokens_in: number | null;
  ms: number;
}

interface JevAnswers {
  answers?: Record<
    string,
    { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }
  >;
  usage?: { input_tokens?: number };
}

/** One Jev call with the photo; null when there are no codes, no key, or Jev fails. */
export async function readDisplay(
  env: Env,
  image: { mime: string; base64: string },
  snapshot: Snapshot,
  question = "",
  fetchImpl: typeof fetch = fetch,
): Promise<DisplayRead | null> {
  const router = env.router;
  // Jev takes JPEG and PNG; WebP goes straight to Muse.
  const format = { "image/jpeg": "jpg", "image/png": "png" }[image.mime];
  if (!router || !format) return null;
  const options = codeOptions(snapshot, question);
  if (!options.length) return null;
  const describe = (o: CodeOption) => {
    const also = variants(o.key).filter((v) => v !== o.row.label.trim());
    const shown = also.length ? ` (may show as ${also.join(", ")})` : "";
    return `${itemName(o.item)} · ${o.row.label.trim()}${shown}`;
  };
  const asked = question.trim().slice(0, 500);
  const started = Date.now();
  try {
    const res = await fetchImpl(`${router.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${router.apiKey}`,
        "TypeSafe-Danger-Zone-Images": "true",
      },
      body: JSON.stringify({
        model: router.model,
        state: {
          photo: "display-photo",
          codes: options.map((o) => `${o.item.nickname} · ${o.row.label.trim()}`).join("\n"),
          ...(asked ? { question: asked } : {}),
        },
        assets: { "display-photo": { type: "image", format, data_base64: image.base64 } },
        questions: {
          code: {
            type: "choice",
            instructions:
              "Which error or fault code is shown on the appliance display in `photo`? Each option is a thing in the house and a code its display can show.",
            criteria: Object.fromEntries(options.map((o) => [o.id, describe(o)])),
          },
          display: {
            type: "noul",
            instructions:
              "Does `photo` show an appliance's display or control panel showing an error or fault code?",
          },
          listed: {
            type: "noul",
            instructions:
              "Is the code shown on the display in `photo` one of the codes in `codes`, written the same way or with only a dash, a space, a leading zero or an Er prefix added?",
          },
          clear: {
            type: "noul",
            instructions:
              "Is the code on the display in `photo` sharp, lit and whole, so every character can be read with no doubt (not blurred, glared, cut off or caught mid-blink, and no 5 that could be an S or 8 that could be a B)?",
          },
          safety: {
            type: "noul",
            instructions:
              "Is `photo` about safety: a smoke, carbon monoxide or gas alarm, a child's car seat, or a fire, burn, gas, electrical or chemical hazard?",
          },
          ...(asked
            ? {
                about: {
                  type: "noul",
                  instructions:
                    "Is `question` asking what the code shown on the display in `photo` means or what to do about it, rather than about something else?",
                },
              }
            : {}),
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as JevAnswers;
    const a = body.answers ?? {};
    const nouls = {
      display: a.display?.noul,
      listed: a.listed?.noul,
      clear: a.clear?.noul,
      safety: a.safety?.noul,
      about: asked ? a.about?.noul : 1,
    };
    if (Object.values(nouls).some((p) => typeof p !== "number")) return null;
    const probs: Record<string, number> = { ...(a.code?.probabilities ?? {}) };
    const choice = a.code?.choice;
    if (choice && probs[choice] === undefined && typeof a.code?.confidence === "number") {
      probs[choice] = a.code.confidence;
    }
    return {
      options,
      probs,
      scores: nouls as DisplayRead["scores"],
      tokens_in: body.usage?.input_tokens ?? null,
      ms: Date.now() - started,
    };
  } catch {
    return null;
  }
}

export interface DisplayAnswer {
  /** Set when the server can answer from the saved code without Muse. */
  answer: { text: string; pick: FastPick } | null;
  /** Why not, when it can't: shown in the model log. */
  reason: string | null;
  /** The code Jev read, and how sure it was of it across the things that have it. */
  code: string | null;
  p: number;
}

/**
 * Whether a display read answers the turn by itself. `lane` is the fast
 * lane's text read of the same turn (route, safety, which thing), and is
 * required when the person typed something with the photo: a photo with
 * words can be asking anything. A photo sent alone is read as "what's this".
 */
export function answerDisplay(
  read: DisplayRead,
  lane: FastLane | null,
  question: string,
): DisplayAnswer {
  // Add up each code's options across things (E4 on the washer and the dryer).
  const byKey = new Map<string, number>();
  for (const o of read.options) byKey.set(o.key, (byKey.get(o.key) ?? 0) + (read.probs[o.id] ?? 0));
  const [code, p] = [...byKey.entries()].sort((x, y) => y[1] - x[1])[0] ?? [null, 0];
  const no = (reason: string): DisplayAnswer => ({ answer: null, reason, code, p });
  const s = read.scores;
  if (question.trim()) {
    if (!lane?.route) return no("no_route");
    if (lane.route.route !== "ask" || lane.route.confidence < MIN_CONFIDENCE)
      return no("not_a_question");
    if (lane.scores.safety > SAFETY_MAX) return no("safety");
    if (s.about < ABOUT_AT) return no("other_question");
  }
  if (s.safety > SAFETY_MAX) return no("safety");
  if (s.display < DISPLAY_AT) return no("no_display");
  if (s.listed < LISTED_AT) return no("not_saved");
  if (s.clear < CLEAR_AT) return no("unclear");
  if (!code || p < CODE_AT) return no("unsure_code");
  const sharing = read.options
    .filter((o) => o.key === code)
    .sort((x, y) => (read.probs[y.id] ?? 0) - (read.probs[x.id] ?? 0));
  // The thing: the only one with this code; the one the question names; or,
  // when several have it, one Jev itself is as sure of as of the code.
  const named = lane?.thing ? sharing.find((o) => o.item.id === lane.thing?.id) : undefined;
  const pick =
    sharing.length === 1
      ? sharing[0]
      : (named ?? (sharing[0] && (read.probs[sharing[0].id] ?? 0) >= CODE_AT ? sharing[0] : null));
  if (!pick) return no("same_code_elsewhere");
  if (lane?.thing && lane.thing.id !== pick.item.id) return no("thing_mismatch");
  if (isCarSeat(pick.item)) return no("safety");
  if (pick.row.status === "needs_review") return no("needs_review");
  return {
    answer: {
      text: `The photo shows ${answerFrom(pick.row, pick.item)}`,
      pick: { row: pick.row, item: pick.item, p },
    },
    reason: null,
    code,
    p,
  };
}

/** The model log's tag: what the display read decided and how sure it was. */
export function displayTag(read: DisplayRead, decided: DisplayAnswer): string {
  const what = decided.answer ? "answered" : `muse:${decided.reason ?? "?"}`;
  const s = read.scores;
  return `display:${what} ${decided.code ?? "-"} ${decided.p.toFixed(2)} shown ${s.display.toFixed(2)}/${s.listed.toFixed(2)}/${s.clear.toFixed(2)}`;
}
