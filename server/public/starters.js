// The chips a new Muse chat from Home offers, so it never opens blank: a
// question or two about what's due soonest, then the general ones. Kept apart
// from the page code so the tests can check the wording.

const first = (x) => (Array.isArray(x) ? x[0] : x);

/** "Clean the filter" reads "clean the filter"; "HEPA filter swap" keeps its capitals. */
function lowerFirst(text) {
  return /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

/** " on the Dishwasher", unless the task already names it. */
function onThe(title, nickname) {
  if (!nickname || title.toLowerCase().includes(nickname.toLowerCase())) return "";
  return ` on the ${nickname}`;
}

/**
 * Up to four starters from `due` (tasks with title, next_due_on and their
 * item), soonest first: when the most pressing one was last done, how to do
 * the next one, what's due this week, and one to tell Muse about a job done.
 */
export function homeStarters(due = []) {
  const soonest = [...due]
    .filter((t) => t?.title)
    .sort((a, b) => String(a.next_due_on).localeCompare(String(b.next_due_on)));
  const starters = [];
  const [a, b] = soonest;
  if (a) {
    const text = `When did I last ${lowerFirst(a.title.trim())}${onThe(a.title, first(a.items)?.nickname)}?`;
    starters.push({ label: text, text });
  }
  if (b) {
    const text = `How do I ${lowerFirst(b.title.trim())}${onThe(b.title, first(b.items)?.nickname)}?`;
    starters.push({ label: text, text });
  }
  starters.push(
    soonest.length
      ? { label: "What's due this week?", text: "What's due this week?" }
      : {
          label: "What should I keep an eye on?",
          text: "What should I keep an eye on around the house?",
        },
  );
  starters.push({ label: "I just did something", text: "I just ", draft: true });
  return starters;
}
