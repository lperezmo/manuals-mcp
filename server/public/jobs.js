// When is a background read over? Kept apart from the page code so the tests
// can check it. A read on the server gives up after about 4.5 minutes and the
// function is gone at 5, so a read still "going" after 6 minutes died.

/** Past this, a read that hasn't said it's done never will. Matches READING_STALE_MS on the server. */
export const JOB_MAX_MS = 6 * 60_000;
/** One check of the database may take this long; a stuck one is dropped and tried again. */
export const CHECK_MS = 15_000;

export const couldntFinish = (label) =>
  `Muse couldn't finish the ${label} manual. Open it and tap Read it again.`;

/**
 * What to tell the person about a read, from its manual row (or null when none
 * changed since the read started). Null means it's still going.
 */
export function readVerdict(manual, job, now = Date.now()) {
  const over = now - Date.parse(job.since) > JOB_MAX_MS;
  if (manual?.status === "distilled")
    return { text: `Muse finished reading the ${job.label} manual.` };
  if (manual?.reading_since) {
    // Being read. A lock this old belongs to a read that died without a word.
    const lockAge = now - Date.parse(manual.reading_since);
    return lockAge <= JOB_MAX_MS && !over ? null : { text: couldntFinish(job.label) };
  }
  if (!manual || manual.status === "pending")
    return over ? { text: couldntFinish(job.label) } : null;
  return { text: manual.status_detail || couldntFinish(job.label) };
}

/** `work`, or a rejection after `ms`, so one stuck request can't hold the pill forever. */
export function withTimeout(work, ms = CHECK_MS) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
