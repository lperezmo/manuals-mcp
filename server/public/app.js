// Shared by every page: Supabase sign-in, the header, calls to the server's
// tools, and the Muse chat drawer. Pages import what they need.

let client;
let config;

export function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

export const $ = (selector, root = document) => root.querySelector(selector);

export function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function addDays(day, n) {
  return new Date(Date.parse(day) + n * 86400000).toISOString().slice(0, 10);
}

export function daysBetween(from, to) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}

export function relDay(day) {
  const d = daysBetween(today(), day);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  return d > 0 ? `in ${d} days` : `${-d} days late`;
}

export function ago(iso) {
  const days = daysBetween(iso.slice(0, 10), today());
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

export function howOften(unit, value) {
  if (unit === "once") return "once";
  if (unit === "as_needed") return "as needed";
  const names = { days: "day", weeks: "week", months: "month", cycles: "use" };
  if (unit === "cycles") return `every ${value} uses`;
  return value === 1 ? `every ${names[unit]}` : `every ${value} ${unit}`;
}

export function toast(text) {
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

/** The Supabase client, made once from the server's public settings. */
export async function db() {
  if (client) return client;
  config = await fetch("/api/config").then((r) => r.json());
  client = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey);
  return client;
}

async function token() {
  const { data } = await (await db()).auth.getSession();
  return data.session?.access_token;
}

/**
 * POST to one of the server's endpoints as the signed-in user. A dropped
 * connection (the phone switched apps, the network blinked) throws with
 * `dropped` set: the server may still be finishing the work.
 */
export async function api(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await token()}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error("The connection dropped."), { dropped: true });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(json.error || json.summary || `Request failed (${res.status})`), {
      status: res.status,
      busy: json.busy === true,
    });
  }
  return json;
}

/** Runs one of the 10 tools, exactly as an AI would. */
export const tool = (name, args = {}) => api("/api/tool", { name, args });

const NAV = [
  ["/", "Home", "M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"],
  ["/things", "Things", "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"],
  ["/history", "History", "M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4"],
  ["/connect", "Connect your AI", "M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"],
];

// Reading preferences, kept in this browser; theme.js applies them on load.
const PREFS = {
  "manuals-size": [
    "Text size",
    [
      ["normal", "Normal"],
      ["large", "Large"],
    ],
  ],
  "manuals-font": [
    "Headings",
    [
      ["serif", "Serif"],
      ["sans", "Simple"],
    ],
  ],
};

function pref(key) {
  try {
    return localStorage.getItem(key) || PREFS[key][1][0][0];
  } catch {
    return PREFS[key][1][0][0];
  }
}

function setPref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
  document.documentElement.dataset[key === "manuals-size" ? "size" : "font"] = value;
}

function header(current, session) {
  const links = NAV.map(
    ([href, label, d]) =>
      `<a href="${href}"${href === current ? ' aria-current="page"' : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg><span>${label}</span></a>`,
  ).join("");
  if (!session) {
    return `<a class="brand" href="/">manuals</a><span style="flex:1"></span><div class="theme-toggle"></div>`;
  }
  const email = session.user?.email ?? "";
  const initial = (email.trim()[0] || "?").toUpperCase();
  const prefs = Object.entries(PREFS)
    .map(
      ([key, [label, options]]) => `<div class="menu-row"><span>${label}</span>
        <div class="seg" role="group" aria-label="${label}">${options
          .map(
            ([value, text]) =>
              `<button type="button" data-pref="${key}" data-value="${value}" aria-pressed="${pref(key) === value}">${text}</button>`,
          )
          .join("")}</div></div>`,
    )
    .join("");
  return `<a class="brand" href="/">manuals</a>
    <nav class="nav" aria-label="Main">${links}</nav>
    <div class="account">
      <button type="button" class="avatar" id="account" aria-haspopup="true" aria-expanded="false" aria-controls="account-menu" aria-label="Account and settings">${esc(initial)}</button>
      <div class="menu" id="account-menu" hidden>
        <div class="menu-who"><span class="avatar" aria-hidden="true">${esc(initial)}</span><div><strong>Signed in</strong><span class="small muted">${esc(email)}</span></div></div>
        <div class="menu-row"><span>Theme</span><div class="theme-toggle"></div></div>
        ${prefs}
        <hr>
        <a class="menu-link" href="/household">Your household</a>
        <a class="menu-link" href="/runs">Model log</a>
        <a class="menu-link" href="/connect">Connect your AI</a>
        <button type="button" class="menu-link" id="report-issue">Report an issue</button>
        <hr>
        <button type="button" class="menu-link" id="sign-out">Sign out</button>
      </div>
    </div>`;
}

function wireAccount() {
  const button = $("#account");
  const menu = $("#account-menu");
  if (!button || !menu) return;
  const close = () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  button.addEventListener("click", () => {
    const open = menu.hidden;
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== button) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !menu.hidden) {
      close();
      button.focus();
    }
  });
  for (const b of menu.querySelectorAll("[data-pref]")) {
    b.addEventListener("click", () => {
      setPref(b.dataset.pref, b.dataset.value);
      for (const other of menu.querySelectorAll(`[data-pref="${b.dataset.pref}"]`)) {
        other.setAttribute("aria-pressed", String(other === b));
      }
    });
  }
}

/**
 * Starts a page. Signed in: draws the header and returns the session.
 * Signed out: the home page shows sign-in, other pages go home.
 */
export async function boot(current, { open = false } = {}) {
  const supa = await db();
  const { data } = await supa.auth.getSession();
  const top = $("#top");
  top.innerHTML = header(current, data.session);
  window.dispatchEvent(new Event("manuals:theme-toggle"));
  wireAccount();
  $("#report-issue")?.addEventListener("click", () => {
    $("#account-menu").hidden = true;
    $("#account").setAttribute("aria-expanded", "false");
    reportIssue();
  });
  $("#sign-out")?.addEventListener("click", async () => {
    await supa.auth.signOut();
    location.assign("/");
  });
  if (!data.session && current !== "/" && !open) {
    location.assign("/");
    return null;
  }
  // Pick up anything still reading or searching from an earlier page.
  if (data.session) startWatching();
  return data.session;
}

/** Sign in with an emailed code, or a password (the judges' demo account). */
export function signIn(root, onDone) {
  root.innerHTML = `
    <section class="card" style="max-width:560px">
      <h1>Every manual in the house, one question away.</h1>
      <p class="muted">Sign in to see your things. We'll email you a 6-digit code.</p>
      <form id="email-form" class="field">
        <label class="sr-only" for="email">Email</label>
        <input id="email" type="email" autocomplete="email" required placeholder="you@example.com">
        <button type="submit">Send code</button>
      </form>
      <form id="code-form" class="field hidden">
        <label class="sr-only" for="code">Code from the email</label>
        <input id="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="Code from the email">
        <button type="submit">Sign in</button>
      </form>
      <details>
        <summary class="small">Have a password? (demo account)</summary>
        <form id="pw-form" class="stack" style="margin-top:10px">
          <label class="sr-only" for="pw-email">Email</label>
          <input id="pw-email" type="email" autocomplete="username" required placeholder="Email">
          <label class="sr-only" for="pw">Password</label>
          <div class="row">
            <input id="pw" type="password" autocomplete="current-password" required placeholder="Password" style="flex:1">
            <button type="button" class="quiet small" id="pw-show" aria-controls="pw" aria-pressed="false">Show</button>
          </div>
          <button type="submit">Sign in</button>
        </form>
      </details>
      <p id="sign-msg" class="small muted" role="status"></p>
    </section>`;
  const msg = (t) => {
    $("#sign-msg", root).textContent = t;
  };
  const done = async (error) => {
    if (error) return msg(error.message);
    onDone();
  };
  $("#email-form", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const supa = await db();
    const { error } = await supa.auth.signInWithOtp({
      email: $("#email", root).value.trim(),
      options: { shouldCreateUser: true },
    });
    if (error) return msg(`Couldn't send the code: ${error.message}`);
    $("#email-form", root).classList.add("hidden");
    $("#code-form", root).classList.remove("hidden");
    $("#code", root).focus();
    msg("Check your email for the code.");
  });
  $("#code-form", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const supa = await db();
    const { error } = await supa.auth.verifyOtp({
      email: $("#email", root).value.trim(),
      token: $("#code", root).value.trim(),
      type: "email",
    });
    done(error);
  });
  $("#pw-show", root).addEventListener("click", (e) => {
    const pw = $("#pw", root);
    const show = pw.type === "password";
    pw.type = show ? "text" : "password";
    e.currentTarget.textContent = show ? "Hide" : "Show";
    e.currentTarget.setAttribute("aria-pressed", String(show));
    pw.focus();
  });
  $("#pw-form", root).addEventListener("submit", async (e) => {
    e.preventDefault();
    const supa = await db();
    const { error } = await supa.auth.signInWithPassword({
      email: $("#pw-email", root).value.trim(),
      password: $("#pw", root).value,
    });
    done(error);
  });
}

// --- Chat drawer ------------------------------------------------------------

const CHAT_KEY = "manuals-chat";
const TOOL_NAMES = {
  add_item: "Added a thing",
  list_items: "Looked at your things",
  ask_manual: "Read the manual",
  upcoming: "Checked what's coming up",
  revise_fact: "Revised a fact",
  log_done: "Logged it done",
  record_measurement: "Saved a reading",
  car_seat_status: "Checked the car seat",
  photo_check: "Checked the photo",
  update_item: "Updated the details",
  catch_up: "Planned the catch-up",
  warranty_status: "Checked the warranty",
  fast_lane: "Instant answer",
};
// Tools that are part of how Muse talks, not something it did for you.
const QUIET_TOOLS = new Set(["show_card"]);
const CAMERA_ICON =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"></path><circle cx="12" cy="13" r="3.5"></circle></svg>';
// The photo waiting to be sent: the full image for Muse and a small one for the bubble.
let pendingPhoto = null;

function loadChat() {
  try {
    return JSON.parse(sessionStorage.getItem(CHAT_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveChat(messages) {
  try {
    sessionStorage.setItem(CHAT_KEY, JSON.stringify(messages.slice(-30)));
  } catch {}
}

let drawer;

function renderChat(messages, busy) {
  const log = $(".chat-log", drawer);
  log.innerHTML =
    messages
      .map((m, i) => {
        const shown = [...new Set(m.tools ?? [])].filter((t) => !QUIET_TOOLS.has(t));
        const tools = shown.length
          ? `<div class="chips">${shown.map((t) => `<span class="chip ${t === "revise_fact" ? "teal strong" : ""}">${esc(TOOL_NAMES[t] || t)}</span>`).join("")}</div>`
          : "";
        const card = m.card && !m.answered ? cardForm(m.card, i) : "";
        const photo = m.photo?.startsWith("data:image/")
          ? `<img class="msg-photo" src="${esc(m.photo)}" alt="Your photo">`
          : "";
        // An instant answer from a saved line: one tap asks Muse to go further.
        const more =
          m.fast && i === messages.length - 1 && !busy
            ? '<div class="row" style="margin-top:8px"><button type="button" class="quiet small" data-more>Ask Muse for more</button></div>'
            : "";
        return `<div class="msg ${m.role === "user" ? "user" : "muse"}">${photo}${esc(m.content)}${tools}${card}${more}</div>`;
      })
      .join("") + (busy ? '<div class="msg muse muted">Reading…</div>' : "");
  if (!messages.length && !busy) {
    log.innerHTML =
      '<p class="muted small">Ask about anything you own, or tell it something: "I just cleaned the dishwasher filter", "the washer is at 230 washes".</p>';
  }
  log.scrollTop = log.scrollHeight;
}

// Forms Muse attaches to a reply. Muse picks from these few shapes (checked
// on the server); every string is escaped here, and a filled form goes back as
// an ordinary message, so nothing is saved until Muse calls a tool.
const UNIT_NAMES = { per_week: "a week", months: "months", years: "years" };
// Most people remember roughly when, not the day. Months back, and how it reads.
const ROUGH = [
  ["0", "This month"],
  ["3", "A few months ago"],
  ["12", "About a year ago"],
  ["24", "About 2 years ago"],
  ["48", "3 to 5 years ago"],
  ["84", "More than 5 years ago"],
  ["unsure", "Not sure"],
];

/** "About a year ago (around 2025-10)": the rough answer plus a month Muse can save. */
function roughDate(value) {
  const pick = ROUGH.find(([m]) => m === value);
  if (!pick) return "";
  if (value === "unsure") return "not sure";
  const d = new Date();
  d.setMonth(d.getMonth() - Number(value));
  return `${pick[1]} (around ${d.toISOString().slice(0, 7)})`;
}

function cardField(f, n) {
  const id = `card-${n}-${f.key}`;
  const label = `<label for="${id}">${esc(f.label)}</label>`;
  if (f.type === "date" && f.exact)
    return `${label}<input id="${id}" name="${esc(f.key)}" type="date">`;
  if (f.type === "date")
    return `${label}<select id="${id}" name="${esc(f.key)}" data-rough><option value="">Pick one</option>${ROUGH.map(([m, t]) => `<option value="${m}">${t}</option>`).join("")}<option value="exact">I know the date</option></select><input name="${esc(f.key)}__exact" type="date" aria-label="${esc(f.label)}" hidden>`;
  if (f.type === "text")
    return `${label}<input id="${id}" name="${esc(f.key)}" maxlength="120" placeholder="${esc(f.placeholder || "")}">`;
  if (f.type === "number") {
    const units = f.units?.length
      ? f.units.length === 1
        ? `<span class="muted">${esc(UNIT_NAMES[f.units[0]] || f.units[0])}</span><input type="hidden" name="${esc(f.key)}__unit" value="${esc(f.units[0])}">`
        : `<select name="${esc(f.key)}__unit" aria-label="Unit">${f.units.map((u) => `<option value="${esc(u)}">${esc(UNIT_NAMES[u] || u)}</option>`).join("")}</select>`
      : "";
    return `${label}<div class="row"><input id="${id}" name="${esc(f.key)}" type="number" step="any" min="0" inputmode="decimal" style="flex:1">${units}</div>`;
  }
  const multi = f.type === "checklist";
  const options = f.options
    .map((o) => {
      const value = multi ? o.value : o;
      const text = multi ? o.label : o;
      return `<label class="pick"><input type="${multi ? "checkbox" : "radio"}" name="${esc(f.key)}" value="${esc(value)}" data-label="${esc(text)}"${multi && o.checked !== false ? " checked" : ""}> ${esc(text)}</label>`;
    })
    .join("");
  return `<fieldset><legend>${esc(f.label)}</legend><div class="picks">${options}</div></fieldset>`;
}

function cardForm(card, n) {
  return `<form class="card-form" data-card="${n}">
    <strong>${esc(card.title)}</strong>
    ${card.fields.map((f) => `<div class="card-field">${cardField(f, n)}</div>`).join("")}
    <div class="row"><button type="submit" class="small">${esc(card.submit || "Send")}</button><button type="button" class="quiet small" data-skip>Skip</button></div>
  </form>`;
}

/** Turns a filled form into the message Muse reads: one line per question. */
function cardAnswer(card, form) {
  const data = new FormData(form);
  const lines = card.fields.map((f) => {
    if (f.type === "checklist") {
      const boxes = [...form.querySelectorAll(`input[name="${CSS.escape(f.key)}"]`)];
      const kept = boxes.filter((b) => b.checked).map((b) => b.dataset.label);
      const off = boxes.filter((b) => !b.checked).map((b) => `${b.dataset.label} [${b.value}]`);
      return `- ${f.label}: keep ${kept.join(", ") || "none"}${off.length ? `; unticked: ${off.join(", ")}` : ""}`;
    }
    let value = String(data.get(f.key) ?? "").trim();
    if (f.type === "date" && !f.exact)
      value =
        value === "exact" ? String(data.get(`${f.key}__exact`) ?? "").trim() : roughDate(value);
    if (!value) return `- ${f.label}: (skipped)`;
    const unit = data.get(`${f.key}__unit`);
    return `- ${f.label}: ${value}${unit ? ` ${UNIT_NAMES[unit] || unit}` : ""}`;
  });
  return [card.title, ...lines].join("\n");
}

/**
 * Search as you type: under `input`, the saved facts and tasks that answer
 * what's being typed ("E4 · Drain error · p. 31"), before Enter. One request
 * in flight; when it comes back and the text has changed, it asks again.
 * Picking one sends the typed question with `onPick`. The list goes under the
 * input's form, or over it with `above` (the chat drawer, whose box is at the bottom).
 */
export function typeAhead(input, onPick, { above = false } = {}) {
  const list = document.createElement("div");
  list.className = "suggest";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Saved answers");
  list.hidden = true;
  input.setAttribute("aria-autocomplete", "list");
  const box = input.form ?? input;
  if (above) box.before(list);
  else box.after(list);
  let asked = "";
  let busy = false;
  let timer = 0;
  const clear = () => {
    list.hidden = true;
    list.innerHTML = "";
  };
  const draw = (found) => {
    if (!found.length || !input.value.trim()) return clear();
    list.innerHTML = found
      .map(
        (s) =>
          `<button type="button" role="option" class="suggest-row"><span class="suggest-item">${esc(s.item)}</span><strong>${esc(s.label)}</strong><span>${esc(s.text)}</span>${s.page ? `<span class="muted">p. ${s.page}</span>` : ""}${s.unchecked ? '<span class="chip gold strong">To check</span>' : ""}</button>`,
      )
      .join("");
    list.hidden = false;
  };
  const ask = async () => {
    const text = input.value.trim();
    if (busy || text === asked) return;
    if (text.length < 3) {
      asked = text;
      return clear();
    }
    busy = true;
    asked = text;
    try {
      const { suggestions = [] } = await api("/api/suggest", { q: text });
      if (input.value.trim() === text) draw(suggestions);
    } catch {
      clear();
    } finally {
      busy = false;
    }
    // The text moved on while Jev was answering: ask about the new text.
    if (input.value.trim() !== asked) ask();
  };
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(ask, 180);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") clear();
    if (e.key === "Enter") clear();
  });
  input.form?.addEventListener("submit", clear);
  list.addEventListener("click", (e) => {
    if (!e.target.closest(".suggest-row")) return;
    const text = input.value.trim();
    clear();
    if (text) onPick(text);
  });
}

/** Opens the chat drawer, optionally sending a message right away. */
export function openChat(text, onChange) {
  if (!drawer) {
    drawer = document.createElement("section");
    drawer.className = "chat";
    drawer.setAttribute("aria-label", "Chat with Muse");
    drawer.innerHTML = `
      <div class="chat-head">
        <h2 style="font-size:20px;flex:1">Ask Muse</h2>
        <button type="button" class="quiet small" data-clear>Clear</button>
        <button type="button" class="quiet small" data-close aria-label="Close chat">Close</button>
      </div>
      <div class="chat-log" aria-live="polite"></div>
      <div class="chat-pending" hidden>
        <img alt="Photo to send">
        <button type="button" class="quiet small" data-unphoto aria-label="Remove photo">×</button>
      </div>
      <form class="field">
        <label class="sr-only" for="chat-input">Ask or tell</label>
        <label class="button quiet chat-attach" title="Add a photo">
          ${CAMERA_ICON}<span class="sr-only">Add a photo</span>
          <input id="chat-photo" type="file" accept="image/*" class="sr-only">
        </label>
        <input id="chat-input" autocomplete="off" placeholder="Ask or tell">
        <button type="submit">Send</button>
      </form>`;
    document.body.append(drawer);
    typeAhead(
      $("#chat-input", drawer),
      (text) => {
        $("#chat-input", drawer).value = "";
        send(text, onChange);
      },
      { above: true },
    );
    $("[data-close]", drawer).addEventListener("click", () => drawer.classList.add("hidden"));
    $("[data-clear]", drawer).addEventListener("click", () => {
      saveChat([]);
      renderChat([]);
    });
    const log = $(".chat-log", drawer);
    log.addEventListener("submit", (e) => {
      const form = e.target.closest("form[data-card]");
      if (!form) return;
      e.preventDefault();
      answerCard(Number(form.dataset.card), (card) => cardAnswer(card, form), onChange);
    });
    // "I know the date" swaps the rough pick for a date picker.
    log.addEventListener("change", (e) => {
      const pick = e.target.closest("select[data-rough]");
      if (!pick) return;
      const exact = pick.nextElementSibling;
      exact.hidden = pick.value !== "exact";
      if (!exact.hidden) exact.focus();
    });
    log.addEventListener("click", (e) => {
      if (e.target.closest("[data-more]")) {
        send("Tell me more.", onChange, "more");
        return;
      }
      const form = e.target.closest("[data-skip]")?.closest("form[data-card]");
      if (form) answerCard(Number(form.dataset.card), () => "Skip that for now.", onChange);
    });
    $("#chat-photo", drawer).addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        pendingPhoto = { image: await shrink(file), thumb: await shrink(file, 320) };
        showPendingPhoto();
        $("#chat-input", drawer).focus();
      } catch (err) {
        toast(err.message);
      }
    });
    $("[data-unphoto]", drawer).addEventListener("click", () => {
      pendingPhoto = null;
      showPendingPhoto();
    });
    $("form.field", drawer).addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("#chat-input", drawer);
      const value = input.value.trim();
      const photo = pendingPhoto;
      if (!value && !photo) return;
      input.value = "";
      pendingPhoto = null;
      showPendingPhoto();
      send(value, onChange, undefined, photo);
    });
  }
  drawer.classList.remove("hidden");
  renderChat(loadChat());
  if (text) send(text, onChange);
  else $("#chat-input", drawer).focus();
}

function showPendingPhoto() {
  const box = $(".chat-pending", drawer);
  box.hidden = !pendingPhoto;
  $("img", box).src = pendingPhoto?.thumb || "";
}

function answerCard(index, toText, onChange) {
  const messages = loadChat();
  const m = messages[index];
  if (!m?.card || m.answered) return;
  const text = toText(m.card);
  m.answered = true;
  saveChat(messages);
  send(text, onChange, "card");
}

async function send(text, onChange, via, photo) {
  // Only the small copy of a photo is kept; Muse gets the full one this turn only.
  const messages = [
    ...loadChat(),
    { role: "user", content: text, ...(photo ? { photo: photo.thumb } : {}) },
  ];
  saveChat(messages);
  renderChat(messages, true);
  try {
    const history = messages.map(({ role, content, history: remembered, photo: had }) => ({
      role,
      content: (had ? `[photo] ${content}`.trim() : remembered || content).slice(0, 2000),
    }));
    const {
      reply,
      tools_used,
      card,
      fast,
      history: remembered,
    } = await api("/api/chat", {
      messages: history,
      ...(via ? { via } : {}),
      ...(photo ? { image: photo.image } : {}),
    });
    messages.push({
      role: "assistant",
      content: reply,
      tools: tools_used,
      card,
      ...(fast ? { fast: true } : {}),
      history: remembered,
    });
    if (
      tools_used.some(
        (t) =>
          ![
            "list_items",
            "ask_manual",
            "upcoming",
            "car_seat_status",
            "photo_check",
            "fast_lane",
          ].includes(t),
      )
    ) {
      onChange?.();
    }
  } catch (err) {
    messages.push({ role: "assistant", content: `Sorry, that didn't work: ${err.message}` });
  }
  saveChat(messages);
  renderChat(messages);
}

// Line icons for things, 24px grid, drawn with currentColor. Matched on the
// item's category or nickname; anything else gets the manual icon.
const R = (x, y, w, h, r) =>
  `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
const C = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
const L = (a, b, c, d) => `M${a} ${b}L${c} ${d}`;
// Order matters for guessing: "dishwasher" before "washer", "car seat" before "car".
export const ICONS = {
  dishwasher: [
    "Dishwasher",
    /dish/,
    R(4, 2.5, 16, 19, 2.5) +
      L(4, 7.5, 20, 7.5) +
      L(9, 10.5, 15, 10.5) +
      C(7, 5, 0.4) +
      C(9.5, 5, 0.4) +
      C(12, 5, 0.4),
  ],
  dryer: [
    "Dryer",
    /dryer/,
    R(4, 2.5, 16, 19, 2.5) +
      L(4, 7, 20, 7) +
      C(12, 14, 4.5) +
      "M9.6 14.6c.8-.8 1.6-.8 2.4 0s1.6.8 2.4 0" +
      C(16.5, 4.8, 0.5),
  ],
  washer: [
    "Washer",
    /wash/,
    R(4, 2.5, 16, 19, 2.5) + L(4, 7, 20, 7) + C(12, 14, 4.5) + C(7, 4.8, 0.4) + C(9.5, 4.8, 0.4),
  ],
  fridge: [
    "Fridge",
    /fridge|refrig|freezer/,
    R(5.5, 2, 13, 20, 2.5) + L(5.5, 9.5, 18.5, 9.5) + L(8.5, 4.5, 8.5, 7) + L(8.5, 12, 8.5, 16),
  ],
  microwave: [
    "Microwave",
    /microwave/,
    R(2.5, 5, 19, 14, 2.5) +
      R(5, 8, 10, 8, 1) +
      L(18, 8.5, 18, 9.5) +
      L(18, 12, 18, 13) +
      C(18, 15.8, 0.5),
  ],
  range: [
    "Range",
    /range|oven|stove|cooktop/,
    R(4, 3, 16, 18.5, 2) +
      L(4, 8, 20, 8) +
      C(8, 5.5, 0.9) +
      C(12, 5.5, 0.9) +
      C(16, 5.5, 0.9) +
      R(7.5, 11, 9, 6.5, 1),
  ],
  furnace: [
    "Furnace",
    /furnace|boiler|hvac/,
    R(5, 2.5, 14, 19, 2) +
      L(8, 6, 16, 6) +
      L(8, 8.5, 16, 8.5) +
      "M12 18.5c-1.8 0-3-1.2-3-2.8 0-1.6 1.5-2.4 1.8-4.2 1.4.8 1.5 2 1.4 2.8.6-.3 1-.9 1.1-1.6.9.8 1.7 1.8 1.7 3 0 1.6-1.2 2.8-3 2.8z",
  ],
  water_heater: [
    "Water heater",
    /water.?heater/,
    "M6 6.5C6 4.6 8.7 3 12 3s6 1.6 6 3.5V19c0 1.1-2.7 2-6 2s-6-.9-6-2z" +
      L(9.5, 3.4, 9.5, 1.5) +
      L(14.5, 3.4, 14.5, 1.5) +
      C(12, 11, 2) +
      L(12, 11, 13.2, 9.8),
  ],
  air_conditioner: [
    "Air conditioner",
    /air.?cond|\bac\b|heat.?pump/,
    R(2.5, 5, 19, 9, 2.5) +
      L(5.5, 11, 18.5, 11) +
      "M7.5 17c0 1.5 1 2.5 1 4M12 17v4M16.5 17c0 1.5-1 2.5-1 4",
  ],
  car_seat: [
    "Car seat",
    /car.?seat|booster/,
    "M7 3.5h5.5a2 2 0 0 1 2 2V12l3.5 2.5V19a1.5 1.5 0 0 1-1.5 1.5H8A2.5 2.5 0 0 1 5.5 18V5A1.5 1.5 0 0 1 7 3.5z" +
      "M8.5 8v5.5l2.5 2 2.5-2" +
      C(11, 15.5, 0.6),
  ],
  stroller: [
    "Stroller",
    /stroller|pram/,
    "M3.5 5h2.5l2.5 9.5h10" +
      "M11 4.5a7.5 7.5 0 0 1 8 7.5h-8z" +
      C(9.5, 18.5, 1.8) +
      C(17, 18.5, 1.8),
  ],
  mower: [
    "Lawn mower",
    /mower/,
    "M4 13h12.5l2 4.5H4z" +
      L(15, 13, 20.5, 4.5) +
      L(19, 4, 21.5, 5.5) +
      C(6.5, 19.2, 1.5) +
      C(15.5, 19.2, 1.5),
  ],
  vacuum: [
    "Vacuum",
    /vacuum/,
    L(16.5, 3, 11, 16.5) + R(4.5, 16.5, 10, 3.5, 1.5) + C(14.8, 7.8, 2.2),
  ],
  coffee: [
    "Coffee maker",
    /coffee|espresso/,
    R(6, 3, 12, 18, 2) + L(6, 8, 18, 8) + "M9 12h6v4a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 16z",
  ],
  car: [
    "Car",
    /\bcar\b|truck|suv|\bvan\b|vehicle/,
    "M3.5 15V12l2-4.5c.3-.7 1-1 1.7-1h9.6c.7 0 1.4.3 1.7 1l2 4.5v3c0 .6-.4 1-1 1h-15c-.6 0-1-.4-1-1z" +
      L(3.5, 12, 20.5, 12) +
      C(7.5, 17.5, 1.8) +
      C(16.5, 17.5, 1.8),
  ],
  other: [
    "Other",
    /$^/,
    "M5 4.5A1.5 1.5 0 0 1 6.5 3H18v15H6.5A1.5 1.5 0 0 0 5 19.5z" +
      "M5 19.5A1.5 1.5 0 0 0 6.5 21H18v-3" +
      L(9, 7.5, 14, 7.5),
  ],
};
export const TINTS = { teal: "Teal", gold: "Gold", sage: "Sage", slate: "Slate" };

/** The icon key for a thing: the one picked, else a guess from its category and name. */
export function iconKey(item) {
  if (item?.icon && ICONS[item.icon]) return item.icon;
  const text = `${item?.category ?? ""} ${item?.nickname ?? ""}`.toLowerCase();
  const guess = Object.keys(ICONS).find((k) => ICONS[k][1].test(text));
  return guess ?? (item?.kind === "vehicle" ? "car" : "other");
}

export function tintKey(item) {
  if (item?.tint && TINTS[item.tint]) return item.tint;
  return { baby_gear: "gold", vehicle: "sage" }[item?.kind] ?? "teal";
}

export function iconSvg(key, px) {
  return `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[key][2]}"></path></svg>`;
}

/** A tinted icon badge for a thing, as HTML. */
export function itemIcon(item, size = 44) {
  return `<span class="icon-badge ${tintKey(item)}" style="--s:${size}px" aria-hidden="true">${iconSvg(iconKey(item), Math.round(size * 0.6))}</span>`;
}

/**
 * "Report an issue": a small dialog that sends a note to the maintainer,
 * with the page and, from the model log, the run's debug details attached.
 */
export function reportIssue({ runId, debug, about } = {}) {
  const dialog = document.createElement("dialog");
  dialog.className = "report";
  dialog.innerHTML = `
    <form method="dialog" class="stack">
      <h2>Report an issue</h2>
      <p class="muted small">${about ? `About: ${esc(about)}. ` : ""}Tell us what went wrong or what looked off. ${debug ? "The run's details are attached." : "The page you're on is attached."}</p>
      <label class="sr-only" for="report-text">What happened</label>
      <textarea id="report-text" rows="5" maxlength="2000" required placeholder="What happened, and what you expected"></textarea>
      <div class="row" style="justify-content:flex-end">
        <button type="button" class="quiet" data-cancel>Cancel</button>
        <button type="submit">Send</button>
      </div>
    </form>`;
  document.body.append(dialog);
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  $("[data-cancel]", dialog).addEventListener("click", close);
  dialog.addEventListener("cancel", close);
  $("form", dialog).addEventListener("submit", async (e) => {
    e.preventDefault();
    const send = $("[type=submit]", dialog);
    send.disabled = true;
    try {
      await api("/api/report", {
        message: $("#report-text", dialog).value,
        page: location.pathname + location.search,
        ...(runId ? { run_id: runId } : {}),
        ...(debug ? { debug: debug.slice(0, 20000) } : {}),
      });
      close();
      toast("Thanks! Your report was sent.");
    } catch (err) {
      send.disabled = false;
      toast(err.message);
    }
  });
  dialog.showModal();
  $("#report-text", dialog).focus();
}

/**
 * A photo as a JPEG data URL, at most 1280 px (or `max`) on its long side.
 * Jev takes images up to 1568 px a side and fails the whole request past it,
 * so photos it checks (labels, receipts, chat) stay at or under that.
 */
export function shrink(file, max = 1280) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => reject(new Error("Couldn't open that photo."));
    img.src = URL.createObjectURL(file);
  });
}

// A label photo taken on the home page, handed to the add wizard.
const PENDING = "manuals-pending-photo";

export async function handOffPhoto(file) {
  const image = await shrink(file);
  try {
    sessionStorage.setItem(PENDING, image);
  } catch {}
  location.assign("/things?add=photo");
}

export function takePendingPhoto() {
  try {
    const image = sessionStorage.getItem(PENDING);
    sessionStorage.removeItem(PENDING);
    return image;
  } catch {
    return null;
  }
}

/** Hands a link to the phone's share sheet, or copies it where there is none. */
export async function shareLink(url, title) {
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied.");
  } catch {
    prompt("Copy this link:", url);
  }
}

/** Opens the account menu, for links that say "Settings". */
export function openSettings() {
  const button = $("#account");
  if (button && $("#account-menu")?.hidden) button.click();
  button?.scrollIntoView({ block: "nearest" });
}

// --- Background work ------------------------------------------------------
// Reading a manual or searching for one keeps running on the server when the
// page is left. This browser remembers what it's waiting for, shows a small
// pill on every page, and says when each one is done.

const JOBS_KEY = "manuals-jobs";
const JOB_MAX_MS = 8 * 60_000;
let watching = false;

function loadJobs() {
  try {
    return JSON.parse(localStorage.getItem(JOBS_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveJobs(jobs) {
  try {
    localStorage.setItem(JOBS_KEY, JSON.stringify(jobs));
  } catch {}
  drawJobs();
}

/** Waits for a read ({ kind: "read", item, label }) or a search ({ kind: "search", ... }) in the background. */
export function watchJob(job) {
  const jobs = loadJobs().filter((j) => !(j.kind === job.kind && j.item === job.item));
  // A few seconds back, so a read that started a moment ago still counts.
  jobs.push({ ...job, since: new Date(Date.now() - 10_000).toISOString() });
  saveJobs(jobs);
  startWatching();
}

/** Stops waiting, when the page already has the answer. */
export function forgetJob(kind, item) {
  saveJobs(loadJobs().filter((j) => !(j.kind === kind && j.item === item)));
}

function drawJobs() {
  const jobs = loadJobs();
  let pill = document.querySelector(".jobs-pill");
  if (!jobs.length) {
    pill?.remove();
    return;
  }
  if (!pill) {
    pill = document.createElement("div");
    pill.className = "jobs-pill";
    pill.setAttribute("role", "status");
    document.body.append(pill);
  }
  const what = jobs.map((j) =>
    j.kind === "read" ? `reading the ${j.label} manual` : `looking for the ${j.label} manual`,
  );
  pill.innerHTML = `<span class="jobs-dot" aria-hidden="true"></span>Muse is ${esc(what.length > 2 ? `working on ${what.length} things` : what.join(" and "))}…`;
}

/** Is it done? A read is done when its manual is no longer pending or being read; a search when its log entry is in. */
async function checkJob(supa, job) {
  if (job.kind === "read") {
    const { data: m } = await supa
      .from("manuals")
      .select("status, status_detail, reading_since")
      .eq("item_id", job.item)
      .gte("updated_at", job.since)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!m || m.reading_since || m.status === "pending") return null;
    if (m.status === "distilled") return { text: `Muse finished reading the ${job.label} manual.` };
    return { text: m.status_detail || `Muse couldn't finish the ${job.label} manual.` };
  }
  const { data: run } = await supa
    .from("model_runs")
    .select("ok, raw_output, error")
    .eq("kind", "search")
    .eq("item_id", job.item)
    .gte("created_at", job.since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run) return null;
  if (!run.ok) return { text: run.error || `The search for the ${job.label} manual didn't work.` };
  let n = 0;
  try {
    n = JSON.parse(run.raw_output).candidates.length;
  } catch {}
  return {
    text: n
      ? `Found ${n} manual${n === 1 ? "" : "s"} for the ${job.label}.`
      : `Couldn't find the ${job.label} manual online.`,
  };
}

async function startWatching() {
  drawJobs();
  if (watching || !loadJobs().length) return;
  watching = true;
  const supa = await db();
  while (loadJobs().length) {
    await new Promise((r) => setTimeout(r, 4000));
    for (const job of loadJobs()) {
      let done = null;
      try {
        done = await checkJob(supa, job);
      } catch {}
      if (!done && Date.now() - Date.parse(job.since) > JOB_MAX_MS) {
        done = { text: `Muse is still on the ${job.label}. Check back in a bit.` };
      }
      if (!done) continue;
      forgetJob(job.kind, job.item);
      const here =
        location.pathname === "/things" &&
        new URLSearchParams(location.search).get("id") === job.item;
      notify(done.text, here ? null : `/things?id=${job.item}`);
      window.dispatchEvent(new CustomEvent("manuals:job-done", { detail: job }));
    }
  }
  watching = false;
}

/** A toast that stays a little longer, with a link to the thing. */
function notify(text, href) {
  const t = document.createElement("div");
  t.className = "toast";
  t.setAttribute("role", "status");
  t.innerHTML = `${esc(text)}${href ? ` <a href="${esc(href)}" style="color:inherit;font-weight:700;margin-left:8px">Open</a>` : ""}`;
  document.body.append(t);
  setTimeout(() => t.remove(), href ? 8000 : 4000);
}
