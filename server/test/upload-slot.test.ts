import { afterEach, describe, expect, test } from "bun:test";
import { chatTools } from "../src/chat.js";
import { MAX_PDF_BYTES } from "../src/finder/fetch-pdf.js";
import { resolveUpload, UploadError, uploadPath } from "../src/finder/upload-slot.js";
import { mcpHandler } from "../src/http.js";
import { INSTRUCTIONS } from "../src/mcp.js";
import { testAuth, testEnv, tinyPdf } from "./helpers.js";

const HID = "11111111-1111-1111-1111-111111111111";
const OTHER_HID = "99999999-9999-9999-9999-999999999999";
const ITEM = {
  id: "22222222-2222-2222-2222-222222222222",
  household_id: HID,
  nickname: "Washer",
  kind: "appliance",
  category: "washer",
  brand: "Whirlpool",
  model: "WTW5000DW",
};
const MANUAL_ID = "33333333-3333-3333-3333-333333333333";
const SLOT = "44444444-4444-4444-4444-444444444444";
const SUPA = "https://example-ref.supabase.co";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Stored {
  bytes: Uint8Array;
  size?: number;
  created_at?: string;
}

/**
 * Just enough of Supabase (REST and Storage) for add_item and the upload slot.
 * Storage answers only for the caller's household folder, like the RLS policies.
 */
function fakeSupabase(objects: Map<string, Stored> = new Map()) {
  const calls: string[] = [];
  const removed: string[] = [];
  const signed: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(url.pathname);
    calls.push(`${method} ${path}`);
    if (path === "/rest/v1/rpc/ensure_household") return Response.json(HID);
    if (path === "/rest/v1/items") return Response.json([ITEM]);
    if (path === "/rest/v1/manuals" && method === "POST") return Response.json({ id: MANUAL_ID });
    if (path.startsWith("/rest/v1/")) return new Response(null, { status: 204 });

    const sign = "/storage/v1/object/upload/sign/manuals/";
    if (path.startsWith(sign) && method === "POST") {
      const name = path.slice(sign.length);
      signed.push(name);
      return Response.json({ url: `/object/upload/sign/manuals/${name}?token=signed-token` });
    }
    if (path === "/storage/v1/object/list/manuals" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { prefix: string; search?: string };
      if (!body.prefix.startsWith(`${HID}/`)) return Response.json([]);
      const rows = [...objects]
        .filter(([key]) => key.startsWith(`${body.prefix}/`))
        .map(([key, o]) => ({
          name: key.slice(body.prefix.length + 1),
          created_at: o.created_at ?? new Date().toISOString(),
          metadata: { size: o.size ?? o.bytes.byteLength, mimetype: "application/pdf" },
        }))
        .filter((r) => !body.search || r.name.startsWith(body.search));
      return Response.json(rows);
    }
    if (path === "/storage/v1/object/manuals" && method === "DELETE") {
      const body = JSON.parse(String(init?.body)) as { prefixes: string[] };
      for (const p of body.prefixes) {
        removed.push(p);
        objects.delete(p);
      }
      return Response.json([]);
    }
    const object = "/storage/v1/object/manuals/";
    if (path.startsWith(object)) {
      const name = path.slice(object.length);
      if (method === "GET") {
        const o = objects.get(name);
        if (!o || !name.startsWith(`${HID}/`))
          return Response.json(
            { statusCode: "404", error: "not_found", message: "Object not found" },
            { status: 400 },
          );
        return new Response(o.bytes as Uint8Array<ArrayBuffer>);
      }
      if (method === "POST") return Response.json({ Key: `manuals/${name}` });
    }
    return new Response(`unexpected ${method} ${path}`, { status: 500 });
  }) as typeof fetch;
  return { calls, removed, signed, objects };
}

function rpc(name: string, args: Record<string, unknown>, token: string) {
  return new Request("https://manuals.example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

async function call(name: string, args: Record<string, unknown>) {
  const { verify, mint } = await testAuth();
  const res = await mcpHandler(testEnv, verify)(rpc(name, args, await mint()));
  const text = await res.text();
  const json = text.startsWith("event:")
    ? text
        .split("\n")
        .find((l) => l.startsWith("data: "))
        ?.slice(6)
    : text;
  const body = JSON.parse(json ?? "{}");
  return body.result as { isError?: boolean; content: { text: string }[] };
}

const slotPath = uploadPath(HID, SLOT);

describe("request_manual_upload", () => {
  test("signs an upload URL in the household's uploads folder and says what to do with it", async () => {
    const fake = fakeSupabase();
    const result = await call("request_manual_upload", { item: "washer" });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? "";
    expect(fake.signed).toHaveLength(1);
    expect(fake.signed[0]).toMatch(new RegExp(`^${HID}/uploads/[0-9a-f-]{36}\\.pdf$`));
    const data = JSON.parse(text.slice(text.indexOf("\n\n") + 2));
    expect(data.upload_url).toStartWith(
      `${SUPA}/storage/v1/object/upload/sign/manuals/${HID}/uploads/`,
    );
    expect(data.upload_url).toContain("token=signed-token");
    expect(data.method).toBe("PUT");
    expect(data.headers).toEqual({ "content-type": "application/pdf" });
    expect(data.max_bytes).toBe(MAX_PDF_BYTES);
    expect(data.path).toBe(fake.signed[0]);
    expect(Date.parse(data.expires_at) - Date.now()).toBeGreaterThan(115 * 60_000);
    expect(data.next_call).toEqual({
      tool: "add_item",
      arguments: { attach_to: ITEM.id, upload_id: data.upload_id },
    });
    expect(data.page_url).toBe(`https://manuals.example.com/things?id=${ITEM.id}`);
    expect(text).toContain("Don't paste the file into the chat");
    expect(text).toContain("Upload a PDF");
  });

  test("clears uploads nobody attached for a day, and keeps fresh ones", async () => {
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const objects = new Map<string, Stored>([
      [
        uploadPath(HID, "55555555-5555-5555-5555-555555555555"),
        { bytes: tinyPdf(["a"]), created_at: old },
      ],
      [slotPath, { bytes: tinyPdf(["b"]) }],
    ]);
    const fake = fakeSupabase(objects);
    await call("request_manual_upload", { item: ITEM.id });
    expect(fake.removed).toEqual([uploadPath(HID, "55555555-5555-5555-5555-555555555555")]);
    expect(objects.has(slotPath)).toBe(true);
  });

  test("its description tells the AI to send bytes, not paste the file, and the fallback", async () => {
    const { DESCRIPTION } = await import("../src/tools/request-upload.js");
    expect(DESCRIPTION).toContain("PUT");
    expect(DESCRIPTION).toContain("content-type: application/pdf");
    expect(DESCRIPTION).toContain("Never paste the file");
    expect(DESCRIPTION).toContain("add_item with attach_to");
    expect(DESCRIPTION).toContain("Upload a PDF");
    expect(DESCRIPTION).not.toContain("—");
  });

  test("is offered over MCP but not in the website's chat, which can't download files", () => {
    expect(chatTools(testEnv).map((t) => t.name)).not.toContain("request_manual_upload");
    expect(INSTRUCTIONS).toContain("request_manual_upload");
  });
});

describe("add_item with upload_id", () => {
  test("reads an uploaded PDF like an uploaded manual and frees the slot", async () => {
    const objects = new Map<string, Stored>([
      [slotPath, { bytes: tinyPdf(["Clean the filter monthly."]) }],
    ]);
    const fake = fakeSupabase(objects);
    const result = await call("add_item", { attach_to: "washer", upload_id: SLOT });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("Attached a 1-page manual to Washer");
    // Stored where the page's own uploads go, under the household folder.
    expect(fake.calls).toContain(`POST /storage/v1/object/manuals/${HID}/${MANUAL_ID}.pdf`);
    expect(fake.calls.some((c) => c.startsWith("POST /rest/v1/manual_pages"))).toBe(true);
    expect(fake.removed).toEqual([slotPath]);
  });

  test("records it as an upload, with pdf_url only as where it came from", async () => {
    const objects = new Map<string, Stored>([[slotPath, { bytes: tinyPdf(["x"]) }]]);
    const bodies: unknown[] = [];
    fakeSupabase(objects);
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/rest/v1/manuals?select=id") && init?.method === "POST")
        bodies.push(JSON.parse(String(init.body)));
      return inner(input, init);
    }) as typeof fetch;
    const result = await call("add_item", {
      attach_to: ITEM.id,
      upload_id: slotPath,
      pdf_url: "https://www.whirlpool.com/owners-manual.pdf",
      official: true,
    });
    expect(result.isError).toBeFalsy();
    expect(bodies[0]).toMatchObject({
      source: "pdf_upload",
      source_url: "https://www.whirlpool.com/owners-manual.pdf",
      official: true,
    });
  });

  test("refuses an upload path in another household without asking storage", async () => {
    const fake = fakeSupabase();
    const result = await call("add_item", {
      attach_to: ITEM.id,
      upload_id: uploadPath(OTHER_HID, SLOT),
    });
    expect(result.content[0]?.text).toContain("isn't in your household");
    expect(fake.calls.some((c) => c.includes("/storage/"))).toBe(false);
    expect(fake.calls.some((c) => c.startsWith("POST /rest/v1/manuals"))).toBe(false);
  });

  test.each([
    "../11111111-1111-1111-1111-111111111111/x.pdf",
    `${HID}/55555555-5555-5555-5555-555555555555.pdf`,
    `${HID}/uploads/../secret.pdf`,
    "not-an-id",
  ])("refuses an upload_id that isn't a slot: %s", (ref) => {
    expect(() => resolveUpload(HID, ref)).toThrow(UploadError);
  });

  test("says nothing was uploaded yet when the slot is empty", async () => {
    const fake = fakeSupabase();
    const result = await call("add_item", { attach_to: ITEM.id, upload_id: SLOT });
    expect(result.content[0]?.text).toContain("Nothing has been uploaded to that slot yet");
    expect(fake.calls.some((c) => c.startsWith("POST /rest/v1/manuals"))).toBe(false);
  });

  test("refuses a file that isn't a PDF and removes it", async () => {
    const objects = new Map<string, Stored>([
      [slotPath, { bytes: new TextEncoder().encode("JVBERi0xLjQK base64 of a pdf") }],
    ]);
    const fake = fakeSupabase(objects);
    const result = await call("add_item", { attach_to: ITEM.id, upload_id: SLOT });
    expect(result.content[0]?.text).toContain("isn't a PDF");
    expect(fake.removed).toEqual([slotPath]);
    expect(fake.calls.some((c) => c.startsWith("POST /rest/v1/manuals"))).toBe(false);
  });

  test("refuses a file over 40 MB without downloading it", async () => {
    const objects = new Map<string, Stored>([
      [slotPath, { bytes: tinyPdf(["x"]), size: MAX_PDF_BYTES + 1 }],
    ]);
    const fake = fakeSupabase(objects);
    const result = await call("add_item", { attach_to: ITEM.id, upload_id: SLOT });
    expect(result.content[0]?.text).toContain("too big");
    expect(fake.calls).not.toContain(`GET /storage/v1/object/manuals/${slotPath}`);
    expect(fake.removed).toEqual([slotPath]);
  });
});

describe("add_item when the maker's site blocks our server", () => {
  test("points the AI at request_manual_upload first, then the page", async () => {
    const fake = fakeSupabase();
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).includes("whirlpool.com"))
        return new Response("Access Denied", { status: 403 });
      return inner(input, init);
    }) as typeof fetch;
    const result = await call("add_item", {
      attach_to: ITEM.id,
      pdf_url: "https://www.whirlpool.com/content/dam/owners-manual.pdf",
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("whirlpool.com won't let apps download its manuals.");
    expect(text).toContain(`call request_manual_upload with item "${ITEM.id}"`);
    expect(text.indexOf("request_manual_upload")).toBeLessThan(text.indexOf("another site"));
    expect(text).toContain(`https://manuals.example.com/things?id=${ITEM.id}`);
    expect(fake.calls.some((c) => c.includes("/storage/"))).toBe(false);
  });

  test("the website's chat keeps pointing at the Things page, not a tool it doesn't have", async () => {
    const { blockedNext } = await import("../src/tools/add-item.js");
    const chat = blockedNext("chat", ITEM.id, "https://x/things");
    expect(chat).not.toContain("request_manual_upload");
    expect(chat).toContain("Things page");
  });
});
