import { describe, expect, test } from "bun:test";

// The chat box's mic (plain JS, served as /dictate.js), driven by a fake recognizer.
type Result = { 0: { transcript: string }; isFinal: boolean; length: number };
type Dictation = {
  start: () => void;
  stop: () => void;
  cancel: () => void;
  toggle: () => void;
  readonly listening: boolean;
};
const mod = (await import(String(new URL("../public/dictate.js", import.meta.url)))) as {
  speechCtor: (win?: Record<string, unknown>) => unknown;
  dictationError: (code: string) => string | null;
  joinSpoken: (before: string, results: Result[]) => string;
  createDictation: (opts: Record<string, unknown>) => Dictation | null;
};
const { speechCtor, dictationError, joinSpoken, createDictation } = mod;

const said = (transcript: string, isFinal = false): Result => ({
  0: { transcript },
  isFinal,
  length: 1,
});

/** A stand-in for SpeechRecognition that records what was asked of it. */
function fakeCtor({ available }: { available?: string } = {}) {
  const made: FakeRec[] = [];
  class FakeRec {
    lang = "";
    interimResults = false;
    continuous = true;
    maxAlternatives = 0;
    processLocally = false;
    started = 0;
    stopped = 0;
    aborted = 0;
    onresult: ((e: { results: Result[] }) => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    constructor() {
      made.push(this);
    }
    start() {
      this.started++;
    }
    stop() {
      this.stopped++;
      this.onend?.();
    }
    abort() {
      this.aborted++;
      this.onend?.();
    }
    static available = available ? async () => available : undefined;
  }
  return { Ctor: FakeRec, made };
}

describe("is there a mic to show", () => {
  test("the standard name, Chrome's prefixed one, or none (Firefox)", () => {
    const A = () => {};
    const B = () => {};
    expect(speechCtor({ SpeechRecognition: A })).toBe(A);
    expect(speechCtor({ webkitSpeechRecognition: B })).toBe(B);
    expect(speechCtor({})).toBe(null);
    expect(createDictation({ Ctor: null })).toBe(null);
  });
});

describe("words in the box", () => {
  test("what's heard goes after what was already typed", () => {
    expect(joinSpoken("", [said("when did I")])).toBe("when did I");
    expect(joinSpoken("Washer: ", [said("it shows"), said(" E4")])).toBe("Washer: it shows E4");
    expect(joinSpoken("kept", [])).toBe("kept");
  });

  test("text shows live as you talk, then the final sentence, and nothing is sent", () => {
    const { Ctor, made } = fakeCtor();
    const texts: [string, boolean][] = [];
    const states: boolean[] = [];
    const d = createDictation({
      Ctor,
      lang: "es-MX",
      read: () => "",
      onText: (t: string, f: boolean) => texts.push([t, f]),
      onState: (s: boolean) => states.push(s),
    })!;
    d.toggle();
    const rec = made[0]!;
    expect(rec.started).toBe(1);
    expect(rec.lang).toBe("es-MX");
    expect(rec.interimResults).toBe(true);
    expect(rec.continuous).toBe(false);
    expect(d.listening).toBe(true);
    rec.onresult?.({ results: [said("when did I")] });
    rec.onresult?.({ results: [said("when did I last clean the filter", true)] });
    expect(texts).toEqual([
      ["when did I", false],
      ["when did I last clean the filter", true],
    ]);
    rec.onend?.();
    expect(states).toEqual([true, false]);
    expect(d.listening).toBe(false);
  });
});

describe("starting and stopping", () => {
  test("tapping again stops it", () => {
    const { Ctor, made } = fakeCtor();
    const d = createDictation({ Ctor })!;
    d.toggle();
    d.toggle();
    expect(made[0]!.stopped).toBe(1);
    expect(d.listening).toBe(false);
    d.toggle();
    expect(made).toHaveLength(2);
  });

  test("sending cancels it, and anything still coming is dropped", () => {
    const { Ctor, made } = fakeCtor();
    const texts: string[] = [];
    const d = createDictation({ Ctor, onText: (t: string) => texts.push(t) })!;
    d.start();
    const rec = made[0]!;
    d.cancel();
    expect(rec.aborted).toBe(1);
    rec.onresult?.({ results: [said("late words", true)] });
    expect(texts).toEqual([]);
    expect(d.listening).toBe(false);
  });

  test("a blocked mic says how to allow it; stopping it yourself says nothing", () => {
    const { Ctor, made } = fakeCtor();
    const errors: string[] = [];
    const d = createDictation({ Ctor, onError: (m: string) => errors.push(m) })!;
    d.start();
    made[0]!.onerror?.({ error: "not-allowed" });
    expect(d.listening).toBe(false);
    d.start();
    made[1]!.onerror?.({ error: "aborted" });
    expect(errors).toEqual([dictationError("not-allowed")!]);
    expect(errors[0]).toContain("Allow it");
  });

  test("a recognizer that throws on start ends quietly with a message", () => {
    const { Ctor } = fakeCtor();
    const Throws = class extends Ctor {
      override start(): void {
        throw new Error("InvalidStateError");
      }
    };
    const errors: string[] = [];
    const d = createDictation({ Ctor: Throws, onError: (m: string) => errors.push(m) })!;
    d.start();
    expect(d.listening).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe("on-device recognition", () => {
  test("asked for when Chrome says it's installed for the language", async () => {
    const { Ctor, made } = fakeCtor({ available: "available" });
    const d = createDictation({ Ctor, lang: "en-US" })!;
    await Promise.resolve();
    await Promise.resolve();
    d.start();
    expect(made[0]!.processLocally).toBe(true);
  });

  test("left off when it would need a download, or the browser can't say", async () => {
    for (const available of ["downloadable", undefined]) {
      const { Ctor, made } = fakeCtor({ available });
      const d = createDictation({ Ctor })!;
      await Promise.resolve();
      await Promise.resolve();
      d.start();
      expect(made[0]!.processLocally).toBe(false);
    }
  });
});
