import { describe, expect, test } from "bun:test";

// The page's own module (plain JS, served as /jobs.js).
const jobs = (await import(String(new URL("../public/jobs.js", import.meta.url)))) as {
  JOB_MAX_MS: number;
  readVerdict: (
    manual: Record<string, unknown> | null,
    job: { since: string; label: string },
    now?: number,
    downloadError?: string | null,
  ) => { text: string } | null;
  withTimeout: <T>(work: Promise<T>, ms?: number) => Promise<T>;
};
const { JOB_MAX_MS, readVerdict, withTimeout } = jobs;

const NOW = Date.parse("2026-11-01T16:20:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const job = (since: number) => ({ since: ago(since), label: "Dishwasher" });

describe("when the reading pill goes away", () => {
  test("a read still going keeps the pill", () => {
    expect(readVerdict({ status: "pending", reading_since: ago(60_000) }, job(70_000), NOW)).toBe(
      null,
    );
    expect(readVerdict(null, job(30_000), NOW)).toBe(null);
  });

  test("a finished read says so", () => {
    expect(readVerdict({ status: "distilled", reading_since: null }, job(90_000), NOW)?.text).toBe(
      "Muse finished reading the Dishwasher manual.",
    );
  });

  test("a read that gave up shows its own sentence", () => {
    const note = "Muse ran out of time on this one. Tap Read it again to try once more.";
    expect(
      readVerdict({ status: "text_ready", status_detail: note, reading_since: null }, job(1), NOW)
        ?.text,
    ).toBe(note);
  });

  test("a read whose function was cut off stops showing as running", () => {
    // The lock was never let go: it is older than any read can run.
    const dead = { status: "pending", reading_since: ago(JOB_MAX_MS + 1_000) };
    expect(readVerdict(dead, job(20_000), NOW)?.text).toContain("couldn't finish");
    // Nothing ever changed on the manual, and the wait is over.
    expect(readVerdict(null, job(JOB_MAX_MS + 1_000), NOW)?.text).toContain("Read it again");
    // Twenty minutes in, whatever the row says, the pill is gone.
    expect(
      readVerdict({ status: "pending", reading_since: ago(1_000) }, job(20 * 60_000), NOW)?.text,
    ).toContain("couldn't finish");
  });

  test("a read that ended without a note still ends", () => {
    expect(
      readVerdict({ status: "text_ready", status_detail: null, reading_since: null }, job(1), NOW)
        ?.text,
    ).toBe("Muse couldn't finish the Dishwasher manual. Open it and tap Read it again.");
  });

  test("a download the site refused ends the pill with the server's sentence", () => {
    const why =
      "Whirlpool's site won't let apps download its manuals. Tap Open, save the PDF on your phone, then add it with Upload a PDF.";
    expect(readVerdict(null, job(5_000), NOW, why)?.text).toBe(why);
    // A manual that did arrive speaks for itself.
    expect(
      readVerdict({ status: "distilled", reading_since: null }, job(5_000), NOW, why)?.text,
    ).toBe("Muse finished reading the Dishwasher manual.");
  });

  test("a check that never answers is dropped", async () => {
    const never = new Promise(() => {});
    await expect(withTimeout(never, 20)).rejects.toThrow("timed out");
    expect(await withTimeout(Promise.resolve("ok"), 20)).toBe("ok");
  });
});
