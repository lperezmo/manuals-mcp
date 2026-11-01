import { waitUntil } from "@vercel/functions";

// Work that must finish even if the person leaves the page: Vercel keeps the
// function alive until the promise settles (up to the route's maxDuration).
// Outside Vercel (tests, local runs) the promise simply runs on its own.

/** Keeps `work` running after the response is sent. Its failure is already handled elsewhere. */
export function background(work: Promise<unknown>): void {
  const settled = work.catch(() => {});
  try {
    waitUntil(settled);
  } catch {}
}

/**
 * Waits up to `ms` for `work`. A quick answer (already read, busy, a bad id)
 * comes back as usual; a long one keeps going in the background and the
 * caller answers "started" instead of holding the page open.
 */
export async function quickOrBackground<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ done: true; value: T } | { done: false }> {
  background(work);
  return within(work, ms);
}

/** Waits up to `ms` for `work`; a late one is left running and reported as not done. */
export async function within<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), Math.max(0, ms));
  });
  try {
    return await Promise.race([work.then((value) => ({ done: true as const, value })), late]);
  } finally {
    clearTimeout(timer);
  }
}
