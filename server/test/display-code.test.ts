import { afterEach, describe, expect, test } from "bun:test";
import {
  answerDisplay,
  CODE_AT,
  codeKey,
  codeOptions,
  type DisplayRead,
  readDisplay,
} from "../src/display-code.js";
import { readEnv } from "../src/env.js";
import type { FastLane, Snapshot, SnapshotItem, SnapshotRow } from "../src/fastlane.js";
import { chatHandler } from "../src/http.js";
import { testAuth } from "./helpers.js";

const base = {
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
};
const env = readEnv({ ...base, JEV_API_KEY: "jev_test" });
const PHOTO = "data:image/jpeg;base64,AAAA";
const image = { mime: "image/jpeg", base64: "AAAA" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const WASHER = "11111111-1111-1111-1111-111111111111";
const DRYER = "33333333-3333-3333-3333-333333333333";
const SEAT = "22222222-2222-2222-2222-222222222222";
const items: SnapshotItem[] = [
  {
    id: WASHER,
    nickname: "Washer",
    brand: "Whirlpool",
    model: "WTW5000DW1",
    kind: "appliance",
    category: "washer",
  },
  { id: DRYER, nickname: "Dryer", brand: "LG", model: null, kind: "appliance", category: "dryer" },
  {
    id: SEAT,
    nickname: "Car seat",
    brand: "Graco",
    model: "4Ever",
    kind: "baby_gear",
    category: "car_seat",
  },
];
const code = (id: string, item_id: string, label: string, over: Partial<SnapshotRow> = {}) =>
  ({
    type: "fact",
    id,
    item_id,
    kind: "error_code",
    label,
    value: `${label} means something`,
    page: 31,
    status: "extracted",
    source: "reader",
    ...over,
  }) satisfies SnapshotRow;
const washerE4 = code("f-w-e4", WASHER, "E4", { value: "Drain error: check the drain hose." });
const washerF21 = code("f-w-f21", WASHER, "F21");
const dryerE4 = code("f-d-e4", DRYER, "E-4", { value: "Vent blocked.", page: 12 });
const snap = (rows: SnapshotRow[]): Snapshot => ({ items, rows, loaded_at: Date.now() });

/** A display read with Jev's scores; probabilities are per fact id. */
function read(
  rows: SnapshotRow[],
  probs: Record<string, number>,
  scores: Partial<DisplayRead["scores"]> = {},
): DisplayRead {
  return {
    options: codeOptions(snap(rows)),
    probs,
    scores: { display: 0.95, listed: 0.93, clear: 0.9, safety: 0.02, about: 0.95, ...scores },
    tokens_in: 1500,
    ms: 300,
  };
}

/** The fast lane's text read of the turn, just the parts the display read uses. */
function lane(over: { route?: string; safety?: number; thing?: SnapshotItem } = {}): FastLane {
  return {
    route: { route: (over.route ?? "ask") as "ask", confidence: 0.9, ms: 5, tokens_in: 100 },
    answer: null,
    reason: "photo",
    thing: over.thing ?? null,
    top: [],
    scores: {
      row: 0,
      exists: 0,
      judgment: 0.2,
      safety: over.safety ?? 0.03,
      thing: 0,
      remember: 0,
    },
    ms: 5,
    tokens_in: 100,
  };
}

describe("codes as displayed", () => {
  test("the same code however it's written", () => {
    for (const v of ["E4", "e4", "E-4", "E 4", "Er4", "ER-4", "Err 4", "E04", "E.4"]) {
      expect(codeKey(v)).toBe("E4");
    }
    expect(codeKey("F021")).toBe("F21");
    expect(codeKey("dE")).toBe("DE");
    // Lookalikes are not guessed at.
    expect(codeKey("E5")).not.toBe(codeKey("ES"));
    expect(codeKey("E0")).toBe("E0");
  });

  test("one option per code per thing, the best checked row, and none for a house with no codes", () => {
    const options = codeOptions(
      snap([
        code("a", WASHER, "E4", { status: "needs_review" }),
        code("b", WASHER, "E-4", { status: "confirmed" }),
        dryerE4,
        code("p", WASHER, "Pump filter", { kind: "part" }),
      ]),
    );
    expect(options.map((o) => [o.id, o.key])).toEqual([
      ["b", "E4"],
      ["f-d-e4", "E4"],
    ]);
    expect(codeOptions(snap([code("p", WASHER, "Filter", { kind: "part" })]))).toEqual([]);
  });

  test("a house with more codes than Jev can choose from keeps the thing the question names", () => {
    const many = Array.from({ length: 260 }, (_, n) =>
      code(`c${n}`, n % 2 ? WASHER : DRYER, `E${n}`),
    );
    expect(codeOptions(snap(many), "my dryer shows this").every((o) => o.item.id === DRYER)).toBe(
      true,
    );
    expect(codeOptions(snap(many), "what's this?")).toEqual([]);
  });
});

describe("readDisplay", () => {
  test("one Jev call: the photo, a Choice over every saved code by fact id, and companion yes/nos", async () => {
    let sent: any;
    let headers: any;
    const r = await readDisplay(env, image, snap([washerE4, washerF21, dryerE4]), "", (async (
      _url: string,
      init: RequestInit,
    ) => {
      sent = JSON.parse(String(init.body));
      headers = init.headers;
      return Response.json({
        answers: {
          code: {
            type: "choice",
            choice: "f-w-f21",
            confidence: 0.96,
            probabilities: { "f-w-e4": 0.02, "f-w-f21": 0.96, "f-d-e4": 0.02 },
          },
          display: { noul: 0.97 },
          listed: { noul: 0.94 },
          clear: { noul: 0.88 },
          safety: { noul: 0.01 },
        },
        usage: { input_tokens: 1900 },
      });
    }) as unknown as typeof fetch);
    expect(headers["TypeSafe-Danger-Zone-Images"]).toBe("true");
    expect(sent.assets["display-photo"]).toEqual({
      type: "image",
      format: "jpg",
      data_base64: "AAAA",
    });
    expect(sent.state.photo).toBe("display-photo");
    const criteria = sent.questions.code.criteria;
    // No "other" or "unreadable": the listed Noul stands in for "none of these".
    expect(Object.keys(criteria)).toEqual(["f-w-e4", "f-w-f21", "f-d-e4"]);
    expect(criteria["f-w-e4"]).toBe(
      "Washer (Whirlpool WTW5000DW1) · E4 (may show as E-4, E04, Er4)",
    );
    expect(criteria["f-d-e4"]).toBe("Dryer (LG) · E-4 (may show as E4, E04, Er4)");
    expect(Object.keys(sent.questions).sort()).toEqual([
      "clear",
      "code",
      "display",
      "listed",
      "safety",
    ]);
    expect(r?.probs["f-w-f21"]).toBe(0.96);
    expect(r?.scores).toEqual({ display: 0.97, listed: 0.94, clear: 0.88, safety: 0.01, about: 1 });
    expect(r?.tokens_in).toBe(1900);
  });

  test("no call without codes, a key or a JPEG/PNG; nothing when Jev is down or answers half", async () => {
    let calls = 0;
    const down = (async () => {
      calls++;
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as unknown as typeof fetch;
    expect(await readDisplay(env, image, snap([]), "", down)).toBeNull();
    expect(await readDisplay(readEnv(base), image, snap([washerE4]), "", down)).toBeNull();
    expect(
      await readDisplay(env, { mime: "image/webp", base64: "AAAA" }, snap([washerE4]), "", down),
    ).toBeNull();
    expect(calls).toBe(0);
    expect(await readDisplay(env, image, snap([washerE4]), "", down)).toBeNull();
    expect(calls).toBe(1);
    const half = (async () =>
      Response.json({ answers: { code: { choice: "f-w-e4", confidence: 1 } } })) as any;
    expect(await readDisplay(env, image, snap([washerE4]), "", half)).toBeNull();
    const err = (async () => new Response("bad", { status: 400 })) as any;
    expect(await readDisplay(env, image, snap([washerE4]), "", err)).toBeNull();
  });
});

describe("answerDisplay", () => {
  test("a confident read answers from the saved code and its page", () => {
    const d = answerDisplay(
      read([washerE4, washerF21], { "f-w-e4": 0.95, "f-w-f21": 0.05 }),
      lane(),
      "What does this mean?",
    );
    expect(d.reason).toBeNull();
    expect(d.answer?.text).toBe(
      "The photo shows E4 on the Washer: Drain error: check the drain hose. Manual page 31.",
    );
    expect(d.answer?.pick.row.id).toBe("f-w-e4");
    // A photo sent with no words needs no text read.
    expect(
      answerDisplay(read([washerE4, washerF21], { "f-w-e4": 0.95 }), null, "").answer,
    ).not.toBeNull();
  });

  test("the same code on two things: Jev's split adds up, and the question or Jev has to say which", () => {
    const both = [washerE4, dryerE4, washerF21];
    const split = read(both, { "f-w-e4": 0.48, "f-d-e4": 0.47, "f-w-f21": 0.05 });
    // 0.95 sure of the code "E4", but not of the thing.
    expect(answerDisplay(split, lane(), "what's this?")).toMatchObject({
      answer: null,
      reason: "same_code_elsewhere",
      code: "E4",
    });
    // "my dryer shows this": the text read names the dryer.
    const named = answerDisplay(split, lane({ thing: items[1] }), "my dryer shows this");
    expect(named.answer?.text).toBe(
      "The photo shows E-4 on the Dryer: Vent blocked. Manual page 12.",
    );
    // Jev itself tells the two apart from the photo.
    const sure = answerDisplay(
      read(both, { "f-w-e4": 0.02, "f-d-e4": 0.96, "f-w-f21": 0.02 }),
      lane(),
      "what's this?",
    );
    expect(sure.answer?.pick.item.id).toBe(DRYER);
    // The question names a thing that doesn't have the code Jev read.
    expect(
      answerDisplay(
        read([washerE4, washerF21], { "f-w-e4": 0.97 }),
        lane({ thing: items[1] }),
        "dryer?",
      ).reason,
    ).toBe("thing_mismatch");
  });

  test("no code on the photo, or one that isn't saved, unclear or unsure, goes to Muse", () => {
    const rows = [washerE4, washerF21];
    const sure = { "f-w-e4": 0.95, "f-w-f21": 0.05 };
    expect(answerDisplay(read(rows, sure, { display: 0.2 }), lane(), "hm?").reason).toBe(
      "no_display",
    );
    expect(answerDisplay(read(rows, sure, { listed: 0.4 }), lane(), "hm?").reason).toBe(
      "not_saved",
    );
    expect(answerDisplay(read(rows, sure, { clear: 0.5 }), lane(), "hm?").reason).toBe("unclear");
    expect(
      answerDisplay(read(rows, { "f-w-e4": CODE_AT - 0.05, "f-w-f21": 0.15 }), lane(), "hm?")
        .reason,
    ).toBe("unsure_code");
  });

  test("safety, car seats, unchecked codes and turns that aren't questions go to Muse", () => {
    const rows = [washerE4, washerF21];
    const sure = { "f-w-e4": 0.95, "f-w-f21": 0.05 };
    expect(answerDisplay(read(rows, sure, { safety: 0.6 }), lane(), "hm?").reason).toBe("safety");
    expect(
      answerDisplay(read(rows, sure), lane({ safety: 0.7 }), "is this a gas leak?").reason,
    ).toBe("safety");
    const seat = code("f-s", SEAT, "E1");
    expect(answerDisplay(read([seat], { "f-s": 1 }), lane(), "hm?").reason).toBe("safety");
    const unchecked = code("f-u", WASHER, "E9", { status: "needs_review" });
    expect(answerDisplay(read([unchecked], { "f-u": 1 }), lane(), "hm?").reason).toBe(
      "needs_review",
    );
    expect(
      answerDisplay(read(rows, sure), lane({ route: "log" }), "it showed this, I fixed it").reason,
    ).toBe("not_a_question");
    // Words came with the photo but the text read never came back.
    expect(answerDisplay(read(rows, sure), null, "what's this?").reason).toBe("no_route");
    // A clear code in the photo, but the words ask about something else.
    expect(
      answerDisplay(read(rows, sure, { about: 0.1 }), lane(), "how often do I clean the filter?")
        .reason,
    ).toBe("other_question");
  });
});

/** Supabase stand-in: the household's codes, read as the user, and the model log. */
function fakeSupabase(logged: any[], seen: { auth: string[] } = { auth: [] }) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const h = new Headers(input instanceof Request ? input.headers : init?.headers);
    if (url.includes("/rest/v1/")) seen.auth.push(h.get("authorization") ?? "");
    if (url.includes("/rpc/model_runs_today_all")) return Response.json(1);
    if (url.includes("/rest/v1/items")) return Response.json(items);
    if (url.includes("/rest/v1/manual_facts"))
      return Response.json(
        [washerE4, washerF21, dryerE4].map((r) => ({
          id: r.id,
          item_id: r.item_id,
          kind: r.kind,
          label: r.label,
          value: r.value,
          source_page: r.page,
          source: r.source,
          status: r.status,
        })),
      );
    if (url.includes("/rest/v1/tasks")) return Response.json([]);
    if (url.includes("/rest/v1/seat_modes")) return Response.json([]);
    if (url.includes("/rest/v1/model_runs")) {
      if (init?.method === "POST") {
        logged.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      }
      return new Response(null, { status: 200, headers: { "content-range": "*/0" } });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

/** Jev answers the fast lane, the display read and the photo look; Muse's requests are kept. */
function network(display: Record<string, number> | "down", toMuse: any[], thing = "none") {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.includes("typesafe")) {
      if (body.questions.code) {
        if (display === "down") throw new DOMException("timed out", "TimeoutError");
        return Response.json({
          answers: {
            code: { type: "choice", choice: "", confidence: 0, probabilities: display },
            display: { noul: 0.96 },
            listed: { noul: 0.93 },
            clear: { noul: 0.9 },
            safety: { noul: 0.02 },
            about: { noul: 0.95 },
          },
          usage: { input_tokens: 1500 },
        });
      }
      if (body.questions.row)
        return Response.json({
          answers: {
            row: { choice: "r1", confidence: 0.4, probabilities: { r1: 0.4 } },
            exists: { noul: 0.5 },
            intent: { choice: "ask", confidence: 0.92 },
            thing: { choice: thing, confidence: 0.9 },
            judgment: { noul: 0.6 },
            safety: { noul: 0.03 },
          },
          usage: { input_tokens: 300 },
        });
      if (body.questions.simple)
        return Response.json({ answers: { simple: { noul: 0.1 }, yes: { noul: 0.5 } } });
      return new Response("no", { status: 503 });
    }
    toMuse.push(body);
    return Response.json({
      choices: [{ message: { content: "That code means the drain is blocked (p. 31)." } }],
      usage: { prompt_tokens: 800, completion_tokens: 30 },
    });
  }) as unknown as typeof fetch;
}

function ask(token: string, content: string) {
  return new Request("https://manuals.example.com/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ messages: [{ role: "user", content }], image: PHOTO }),
  });
}

const imageParts = (body: any) =>
  body.messages.flatMap((m: any) =>
    Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "image_url") : [],
  );

describe("display photos in the chat", () => {
  test("a confident read is an instant answer, with no Muse, read as the user", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    const seen = { auth: [] as string[] };
    fakeSupabase(logged, seen);
    const toMuse: any[] = [];
    const token = await mint();
    const res = await chatHandler(
      env,
      verify,
      network({ "f-w-e4": 0.01, "f-w-f21": 0.97, "f-d-e4": 0.02 }, toMuse),
    )(ask(token, "[photo] my washer is showing this"));
    const out = await res.json();
    expect(res.status).toBe(200);
    expect(out.reply).toBe(
      "The photo shows F21 on the Washer: F21 means something. Manual page 31.",
    );
    expect(out.tools_used).toEqual(["photo_check", "fast_lane"]);
    expect(out.fast).toMatchObject({ item_id: WASHER, type: "fact", id: "f-w-f21", page: 31 });
    expect(toMuse).toHaveLength(0);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ kind: "fast", ok: true, item_id: WASHER, tokens_in: 1800 });
    expect(logged[0].tools_used).toContain("display:answered F21 0.97 shown 0.96/0.93/0.90");
    // Every database read carried the person's own token (RLS), never a service key.
    expect(seen.auth.length).toBeGreaterThan(0);
    expect(seen.auth.every((a) => a === `Bearer ${token}`)).toBe(true);
  });

  test("a photo sent with no words is read too", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    const toMuse: any[] = [];
    const out = await (
      await chatHandler(
        env,
        verify,
        network({ "f-w-e4": 0.97, "f-w-f21": 0.03 }, toMuse, "i1"),
      )(ask(await mint(), "[photo]"))
    ).json();
    expect(out.tools_used).toEqual(["photo_check", "fast_lane"]);
    expect(toMuse).toHaveLength(0);
  });

  test("the same code on two things goes to Muse with the photo, as before", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    fakeSupabase(logged);
    const toMuse: any[] = [];
    const out = await (
      await chatHandler(
        env,
        verify,
        network({ "f-w-e4": 0.5, "f-d-e4": 0.48, "f-w-f21": 0.02 }, toMuse),
      )(ask(await mint(), "[photo] what does this mean?"))
    ).json();
    expect(out.reply).toBe("That code means the drain is blocked (p. 31).");
    expect(out.tools_used).not.toContain("fast_lane");
    expect(imageParts(toMuse[0])).toHaveLength(1);
    expect(logged[0].kind).toBe("chat");
    expect(logged[0].tools_used).toContain(
      "display:muse:same_code_elsewhere E4 0.98 shown 0.96/0.93/0.90",
    );
  });

  test("with the display read down, the photo goes to Muse as before", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    const toMuse: any[] = [];
    const out = await (
      await chatHandler(
        env,
        verify,
        network("down", toMuse),
      )(ask(await mint(), "[photo] what's this?"))
    ).json();
    expect(out.reply).toBe("That code means the drain is blocked (p. 31).");
    expect(imageParts(toMuse[0])).toHaveLength(1);
  });
});
