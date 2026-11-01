// Live check of the Jev photo checks against the real TypeSafe service.
// Not part of `bun test`: it needs JEV_API_KEY and spends a few hundredths of
// a cent. Run it with `JEV_API_KEY=... bun run server/test/live/jev-live.ts`,
// or let the jev-live workflow run it with the repo secret.
//
// The checks fail open in the app (any error returns null), so this script
// first makes one raw call to surface the HTTP status, then runs each check on
// small fixture images and compares Jev's answers with what the photo shows.
// It never prints the key or request headers.

import { readFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import { readEnv } from "../../src/env.js";
import { checkPhoto, checkRead, DOUBT_BELOW } from "../../src/photo-check.js";

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

/** One raw call, so a bad key, model or size shows as a status instead of a silent null. */
async function probe(image: { base64: string }, format: "jpg" | "png") {
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
      questions: { any: { type: "noul", instructions: "Is there any text in `photo`?" } },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  return { status: res.status, ms: Date.now() - started, text: text.slice(0, 300) };
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
pass("1568 px tall receipt is accepted", fits.status === 200, `HTTP ${fits.status}`);

const labelPhoto = await checkPhoto(env, label);
pass(
  "checkPhoto keeps a clear label photo",
  labelPhoto?.retake === null,
  labelPhoto
    ? `label=${labelPhoto.label.toFixed(3)} sharp=${labelPhoto.sharp.toFixed(3)} ${labelPhoto.ms} ms`
    : "returned null",
);

const empty = await checkPhoto(env, noLabel);
pass(
  "checkPhoto asks for a retake of a photo with no label",
  empty?.retake === "no_label",
  empty ? `retake=${empty.retake} label=${empty.label.toFixed(3)}` : "returned null",
);

const receiptPhoto = await checkPhoto(env, receipt, fetch, "receipt");
pass(
  "checkPhoto keeps a clear receipt photo",
  receiptPhoto?.retake === null,
  receiptPhoto
    ? `label=${receiptPhoto.label.toFixed(3)} sharp=${receiptPhoto.sharp.toFixed(3)}`
    : "returned null",
);

const rightLabel = await checkRead(env, label, {
  brand: "Breville",
  model: "BES870XL",
  serial: "SN2491B7730",
});
pass(
  "checkRead trusts a correct label read",
  rightLabel !== null && rightLabel.doubtful.length === 0,
  rightLabel ? `${round(rightLabel.scores)} ${rightLabel.ms} ms` : "returned null",
);

const wrongModel = await checkRead(env, label, {
  brand: "Breville",
  model: "BE5870XL",
  serial: "SN2491B7730",
});
pass(
  "checkRead doubts a model with S read as 5",
  wrongModel?.doubtful.includes("model") === true,
  wrongModel ? `${round(wrongModel.scores)} doubtful=[${wrongModel.doubtful}]` : "returned null",
);

const rightReceipt = await checkRead(
  env,
  receipt,
  { store: "Home Depot", purchased_on: "2026-10-14", price: 89.97, warranty_months: 24 },
  "receipt",
);
pass(
  "checkRead trusts a correct receipt read",
  rightReceipt !== null && rightReceipt.doubtful.length === 0,
  rightReceipt ? `${round(rightReceipt.scores)} ${rightReceipt.ms} ms` : "returned null",
);

const wrongReceipt = await checkRead(
  env,
  receipt,
  { store: "Home Depot", purchased_on: "2026-10-17", price: 98.97, warranty_months: 24 },
  "receipt",
);
pass(
  "checkRead doubts a wrong date and price",
  (wrongReceipt?.doubtful.includes("purchased_on") && wrongReceipt.doubtful.includes("price")) ===
    true,
  wrongReceipt
    ? `${round(wrongReceipt.scores)} doubtful=[${wrongReceipt.doubtful}]`
    : "returned null",
);

console.log(`\nDoubt bar ${DOUBT_BELOW}. ${failed ? `${failed} failed.` : "All passed."}`);
process.exit(failed ? 1 : 0);
