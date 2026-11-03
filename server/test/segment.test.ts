import { describe, expect, test } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { readEnv } from "../src/env.js";
import { boxPrompt, outlinePart, partOf } from "../src/segment.js";

const env = readEnv({
  SUPABASE_URL: "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  META_READER_API_KEY: "meta_test",
  META_READER_BASE_URL: "https://api.meta.example/v1",
  JEV_API_KEY: "jev_test",
  JEV_BASE_URL: "https://jev.example.com",
});

// One real SAM 3.1 record (from @meta-sam/parser's docs): a 27 x 60 mask at 211, 228.
const SAM_TEXT =
  "<0f>0<|box;x1=211;y1=228;x2=270;y2=254;w=320;h=334;c=0.93|>" +
  "<|mask;x=0;y=0;c=0.93;data=27,60,~!!!!M!0c[0o91w?q1!pIH4pPRVp2B3'7`e.ioeAf6-k/#Xd8%dX9x(|>\n";

async function photo(w = 320, h = 334) {
  const c = createCanvas(w, h);
  const g = c.getContext("2d");
  g.fillStyle = "#888";
  g.fillRect(0, 0, w, h);
  return { mime: "image/jpeg", base64: (await c.encode("jpeg", 90)).toString("base64") };
}

function fake(jev: object | number, samText: string) {
  const seen: { url: string; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push({ url, body });
    if (url.includes("jev.example.com")) {
      return typeof jev === "number" ? new Response("down", { status: jev }) : Response.json(jev);
    }
    return Response.json({ output: [{ content: [{ type: "output_text", text: samText }] }] });
  }) as unknown as typeof fetch;
  return { f, seen };
}

const jevSure = {
  answers: {
    box: { box: { left: 0.6, top: 0.65, right: 0.86, bottom: 0.78 }, confidence: 0.72 },
    present: { noul: 0.9 },
  },
};

describe("outlining a part with Jev and SAM", () => {
  test("Muse's instruction becomes a description Jev can box", () => {
    expect(partOf("Circle the round gray cup in the middle of the mesh.")).toBe(
      "the round gray cup in the middle of the mesh",
    );
    expect(partOf("Point out the drain pump")).toBe("the drain pump");
    expect(partOf("the spray arm")).toBe("the spray arm");
  });

  test("the box prompt is in source pixels with inclusive right and bottom edges", () => {
    expect(boxPrompt({ left: 704.4, top: 442, right: 934, bottom: 614.2 }, 1280, 960)).toBe(
      "<0f>0<|box;x1=704;y1=442;x2=933;y2=614;w=1280;h=960|>",
    );
    expect(boxPrompt({ left: -3, top: 0, right: 2000, bottom: 960 }, 1280, 960)).toBe(
      "<0f>0<|box;x1=0;y1=0;x2=1279;y2=959;w=1280;h=960|>",
    );
  });

  test("Jev boxes it, SAM traces it, and the outline comes back on the photo", async () => {
    const { f, seen } = fake(jevSure, SAM_TEXT);
    const out = await outlinePart(env, await photo(), "Circle the round gray cup", f);
    expect(out?.model).toBe("sam-3.1");
    expect(out?.image).toStartWith("data:image/jpeg;base64,");
    expect(seen[0]?.url).toBe("https://jev.example.com/v1/systemone");
    expect(seen[0]?.body.questions.box.instructions).toBe("the round gray cup, in `photo`");
    expect(seen[1]?.url).toBe("https://api.meta.example/v1/responses");
    expect(seen[1]?.body.model).toBe("sam-3.1");
    const [text, img] = seen[1]?.body.input[0].content ?? [];
    expect(text.text).toBe("<0f>0<|box;x1=192;y1=217;x2=275;y2=260;w=320;h=334|>");
    expect(img.image_url).toStartWith("data:image/jpeg;base64,");
  });

  test("Jev unsure the part is there: no SAM call, the caller falls back", async () => {
    const { f, seen } = fake({ answers: { ...jevSure.answers, present: { noul: 0.2 } } }, SAM_TEXT);
    expect(await outlinePart(env, await photo(), "Circle the cup", f)).toBeNull();
    expect(seen).toHaveLength(1);
  });

  test("Jev down: falls back without asking SAM", async () => {
    const { f, seen } = fake(500, SAM_TEXT);
    expect(await outlinePart(env, await photo(), "Circle the cup", f)).toBeNull();
    expect(seen).toHaveLength(1);
  });

  test("SAM finds nothing in the box: falls back", async () => {
    const { f } = fake(jevSure, "");
    expect(await outlinePart(env, await photo(), "Circle the cup", f)).toBeNull();
  });

  test("SAM unsure of its outline: falls back", async () => {
    const { f } = fake(jevSure, SAM_TEXT.replaceAll("c=0.93", "c=0.2"));
    expect(await outlinePart(env, await photo(), "Circle the cup", f)).toBeNull();
  });

  test("no Jev configured: not tried at all", async () => {
    const noJev = readEnv({
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "x",
      META_READER_API_KEY: "meta_test",
    });
    const { f, seen } = fake(jevSure, SAM_TEXT);
    expect(await outlinePart(noJev, await photo(), "Circle the cup", f)).toBeNull();
    expect(seen).toHaveLength(0);
  });
});
