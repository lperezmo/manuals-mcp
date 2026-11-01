import { afterEach, describe, expect, test } from "bun:test";
import { readEnv } from "../src/env.js";
import { mcpHandler } from "../src/http.js";
import { testAuth } from "./helpers.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  PUBLIC_URL: "https://manuals.example.com",
  JEV_API_KEY: "jev_test",
});

const MANUAL = "33333333-3333-3333-3333-333333333333";
const PAGE_TEXT = [
  "Troubleshooting",
  "E4 Drain error. Check the drain hose for kinks and clean the pump filter.",
  "E5 Door lock error. Close the door firmly and restart the cycle.",
].join("\n");

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Supabase and Jev stand-ins: the search finds page 31 unless `hits` is empty. */
function backend(opts: { jev: () => Response; hits?: unknown[] }) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes("/rpc/ensure_household"))
      return Response.json("11111111-1111-1111-1111-111111111111");
    if (url.includes("/rpc/search_manual_pages"))
      return Response.json(
        opts.hits ?? [
          {
            manual_id: MANUAL,
            item_id: "i1",
            item_name: "Washer",
            page_number: 31,
            snippet: "**E4** Drain error. Check the drain hose",
            rank: 0.5,
          },
        ],
      );
    if (url.includes("/rest/v1/manual_pages"))
      return Response.json([{ manual_id: MANUAL, page_number: 31, content: PAGE_TEXT }]);
    if (url.includes("/v1/systemone")) return opts.jev();
    // Items, facts, tasks, seats: an empty household, so the fast lane has nothing to pick.
    if (url.includes("/rest/v1/")) return Response.json([]);
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return calls;
}

async function ask(args: Record<string, unknown>) {
  const { verify, mint } = await testAuth();
  const res = await mcpHandler(
    env,
    verify,
  )(
    new Request("https://manuals.example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${await mint({ client_id: "claude" })}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ask_manual", arguments: args },
      }),
    }),
  );
  const text = await res.text();
  const json = text.startsWith("event:")
    ? text
        .split("\n")
        .find((l) => l.startsWith("data: "))
        ?.slice(6)
    : text;
  return JSON.parse(json ?? "{}").result.content[0].text as string;
}

describe("ask_manual's line finder", () => {
  test("quotes the exact line with its page when Jev is sure", async () => {
    backend({
      jev: () =>
        Response.json({
          answers: {
            line: { choice: "L001", confidence: 0.9, probabilities: { L001: 0.9 } },
            exists: { noul: 0.86 },
          },
        }),
    });
    const text = await ask({ query: "E4", question: "What does E4 mean on the washer?" });
    expect(text).toContain("the line in the manual that answers it");
    expect(text).toContain('"answer_line"');
    expect(text).toContain("E4 Drain error. Check the drain hose");
    expect(text).toContain('"page": 31');
    expect(text).toContain('"passages"');
  });

  test("says the manual doesn't cover it when no line answers", async () => {
    backend({
      jev: () =>
        Response.json({
          answers: { line: { choice: "L001", confidence: 0.2 }, exists: { noul: 0.1 } },
        }),
    });
    const text = await ask({ query: "comforter", question: "Can I wash a down comforter?" });
    expect(text).toContain("The manual doesn't seem to cover this");
    expect(text).toContain('"covered": false');
    expect(text).toContain('"searched"');
    expect(text).not.toContain('"passages"');
  });

  test("returns the pages as before in the middle band", async () => {
    backend({
      jev: () =>
        Response.json({
          answers: { line: { choice: "L002", confidence: 0.5 }, exists: { noul: 0.55 } },
        }),
    });
    const text = await ask({ query: "drain", question: "Why won't it drain?" });
    expect(text).toContain("Here's what the manuals say");
    expect(text).toContain('"passages"');
    expect(text).not.toContain("answer_line");
    expect(text).not.toContain("covered");
  });

  test("returns the pages as before when Jev is down", async () => {
    backend({ jev: () => new Response("down", { status: 503 }) });
    const text = await ask({ query: "E4", question: "What does E4 mean?" });
    expect(text).toContain("Here's what the manuals say");
    expect(text).toContain('"passages"');
    expect(text).not.toContain("covered");
  });

  test("never says not covered when no pages were searched", async () => {
    const calls = backend({
      jev: () => Response.json({ answers: { exists: { noul: 0.01 } } }),
      hits: [],
    });
    const text = await ask({ query: "comforter", question: "Can I wash a down comforter?" });
    expect(text).toContain("Nothing in the saved manuals matches");
    expect(text).not.toContain("covered");
    expect(calls.some((u) => u.includes("/v1/systemone"))).toBe(false);
  });
});
