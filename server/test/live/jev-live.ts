// Live check of the Jev photo checks against the real TypeSafe service.
// Not part of `bun test`: it needs JEV_API_KEY and spends a few hundredths of
// a cent. Run it with `JEV_API_KEY=... bun run server/test/live/jev-live.ts`,
// or let the jev-live workflow run it with the repo secret.
//
// The checks fail open in the app (any error returns null), so this script
// first makes one raw call to surface the HTTP status, then runs each check on
// small fixture images and compares Jev's answers with what the photo shows.
// Each check runs through a fetch that remembers how its call went, so a null
// says why (an HTTP status, a timeout, a network error) instead of just
// "returned null". Now and then Jev answers a call with HTTP 503 "Image
// processing is unavailable." in about 12 ms, and a second later the same call
// works. So a null (or a 429/5xx on a raw call) is tried once more before it
// fails, and the RETRY line stays in the log. A wrong answer is never retried.
// It never prints the key or request headers.

import { readFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import { readEnv } from "../../src/env.js";
import { BOX_AT, checkPhoto, checkRead, DOUBT_BELOW, PRESENT_AT } from "../../src/photo-check.js";

const env = readEnv({
  ...process.env,
  SUPABASE_URL: process.env.SUPABASE_URL || "https://example-ref.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_live",
  PUBLIC_URL: process.env.PUBLIC_URL || "https://manuals.example.com",
});
const router = env.router;
if (!router) {
  console.error("JEV_API_KEY is not set, so there is nothing to test.");
  process.exit(1);
}

const fixture = (name: string) => ({
  mime: "image/jpeg",
  base64: readFileSync(new URL(`../fixtures/jev/${name}.jpg`, import.meta.url)).toString("base64"),
});
const label = fixture("label");
const receipt = fixture("receipt");
const noLabel = fixture("no-label");

let failed = 0;
const pass = (name: string, ok: boolean, detail: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
};
const round = (scores: Record<string, number>) =>
  Object.entries(scores)
    .map(([k, v]) => `${k}=${v.toFixed(3)}`)
    .join(" ");

/** How the last call through `watched` went, in words for the log. */
let lastCall = "no call made";
let retryAfter = 0;

/** fetch that records the status, time and start of the body of each call, or why it threw. */
const watched = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const started = Date.now();
  try {
    const res = await fetch(input, init);
    const body = (await res.clone().text()).slice(0, 200);
    lastCall = `HTTP ${res.status} in ${Date.now() - started} ms: ${body}`;
    retryAfter = Number(res.headers.get("retry-after")) || 0;
    return res;
  } catch (err) {
    const ms = Date.now() - started;
    const e = err as Error;
    lastCall =
      e.name === "TimeoutError"
        ? `timed out after ${ms} ms`
        : `${e.name} after ${ms} ms: ${e.message}`;
    retryAfter = 0;
    throw err;
  }
}) as typeof fetch;

/** Why the last check came back null, both tries. */
let nullWhy = "";

/** Runs a check through `watched`; a null gets one more try after a short wait. */
async function live<T>(call: (f: typeof fetch) => Promise<T | null>): Promise<T | null> {
  const first = await call(watched);
  if (first !== null) return first;
  const firstWhy = lastCall;
  const wait = Math.min(retryAfter * 1000 || 1_000, 10_000);
  console.log(`RETRY in ${wait} ms, the check returned null: ${firstWhy}`);
  await new Promise((r) => setTimeout(r, wait));
  const second = await call(watched);
  nullWhy = `returned null twice. 1st: ${firstWhy}. 2nd: ${lastCall}`;
  return second;
}

/**
 * One raw call, so a bad key, model or size shows as a status instead of a silent null.
 * A 429 or 5xx says nothing about the photo, so it gets one more try, like a null check.
 */
const ANY_TEXT = { any: { type: "noul", instructions: "Is there any text in `photo`?" } };

async function probe(
  image: { base64: string },
  format: "jpg" | "png",
  questions: Record<string, { type: string; instructions: string }> = ANY_TEXT,
) {
  const first = await probeOnce(image, format, questions);
  if (first.status !== 429 && first.status < 500) return first;
  console.log(`RETRY in 1000 ms, the raw call got HTTP ${first.status}: ${first.text}`);
  await new Promise((r) => setTimeout(r, 1_000));
  return probeOnce(image, format, questions);
}

async function probeOnce(
  image: { base64: string },
  format: "jpg" | "png",
  questions: Record<string, { type: string; instructions: string }>,
) {
  const started = Date.now();
  const res = await fetch(`${router?.baseUrl}/v1/systemone`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${router?.apiKey}`,
      "TypeSafe-Danger-Zone-Images": "true",
    },
    body: JSON.stringify({
      model: router?.model,
      state: { photo: "probe" },
      assets: { probe: { type: "image", format, data_base64: image.base64 } },
      questions,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  return { status: res.status, ms: Date.now() - started, text: text.slice(0, 300), full: text };
}

console.log(`Jev at ${router.baseUrl}, model ${router.model}`);

const first = await probe(label, "jpg");
pass(
  "raw call with the label photo",
  first.status === 200,
  `HTTP ${first.status} in ${first.ms} ms${first.status === 200 ? "" : `: ${first.text}`}`,
);
if (first.status !== 200) {
  console.log("Stopping: the service didn't accept the call, so every check would return null.");
  process.exit(1);
}

// The receipt shrink went from 1800 to 1568 px because Jev refuses larger sides.
const tall = createCanvas(600, 1800);
const g = tall.getContext("2d");
g.fillStyle = "#fafaf5";
g.fillRect(0, 0, 600, 1800);
const oversize = await probe({ base64: tall.toBuffer("image/png").toString("base64") }, "png");
console.log(`INFO  1800 px tall photo gets HTTP ${oversize.status} (the old receipt size)`);
const fits = await probe(receipt, "jpg");
pass(
  "1568 px tall receipt is accepted",
  fits.status === 200,
  `HTTP ${fits.status}${fits.status === 200 ? "" : `: ${fits.text}`}`,
);

const labelPhoto = await live((f) => checkPhoto(env, label, f));
pass(
  "checkPhoto keeps a clear label photo",
  labelPhoto?.retake === null,
  labelPhoto
    ? `label=${labelPhoto.label.toFixed(3)} sharp=${labelPhoto.sharp.toFixed(3)} ${labelPhoto.ms} ms`
    : nullWhy,
);

const empty = await live((f) => checkPhoto(env, noLabel, f));
pass(
  "checkPhoto asks for a retake of a photo with no label",
  empty?.retake === "no_label",
  empty ? `retake=${empty.retake} label=${empty.label.toFixed(3)}` : nullWhy,
);

const receiptPhoto = await live((f) => checkPhoto(env, receipt, f, "receipt"));
pass(
  "checkPhoto keeps a clear receipt photo",
  receiptPhoto?.retake === null,
  receiptPhoto
    ? `label=${receiptPhoto.label.toFixed(3)} sharp=${receiptPhoto.sharp.toFixed(3)}`
    : nullWhy,
);

const rightLabel = await live((f) =>
  checkRead(
    env,
    label,
    { brand: "Breville", model: "BES870XL", serial: "SN2491B7730" },
    "label",
    f,
  ),
);
pass(
  "checkRead trusts a correct label read",
  rightLabel !== null && rightLabel.doubtful.length === 0,
  rightLabel ? `${round(rightLabel.scores)} ${rightLabel.ms} ms` : nullWhy,
);

const wrongModel = await live((f) =>
  checkRead(
    env,
    label,
    { brand: "Breville", model: "BE5870XL", serial: "SN2491B7730" },
    "label",
    f,
  ),
);
pass(
  "checkRead doubts a model with S read as 5",
  wrongModel?.doubtful.includes("model") === true,
  wrongModel ? `${round(wrongModel.scores)} doubtful=[${wrongModel.doubtful}]` : nullWhy,
);

// Where the doubtful model is on the photo. Box is "dreamer-ready" with no
// recommended bar, so the boxes are printed to tune PRESENT_AT and BOX_AT, and
// only the raw call itself has to pass (the app fails open, so a refused Box
// call would otherwise just mean no crop, silently).
const boxCall = await probe(label, "jpg", {
  box_model: { type: "box", instructions: "the model number printed in `photo`" },
  present_model: { type: "noul", instructions: "Does `photo` clearly show the model number?" },
});
pass(
  "raw Box call with the label photo",
  boxCall.status === 200 && boxCall.full.includes('"box"'),
  `HTTP ${boxCall.status} in ${boxCall.ms} ms: ${boxCall.text}`,
);
console.log(
  `INFO  doubtful model located=${JSON.stringify(wrongModel?.located ?? null)} boxes=${JSON.stringify(wrongModel?.boxes ?? null)} (bars present ${PRESENT_AT}, box ${BOX_AT})`,
);

const rightReceipt = await live((f) =>
  checkRead(
    env,
    receipt,
    { store: "Home Depot", purchased_on: "2026-10-14", price: 89.97, warranty_months: 24 },
    "receipt",
    f,
  ),
);
pass(
  "checkRead trusts a correct receipt read",
  rightReceipt !== null && rightReceipt.doubtful.length === 0,
  rightReceipt ? `${round(rightReceipt.scores)} ${rightReceipt.ms} ms` : nullWhy,
);

const wrongReceipt = await live((f) =>
  checkRead(
    env,
    receipt,
    { store: "Home Depot", purchased_on: "2026-10-17", price: 98.97, warranty_months: 24 },
    "receipt",
    f,
  ),
);
pass(
  "checkRead doubts a wrong date and price",
  (wrongReceipt?.doubtful.includes("purchased_on") && wrongReceipt.doubtful.includes("price")) ===
    true,
  wrongReceipt ? `${round(wrongReceipt.scores)} doubtful=[${wrongReceipt.doubtful}]` : nullWhy,
);
console.log(
  `INFO  doubtful receipt located=${JSON.stringify(wrongReceipt?.located ?? null)} boxes=${JSON.stringify(wrongReceipt?.boxes ?? null)}`,
);

console.log(`\nDoubt bar ${DOUBT_BELOW}. ${failed ? `${failed} failed.` : "All passed."}`);
process.exit(failed ? 1 : 0);
