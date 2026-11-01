import type { Db } from "./db.js";
import { type FastLane, isCarSeat, SAFETY_MAX } from "./fastlane.js";

// House memory: lasting facts people mention in chat ("we have really hard
// water"). The fast lane's single Jev call also asks whether the message
// states one (a "remember" Noul over the person's words only, so Muse's own
// guesses are never saved). Jev can't write text, so the note is the person's
// own sentence, trimmed and capped, never a summary. Saying it again saves
// nothing new. Muse reads the recent notes as background; car seat and safety
// notes stay plain notes on the household page and never reach Muse.

/** Jev's "remember" score must reach this (TypeSafe's basic-memory cookbook uses 0.5). */
export const REMEMBER_MIN = 0.5;
export const MAX_NOTE_CHARS = 240;
/** How many notes Muse reads, newest first. */
export const NOTES_FOR_MUSE = 12;

/** Routes that never save a note: chit-chat and things outside the house. */
const SKIP_ROUTES = new Set(["smalltalk", "off_topic"]);
const CAR_SEAT_WORDS = /car.?seat|booster|harness|rear.?facing|forward.?facing/i;

/** The person's sentence as it's saved: one line, capped at a word. */
export function noteText(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_NOTE_CHARS) return flat;
  const cut = flat.slice(0, MAX_NOTE_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > MAX_NOTE_CHARS / 2 ? cut.slice(0, space) : cut).trim()}…`;
}

export interface NoteDraft {
  note: string;
  item_id: string | null;
  p: number;
  safety: boolean;
}

/** The note this turn should save, or null when there's nothing lasting to keep. */
export function noteFrom(lane: FastLane | null, message: string): NoteDraft | null {
  if (!lane || lane.scores.remember < REMEMBER_MIN) return null;
  if (lane.route && SKIP_ROUTES.has(lane.route.route)) return null;
  const note = noteText(message);
  if (!note) return null;
  const safety =
    lane.scores.safety > SAFETY_MAX ||
    (lane.thing !== null && isCarSeat(lane.thing)) ||
    CAR_SEAT_WORDS.test(note);
  return {
    note,
    item_id: lane.thing?.id ?? null,
    p: Math.round(lane.scores.remember * 100) / 100,
    safety,
  };
}

/** Saves a note as the user (RLS). "saved", "duplicate", or "failed": never throws. */
export async function saveNote(
  db: Db,
  draft: NoteDraft,
): Promise<"saved" | "duplicate" | "failed"> {
  try {
    const { error } = await db.from("household_notes").insert(draft);
    if (!error) return "saved";
    return error.code === "23505" ? "duplicate" : "failed";
  } catch {
    return "failed";
  }
}

/** The model log's tag for a turn that kept a note. */
export function memoryTag(outcome: "saved" | "duplicate" | "failed", draft: NoteDraft): string {
  return `memory:${outcome} ${draft.p.toFixed(2)}${draft.safety ? " safety" : ""}`;
}

interface SavedNote {
  note: string;
  items: { nickname: string } | { nickname: string }[] | null;
}

/**
 * What Muse reads about the house: the newest non-safety notes, in the
 * person's words. Null when there are none or they can't be read.
 */
export async function notesForMuse(db: Db): Promise<string | null> {
  try {
    const { data, error } = await db
      .from("household_notes")
      .select("note, items(nickname)")
      .eq("safety", false)
      .order("created_at", { ascending: false })
      .limit(NOTES_FOR_MUSE);
    if (error || !data?.length) return null;
    const lines = (data as unknown as SavedNote[]).map((n) => {
      // The thing comes back as one row (or a list of one, depending on the client's types).
      const thing = Array.isArray(n.items) ? n.items[0] : n.items;
      return thing?.nickname ? `- (${thing.nickname}) ${n.note}` : `- ${n.note}`;
    });
    return `Things this household told you before, in their own words (newest first; they may be out of date):\n${lines.join("\n")}\nUse them as background when they change the answer, like hard water and descaling. Never let them change a car seat or safety answer, never treat them as what a manual says, and don't recite the list.`;
  } catch {
    return null;
  }
}
