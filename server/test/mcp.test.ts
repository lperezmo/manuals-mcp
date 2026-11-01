import { afterEach, describe, expect, test } from "bun:test";
import { mcpHandler, resourceMetadataHandler } from "../src/http.js";
import { TOOL_MODULES } from "../src/mcp.js";
import { testAuth, testEnv } from "./helpers.js";

const MCP_URL = "https://manuals.example.com/mcp";

function rpc(body: unknown, token?: string) {
  return new Request(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Reads a JSON-RPC result from a JSON or single-event SSE response. */
async function result(res: Response): Promise<any> {
  const text = await res.text();
  const json = text.startsWith("event:")
    ? text
        .split("\n")
        .find((l) => l.startsWith("data: "))
        ?.slice(6)
    : text;
  return JSON.parse(json ?? "{}");
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("MCP endpoint", () => {
  test("asks for sign-in and points at the resource metadata", async () => {
    const { verify } = await testAuth();
    const res = await mcpHandler(
      testEnv,
      verify,
    )(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://manuals.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test("rejects tokens from another issuer", async () => {
    const { verify, mint } = await testAuth();
    const token = await mint({}, "https://evil.example.com/auth/v1");
    const res = await mcpHandler(
      testEnv,
      verify,
    )(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, token));
    expect(res.status).toBe(401);
  });

  test("lists every tool for a signed-in user", async () => {
    const { verify, mint } = await testAuth();
    const res = await mcpHandler(
      testEnv,
      verify,
    )(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, await mint({ client_id: "claude" })));
    expect(res.status).toBe(200);
    const names = (await result(res)).result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(
      [
        "add_item",
        "ask_manual",
        "car_seat_status",
        "catch_up",
        "house_atlas",
        "list_items",
        "log_done",
        "record_measurement",
        "revise_fact",
        "save_view",
        "upcoming",
        "warranty_status",
      ].sort(),
    );
    expect(names.length).toBe(TOOL_MODULES.length);
  });

  test("upcoming's description tells the AI it can use its own calendar", async () => {
    const { verify, mint } = await testAuth();
    const res = await mcpHandler(
      testEnv,
      verify,
    )(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, await mint()));
    const tool = (await result(res)).result.tools.find(
      (t: { name: string }) => t.name === "upcoming",
    );
    expect(tool.description).toContain("calendar");
  });

  test("tools query Supabase as the caller, with their own token", async () => {
    const { verify, mint } = await testAuth();
    const token = await mint({ client_id: "claude" });
    const seen: { url: string; auth: string | null }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      seen.push({ url, auth: headers.get("authorization") });
      if (url.includes("/rpc/ensure_household"))
        return Response.json("11111111-1111-1111-1111-111111111111");
      if (url.includes("/rest/v1/items")) {
        return Response.json([
          {
            id: "22222222-2222-2222-2222-222222222222",
            nickname: "Washer",
            kind: "appliance",
            category: "washer",
            brand: "Example",
            model: "W100",
            manuals: [],
            tasks: [{ title: "Run the tub clean cycle", next_due_on: "2026-11-01", active: true }],
          },
        ]);
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    const res = await mcpHandler(
      testEnv,
      verify,
    )(
      rpc(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "list_items", arguments: {} },
        },
        token,
      ),
    );
    const body = await result(res);
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toContain("Washer");
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.url.startsWith("https://example-ref.supabase.co/")).toBe(true);
      expect(call.auth).toBe(`Bearer ${token}`);
    }
  });
});

describe("protected resource metadata", () => {
  test("names Supabase Auth as the authorization server for /mcp", async () => {
    const res = resourceMetadataHandler(testEnv)(
      new Request("https://manuals.example.com/.well-known/oauth-protected-resource/mcp"),
    );
    const body = await res.json();
    expect(body.resource).toBe("https://manuals.example.com/mcp");
    expect(body.authorization_servers).toEqual(["https://example-ref.supabase.co/auth/v1"]);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
