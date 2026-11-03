// Talk instead of type: the browser's own speech-to-text (the Web Speech API)
// fills the chat box as you speak. Nothing is sent until you tap Send. Kept
// apart from the page code so the tests can drive it with a fake recognizer.
//
// Chrome sends the audio to Google to transcribe unless on-device recognition
// is installed for the language; when it is, we ask for it. Firefox has no
// SpeechRecognition at all, so the mic isn't shown there.

/** The browser's SpeechRecognition constructor, or null when there isn't one. */
export function speechCtor(win = globalThis) {
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

/** What to tell the person when dictation stops on an error; null for none (they stopped it). */
export function dictationError(code) {
  if (code === "aborted") return null;
  if (code === "not-allowed" || code === "service-not-allowed")
    return "The microphone is blocked. Allow it for this site in your browser's settings to talk to Muse.";
  if (code === "no-speech") return "Didn't catch that. Tap the mic and try again.";
  if (code === "audio-capture") return "No microphone found.";
  if (code === "network") return "Dictation needs a connection. Try again, or type instead.";
  if (code === "language-not-supported") return "Dictation doesn't support this language yet.";
  return "Dictation stopped. Tap the mic to try again.";
}

/** The text in the box while talking: what was there before, then everything heard so far. */
export function joinSpoken(before, results) {
  const heard = Array.from(results, (r) => r[0]?.transcript ?? "")
    .join("")
    .trim();
  const kept = before.trim();
  if (!heard) return kept;
  return kept ? `${kept} ${heard}` : heard;
}

/**
 * One mic for one text box. `onText(text, final)` gets the box's text as it
 * grows; `onState(listening)` when it starts and stops; `onError(message)` for
 * something worth saying. `toggle()` starts or stops; `cancel()` stops and
 * throws away anything still coming (used when the message is sent).
 */
export function createDictation({
  Ctor,
  lang = "en-US",
  read = () => "",
  onText = () => {},
  onState = () => {},
  onError = () => {},
} = {}) {
  if (!Ctor) return null;
  let rec = null;
  let local = false;
  // Ask once whether on-device recognition is ready for this language (Chrome 139+).
  // Never install it: that downloads a language pack the person didn't ask for.
  try {
    const check = Ctor.available?.({ langs: [lang], processLocally: true });
    check?.then?.(
      (status) => {
        local = status === "available";
      },
      () => {},
    );
  } catch {}

  const end = () => {
    if (!rec) return;
    rec = null;
    onState(false);
  };

  function start() {
    if (rec) return;
    const r = new Ctor();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    if (local && "processLocally" in r) r.processLocally = true;
    const before = read();
    r.onresult = (e) => {
      if (rec !== r) return;
      const results = Array.from(e.results);
      const final = results.length > 0 && results.every((x) => x.isFinal);
      onText(joinSpoken(before, results), final);
    };
    r.onerror = (e) => {
      if (rec !== r) return;
      const message = dictationError(e.error);
      end();
      if (message) onError(message);
    };
    r.onend = () => {
      if (rec === r) end();
    };
    rec = r;
    onState(true);
    try {
      r.start();
    } catch {
      end();
      onError(dictationError(""));
    }
  }

  function stop() {
    // stop() keeps what was heard (a last final result may still come); onend tidies up.
    try {
      rec?.stop();
    } catch {
      end();
    }
  }

  function cancel() {
    const r = rec;
    end();
    try {
      r?.abort();
    } catch {}
  }

  return {
    start,
    stop,
    cancel,
    toggle: () => (rec ? stop() : start()),
    get listening() {
      return !!rec;
    },
  };
}
