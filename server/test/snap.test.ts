import { afterEach, describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { snapHandler } from "../src/http.js";
import { labelSchema, modelGuess, radioSticker, splitCode } from "../src/snap.js";
import midea from "./fixtures/labels/midea-wifi-sticker.json" with { type: "json" };
import { testAuth } from "./helpers.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  READER_BASE_URL: "https://muse.example.com/v1",
  READER_MODEL: "muse-spark",
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("a label with no Model line", () => {
  test("splits a tagged code into tag and value", () => {
    expect(splitCode("MO:R0698201")).toEqual(["MO", "R0698201"]);
    expect(splitCode("CONTAINS FCC ID: 2ADQOMDNA23")).toEqual(["CONTAINS FCC ID", "2ADQOMDNA23"]);
    expect(splitCode("Scan QR code for more information")).toBeNull();
  });

  test("offers MO: as the likely model on the Midea Wi-Fi sticker", () => {
    const codes = midea.text.filter((line) => splitCode(line));
    expect(modelGuess(codes)).toBe("R0698201");
    expect(radioSticker(codes)).toBe(true);
  });

  test("never offers an FCC, IC or serial code as the model", () => {
    expect(
      modelGuess(["FCC ID: 2ADQOMDNA23", "IC: 12575A-MDNA23", "S/N:541206000ADA1280640712"]),
    ).toBeNull();
    expect(modelGuess(null)).toBeNull();
  });

  test("prefers a code tagged Model, and skips values that aren't one word with a digit", () => {
    expect(modelGuess(["MO: R0698201", "Model No.: WDF330PAHS5"])).toBe("WDF330PAHS5");
    expect(modelGuess(["Type: Dishwasher", "M/N: MDF24P3AST"])).toBe("MDF24P3AST");
    expect(modelGuess(["MO: SEE INSIDE DOOR"])).toBeNull();
    expect(modelGuess(["Model #: ABC1234"])).toBe("ABC1234");
    expect(modelGuess(["MO#R0698201"])).toBe("R0698201");
  });

  test("a reader reply with odd codes still parses", () => {
    expect(labelSchema.parse({ ...midea.production_read, codes: "MO:R0698201" }).codes).toBeNull();
  });
});

function usage(logged: any[]) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/rpc/model_runs_today_all")) return Response.json(0);
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

const reader = (reply: unknown) =>
  (async () =>
    Response.json({
      choices: [{ message: { content: JSON.stringify(reply) } }],
    })) as unknown as typeof fetch;

async function snap(reply: unknown, logged: any[] = []) {
  const { verify, mint } = await testAuth();
  usage(logged);
  const res = await snapHandler(
    env,
    verify,
    reader(reply),
  )(
    new Request("https://manuals.example.com/api/snap", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await mint()}` },
      body: JSON.stringify({ image: "data:image/jpeg;base64,AAAA" }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("/api/snap on a Wi-Fi sticker", () => {
  test("asks about MO: and drops the fridge guess", async () => {
    const logged: any[] = [];
    const out = await snap(midea.read_with_codes, logged);
    expect(out).toMatchObject({
      found: true,
      brand: "Midea",
      model: null,
      model_guess: "R0698201",
      radio: true,
      category: null,
      kind: null,
      nickname: null,
    });
    // The read is logged even without Jev, so the next miss can be traced.
    expect(JSON.parse(logged[0].raw_output).codes).toContain("MO:R0698201");
  });

  test("a rating plate with a model and an FCC ID keeps its category", async () => {
    const out = await snap({
      found: true,
      brand: "Midea",
      model: "MDF24P3AST",
      category: "dishwasher",
      kind: "appliance",
      nickname: "Dishwasher",
      codes: ["FCC ID: 2ADQOMDNA23", "MO: R0698201"],
    });
    expect(out).toMatchObject({ model: "MDF24P3AST", category: "dishwasher" });
    expect(out.model_guess).toBeUndefined();
    expect(out.radio).toBeUndefined();
  });
});
