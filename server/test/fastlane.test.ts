import { afterEach, describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import {
  answerFrom,
  FAST_PER_MINUTE,
  hintFor,
  isCarSeat,
  quickAnswer,
  type Snapshot,
  type SnapshotItem,
  type SnapshotRow,
  suggestions,
} from "../src/fastlane.js";
import { chatHandler, suggestHandler } from "../src/http.js";
import { testAuth } from "./helpers.js";

const base = {
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
};
const env = readEnv({ ...base, JEV_API_KEY: "jev_test" });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const WASHER = "11111111-1111-1111-1111-111111111111";
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
  {
    id: SEAT,
    nickname: "Car seat",
    brand: "Graco",
    model: "4Ever",
    kind: "baby_gear",
    category: "car_seat",
  },
];
const fact = (over: Partial<SnapshotRow> = {}): SnapshotRow => ({
  type: "fact",
  id: "f-e4",
  item_id: WASHER,
  kind: "error_code",
  label: "E4",
  value: "Drain error: check the drain hose for kinks.",
  page: 31,
  status: "extracted",
  source: "reader",
  ...over,
});
const task: SnapshotRow = {
  type: "task",
  id: "t-filter",
  item_id: WASHER,
  kind: "task",
  label: "Clean the pump filter",
  value: "every month, next due 2026-11-05",
  page: 12,
  status: "extracted",
  source: "reader",
  next_due_on: "2026-11-05",
};
const seatFact = fact({
  id: "f-expiry",
  item_id: SEAT,
  kind: "spec",
  label: "Expires",
  value: "10 years after manufacture",
  page: 8,
});
const snapshot = (rows: SnapshotRow[] = [fact(), task, seatFact]): Snapshot => ({
  items,
  rows,
  loaded_at: Date.now(),
});

/** Jev's answers to the fast lane's questions; rows are r1, r2, ... in snapshot order. */
function jev(
  over: {
    row?: string;
    rowP?: number;
    exists?: number;
    judgment?: number;
    safety?: number;
    intent?: string;
    thing?: string;
    thingP?: number;
  } = {},
) {
  const row = over.row ?? "r1";
  const rowP = over.rowP ?? 0.92;
  return Response.json({
    model: "jev-1.14.0",
    answers: {
      row: {
        type: "choice",
        choice: row,
        confidence: rowP,
        probabilities: { [row === "r2" ? "r1" : "r2"]: (1 - rowP) / 2, [row]: rowP },
      },
      exists: { type: "noul", noul: over.exists ?? 0.91 },
      intent: { type: "choice", choice: over.intent ?? "ask", confidence: 0.95, probabilities: {} },
      thing: {
        type: "choice",
        choice: over.thing ?? "i1",
        confidence: over.thingP ?? 0.9,
        probabilities: {},
      },
      judgment: { type: "noul", noul: over.judgment ?? 0.08 },
      safety: { type: "noul", noul: over.safety ?? 0.03 },
    },
    usage: { input_tokens: 1800, output_tokens: 6 },
  });
}
const answering = (over: Parameters<typeof jev>[0] = {}) =>
  (async () => jev(over)) as unknown as typeof fetch;

describe("quickAnswer", () => {
  test("asks everything in one call, with the saved lines numbered", async () => {
    let sent: any;
    const lane = await quickAnswer(
      env,
      snapshot(),
      { message: "what does E4 mean on the washer" },
      (async (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.typesafe.ai/v1/systemone");
        sent = JSON.parse(String(init.body));
        return jev();
      }) as unknown as typeof fetch,
    );
    expect(Object.keys(sent.questions).sort()).toEqual(
      ["exists", "intent", "judgment", "remember", "row", "safety", "thing"].sort(),
    );
    expect(Object.keys(sent.questions.row.criteria)).toEqual(["r1", "r2", "r3"]);
    expect(sent.questions.thing.criteria).toHaveProperty("none");
    expect(sent.state.saved).toContain("r1| Washer · error code · E4: Drain error");
    expect(sent.state.saved).toContain("(p. 31)");
    expect(sent.state.things).toContain("i1| Washer (Whirlpool WTW5000DW1)");
    expect(lane?.route).toMatchObject({ route: "ask", confidence: 0.95 });
    expect(lane?.answer?.text).toBe(
      "E4 on the Washer: Drain error: check the drain hose for kinks. Manual page 31.",
    );
    expect(lane?.tokens_in).toBe(1800);
  });

  test("answers a due date from a task line", async () => {
    const lane = await quickAnswer(
      env,
      snapshot(),
      { message: "when is the washer filter due" },
      answering({ row: "r2" }),
    );
    expect(lane?.answer?.pick.row.id).toBe("t-filter");
    expect(answerFrom(task, items[0]!, "2026-11-01")).toBe(
      "Clean the pump filter (Washer): every month, next due in 4 days (2026-11-05). Manual page 12.",
    );
  });

  test("sends to Muse whatever is unsure, needs judgment, or is about safety", async () => {
    const cases: [Parameters<typeof jev>[0], string][] = [
      [{ rowP: 0.5 }, "unsure_line"],
      [{ exists: 0.4 }, "not_saved"],
      [{ judgment: 0.7 }, "needs_judgment"],
      [{ safety: 0.6 }, "safety"],
      [{ intent: "log" }, "not_a_question"],
      [{ thing: "i2" }, "thing_mismatch"],
    ];
    for (const [over, reason] of cases) {
      const lane = await quickAnswer(env, snapshot(), { message: "E4?" }, answering(over));
      expect(lane?.answer).toBeNull();
      expect(lane?.reason).toBe(reason);
    }
  });

  test("never answers a car seat line, a safety fact, an unchecked fact, or a photo", async () => {
    const seat = await quickAnswer(
      env,
      snapshot(),
      { message: "when does the seat expire" },
      answering({ row: "r3", thing: "i2" }),
    );
    expect(seat?.reason).toBe("safety");
    const hazard = await quickAnswer(
      env,
      snapshot([fact({ kind: "safety" })]),
      { message: "E4?" },
      answering(),
    );
    expect(hazard?.reason).toBe("safety");
    const review = await quickAnswer(
      env,
      snapshot([fact({ status: "needs_review" })]),
      { message: "E4?" },
      answering(),
    );
    expect(review?.reason).toBe("needs_review");
    const photo = await quickAnswer(env, snapshot(), { message: "E4?", image: true }, answering());
    expect(photo?.reason).toBe("photo");
  });

  test("a thing Jev names, even unsure, has to be the line's thing", async () => {
    const lane = await quickAnswer(
      env,
      snapshot(),
      { message: "E4 on the seat?" },
      answering({ thing: "i2", thingP: 0.5 }),
    );
    expect(lane?.answer).toBeNull();
    expect(lane?.reason).toBe("thing_mismatch");
    // Too unsure to name it in Muse's hint, though.
    expect(lane?.thing).toBeNull();
  });

  test("the same code saved on two things goes to Muse unless Jev knows which", async () => {
    const DRYER = "44444444-4444-4444-4444-444444444444";
    const two: Snapshot = {
      items: [
        ...items,
        {
          id: DRYER,
          nickname: "Dryer",
          brand: null,
          model: null,
          kind: "appliance",
          category: "dryer",
        },
      ],
      rows: [fact(), fact({ id: "f-dryer-e4", item_id: DRYER, value: "Lint screen blocked." })],
      loaded_at: Date.now(),
    };
    const vague = await quickAnswer(
      env,
      two,
      { message: "what does E4 mean" },
      answering({ thing: "none" }),
    );
    expect(vague?.answer).toBeNull();
    expect(vague?.reason).toBe("same_label_elsewhere");
    const named = await quickAnswer(
      env,
      two,
      { message: "what does E4 mean on the washer" },
      answering({ thing: "i1" }),
    );
    expect(named?.answer?.pick.row.id).toBe("f-e4");
  });

  test("a seat with limits saved is a car seat, whatever it's called", async () => {
    const seat = { ...items[0]!, nickname: "Maya's ride", category: null, car_seat: true };
    expect(isCarSeat(seat)).toBe(true);
    expect(isCarSeat(items[0]!)).toBe(false);
    const lane = await quickAnswer(
      env,
      { items: [seat], rows: [fact({ item_id: seat.id, kind: "spec" })], loaded_at: Date.now() },
      { message: "harness height?" },
      answering(),
    );
    expect(lane?.reason).toBe("safety");
  });

  test("fails open: no key, nothing saved, Jev down", async () => {
    expect(
      await quickAnswer(readEnv(base), snapshot(), { message: "E4?" }, answering()),
    ).toBeNull();
    expect(await quickAnswer(env, snapshot([]), { message: "E4?" }, answering())).toBeNull();
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    expect(await quickAnswer(env, snapshot(), { message: "E4?" }, down)).toBeNull();
  });

  test("keeps the 250 lines sharing the most words with a big household's question", async () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      fact({
        id: `f${i}`,
        label: `Code F${i}`,
        value: i === 377 ? "Lid lock fault" : "Something else",
      }),
    );
    let sent: any;
    await quickAnswer(env, snapshot(many), { message: "lid lock" }, (async (
      _u: string,
      init: RequestInit,
    ) => {
      sent = JSON.parse(String(init.body));
      return jev();
    }) as unknown as typeof fetch);
    expect(Object.keys(sent.questions.row.criteria)).toHaveLength(250);
    expect(sent.state.saved.split("\n")[0]).toContain("Lid lock fault");
  });

  test("type-ahead asks only which line and whether it's there", async () => {
    let sent: any;
    const lane = await quickAnswer(
      env,
      snapshot(),
      { message: "drain err", mode: "suggest" },
      (async (_u: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return jev({ rowP: 0.6 });
      }) as unknown as typeof fetch,
    );
    expect(Object.keys(sent.questions).sort()).toEqual(["exists", "row"]);
    expect(suggestions(lane)).toEqual([
      expect.objectContaining({ id: "f-e4", item: "Washer", label: "E4", page: 31, p: 0.6 }),
      expect.objectContaining({ id: "t-filter", text: "every month, next due 2026-11-05" }),
    ]);
    expect(suggestions(lane && { ...lane, scores: { ...lane.scores, exists: 0.1 } })).toEqual([]);
  });

  test("type-ahead marks a line nobody has checked yet", async () => {
    const lane = await quickAnswer(
      env,
      snapshot([fact({ status: "needs_review" })]),
      { message: "e4", mode: "suggest" },
      answering(),
    );
    expect(suggestions(lane)[0]).toMatchObject({ id: "f-e4", unchecked: true });
  });

  test("the hint names the thing and its likely lines for Muse", async () => {
    const lane = await quickAnswer(
      env,
      snapshot(),
      { message: "washer won't drain" },
      answering({ judgment: 0.8 }),
    );
    expect(lane && hintFor(lane)).toBe(
      `[jev hint: probably about Washer (Whirlpool WTW5000DW1), item id ${WASHER}. Saved lines that may answer it: Washer · error code · E4: Drain error: check the drain hose for kinks. (p. 31) [fact f-e4]]`,
    );
  });
});

/** Supabase stand-in: the household's lines, the model log, and today's counts. */
function fakeSupabase(logged: any[], counts = { chat: 0 }, seats: { item_id: string }[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/rpc/model_runs_today_all")) return Response.json(1);
    if (url.includes("/rest/v1/items")) return Response.json(items);
    if (url.includes("/rest/v1/manual_facts"))
      return Response.json([
        {
          id: "f-e4",
          item_id: WASHER,
          kind: "error_code",
          label: "E4",
          value: "Drain error",
          source_page: 31,
          source: "reader",
          status: "extracted",
        },
      ]);
    if (url.includes("/rest/v1/tasks")) return Response.json([]);
    if (url.includes("/rest/v1/seat_modes")) return Response.json(seats);
    if (url.includes("/rest/v1/model_runs")) {
      if (init?.method === "POST") {
        logged.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      }
      return new Response(null, { status: 200, headers: { "content-range": `*/${counts.chat}` } });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

function post(path: string, body: unknown, token: string) {
  return new Request(`https://manuals.example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("chat with the fast lane", () => {
  test("a saved answer comes back without Muse, logged as an instant answer", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    // Over the chat limit: instant answers still work.
    fakeSupabase(logged, { chat: 500 });
    let museAsked = false;
    const net = (async (url: string) => {
      if (url.includes("typesafe")) return jev();
      museAsked = true;
      return Response.json({});
    }) as unknown as typeof fetch;
    const res = await chatHandler(
      env,
      verify,
      net,
    )(
      post(
        "/api/chat",
        { messages: [{ role: "user", content: "What does E4 mean?" }] },
        await mint(),
      ),
    );
    const out = await res.json();
    expect(res.status).toBe(200);
    expect(out.reply).toBe("E4 on the Washer: Drain error. Manual page 31.");
    expect(out.tools_used).toEqual(["fast_lane"]);
    expect(out.fast).toMatchObject({ item_id: WASHER, type: "fact", id: "f-e4", page: 31 });
    expect(museAsked).toBe(false);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ kind: "fast", ok: true, item_id: WASHER, tokens_in: 1800 });
    expect(logged[0].tools_used[0]).toMatch(/^fast:answered line 0\.92 saved 0\.91$/);
  });

  test("anything else goes to Muse with the route and a hint, from the same single Jev call", async () => {
    const { verify, mint } = await testAuth();
    const logged: any[] = [];
    fakeSupabase(logged);
    let jevCalls = 0;
    let museSaw: any;
    const net = (async (url: string, init: RequestInit) => {
      if (url.includes("typesafe")) {
        jevCalls++;
        return jev({ judgment: 0.9 });
      }
      museSaw = JSON.parse(String(init.body));
      return Response.json({
        choices: [{ message: { content: "Check the drain hose (p. 31)." } }],
      });
    }) as unknown as typeof fetch;
    const res = await chatHandler(
      env,
      verify,
      net,
    )(
      post(
        "/api/chat",
        { messages: [{ role: "user", content: "The washer won't drain, what do I do?" }] },
        await mint(),
      ),
    );
    expect((await res.json()).reply).toBe("Check the drain hose (p. 31).");
    expect(jevCalls).toBe(1);
    const user = museSaw.messages.at(-1).content as string;
    expect(user).toStartWith(
      "The washer won't drain, what do I do?\n[jev hint: probably about Washer",
    );
    expect(museSaw.tools.map((t: any) => t.function.name)).toContain("ask_manual");
    expect(logged[0].kind).toBe("chat");
    expect(logged[0].tools_used).toContain("fast:muse:needs_judgment line 0.92 saved 0.91");
  });

  test("a thing whose seat limits are saved never gets an instant answer", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([], { chat: 0 }, [{ item_id: WASHER }]);
    const net = (async (url: string) =>
      url.includes("typesafe")
        ? jev()
        : Response.json({
            choices: [{ message: { content: "From the manual, p. 31." } }],
          })) as unknown as typeof fetch;
    const res = await chatHandler(
      env,
      verify,
      net,
    )(
      post(
        "/api/chat",
        { messages: [{ role: "user", content: "What does E4 mean?" }] },
        await mint(),
      ),
    );
    const out = await res.json();
    expect(out.tools_used).not.toContain("fast_lane");
    expect(out.reply).toBe("From the manual, p. 31.");
  });

  test("when Jev is down, the turn waits for it once, not twice", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    let jevCalls = 0;
    const net = (async (url: string) => {
      if (url.includes("typesafe")) {
        jevCalls++;
        throw new DOMException("The operation timed out.", "TimeoutError");
      }
      return Response.json({ choices: [{ message: { content: "Drain error (p. 31)." } }] });
    }) as unknown as typeof fetch;
    const res = await chatHandler(
      env,
      verify,
      net,
    )(
      post(
        "/api/chat",
        { messages: [{ role: "user", content: "What does E4 mean?" }] },
        await mint(),
      ),
    );
    expect((await res.json()).reply).toBe("Drain error (p. 31).");
    expect(jevCalls).toBe(1);
  });

  test("past the chat limit, instant answers are capped per minute too", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([], { chat: 500 });
    let jevCalls = 0;
    const net = (async (url: string) => {
      if (url.includes("typesafe")) {
        jevCalls++;
        return jev({ judgment: 0.9 });
      }
      return Response.json({});
    }) as unknown as typeof fetch;
    const handler = chatHandler(env, verify, net);
    const token = await mint();
    let last: Response | undefined;
    for (let i = 0; i <= FAST_PER_MINUTE; i++) {
      last = await handler(
        post("/api/chat", { messages: [{ role: "user", content: `E4 ${i}?` }] }, token),
      );
    }
    expect(last?.status).toBe(429);
    expect(jevCalls).toBe(FAST_PER_MINUTE);
  });

  test("Tell me more skips the fast lane", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    let jevCalls = 0;
    const net = (async (url: string) => {
      if (url.includes("typesafe")) {
        jevCalls++;
        return jev();
      }
      return Response.json({
        choices: [{ message: { content: "Page 31 also says to clean the filter." } }],
      });
    }) as unknown as typeof fetch;
    const res = await chatHandler(
      env,
      verify,
      net,
    )(
      post(
        "/api/chat",
        {
          messages: [
            { role: "user", content: "What does E4 mean?" },
            { role: "assistant", content: "E4 on the Washer: Drain error. Manual page 31." },
            { role: "user", content: "Tell me more." },
          ],
          via: "more",
        },
        await mint(),
      ),
    );
    expect((await res.json()).reply).toBe("Page 31 also says to clean the filter.");
    expect(jevCalls).toBe(0);
  });
});

describe("/api/suggest", () => {
  test("returns the saved lines that answer what's typed", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    const res = await suggestHandler(
      env,
      verify,
      answering({ rowP: 0.8 }),
    )(
      post(
        "/api/suggest",
        { q: "e4 mea" },
        await mint({ sub: "33333333-3333-3333-3333-333333333333" }),
      ),
    );
    const out = await res.json();
    expect(out.suggestions).toEqual([
      {
        id: "f-e4",
        type: "fact",
        item_id: WASHER,
        item: "Washer",
        label: "E4",
        text: "Drain error",
        page: 31,
        p: 0.8,
        unchecked: false,
      },
    ]);
  });

  test("answers nothing for short text, without Jev, or past the per-minute cap", async () => {
    const { verify, mint } = await testAuth();
    fakeSupabase([]);
    const token = await mint();
    const handler = suggestHandler(env, verify, answering());
    expect(
      (await (await handler(post("/api/suggest", { q: "e" }, token))).json()).suggestions,
    ).toEqual([]);
    const off = suggestHandler(readEnv(base), verify, answering());
    expect(
      (await (await off(post("/api/suggest", { q: "e4 mean" }, token))).json()).suggestions,
    ).toEqual([]);
    let last: any;
    for (let i = 0; i <= FAST_PER_MINUTE; i++) {
      last = await (await handler(post("/api/suggest", { q: `e4 ${i}` }, token))).json();
    }
    expect(last).toEqual({ suggestions: [], slow_down: true });
  });
});
