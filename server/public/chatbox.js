// The Muse chat box: a text area that grows with what's typed (a few lines,
// then it scrolls), like a messaging app. Kept apart from the page code so the
// tests can check it.

/** The tallest the box gets before it scrolls: about six lines. */
export const MAX_BOX_PX = 168;

/** The box's height for its text: at least one line, at most MAX_BOX_PX. */
export function boxHeight(scrollHeight, min = 48, max = MAX_BOX_PX) {
  return Math.min(Math.max(scrollHeight, min), max);
}

/** Fits the box to its text; it scrolls only once it's at its tallest. */
export function growBox(box) {
  box.style.height = "auto";
  const h = boxHeight(box.scrollHeight);
  box.style.height = `${h}px`;
  box.style.overflowY = box.scrollHeight > h ? "auto" : "hidden";
}

/**
 * Does this key press send? With a keyboard and mouse, Enter sends and
 * Shift+Enter starts a new line. On a phone (a coarse pointer), Enter is a new
 * line and Send sends, as in most chat apps. Never mid-composition (an IME).
 */
export function enterSends(e, finePointer) {
  if (e.key !== "Enter" || e.isComposing) return false;
  if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
  return !!finePointer;
}
