// Shared by every page: Supabase sign-in, the header, calls to the server's
// tools, and the Muse chat drawer. Pages import what they need.

import { couldntFinish, JOB_MAX_MS, readVerdict, withTimeout } from "/jobs.js";

let client;
let config;

export function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

export const $ = (selector, root = document) => root.querySelector(selector);

/**
 * A random id. crypto.randomUUID only exists on HTTPS and localhost, so the
 * local test server opened from a phone over plain http (192.168.1.x) builds
 * one from getRandomValues, which works everywhere.
 */
export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

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

/** Runs one of the 12 tools, exactly as an AI would. */
export const tool = (name, args = {}) => api("/api/tool", { name, args });

const NAV = [
  ["/", "Home", "M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"],
  ["/things", "Things", "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"],
  ["/atlas", "Map", "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14"],
  ["/history", "History", "M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4"],
  ["/connect", "Connect your AI", "M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5"],
];

// Reading preferences, kept in this browser; theme.js applies them on load.
/** The logo: a book in an orbit with a wrench across it. Theme colours, so it follows light, dark and the palette. */
const LOGO = `<svg class="brand-logo" viewBox="0 0 120 120" aria-hidden="true"><defs><mask id="brand-gap" maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="120"><rect width="120" height="120" fill="#fff"></rect><g transform="translate(82 38) rotate(45)"><circle r="18" fill="#000"></circle><path d="M0 7 V62" stroke="#000" stroke-width="18" stroke-linecap="round"></path></g></mask></defs><g mask="url(#brand-gap)"><circle cx="60" cy="60" r="47" fill="none" style="stroke:var(--accent)" stroke-width="8" stroke-dasharray="200 95" stroke-linecap="round" transform="rotate(13 60 60)"></circle><path d="M60 44 C52 38 40 38 32 40 V76 C40 74 52 74 60 80 Z" style="fill:var(--ink)"></path><path d="M60 44 C68 38 80 38 88 40 V76 C80 74 68 74 60 80 Z" style="fill:var(--accent)"></path></g><g transform="translate(82 38) rotate(45)"><path transform="scale(1.2)" d="M-3.6 -11.45 A12 12 0 1 0 3.6 -11.45 L3.6 -3 A3.6 3.6 0 0 1 -3.6 -3 Z" style="fill:var(--coral)"></path><path d="M0 7 V62" style="stroke:var(--coral)" stroke-width="11" stroke-linecap="round"></path></g></svg>`;

const PREFS = {
  "manuals-size": [
    "Text size",
    [
      ["small", "Small"],
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

// Color palettes on top of light and dark; theme.css has each one's tokens.
// The swatch is the palette's accent in light mode.
const PALETTES = [
  ["lavender", "Lavender", "#6a4bc4"],
  ["ocean", "Ocean", "#1f6fb2"],
  ["forest", "Forest", "#2f6b45"],
  ["sunset", "Sunset", "#b4532a"],
  ["rose", "Rose", "#a83e6b"],
];
const DATASET = { "manuals-size": "size", "manuals-font": "font", "manuals-palette": "palette" };

function pref(key) {
  const first = {
    "manuals-size": "normal",
    "manuals-font": "serif",
    "manuals-palette": "lavender",
  }[key];
  try {
    return localStorage.getItem(key) || first;
  } catch {
    return first;
  }
}

function setPref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
  document.documentElement.dataset[DATASET[key]] = value;
}

function header(current, session) {
  const links = NAV.map(
    ([href, label, d]) =>
      `<a href="${href}"${href === current ? ' aria-current="page"' : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg><span>${label}</span></a>`,
  ).join("");
  if (!session) {
    return `<a class="brand" href="/">${LOGO}manuals</a><span style="flex:1"></span><div class="theme-toggle"></div>`;
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
  return `<a class="brand" href="/">${LOGO}manuals</a>
    <nav class="nav" aria-label="Main">${links}</nav>
    <div class="account">
      <button type="button" class="avatar" id="account" aria-haspopup="true" aria-expanded="false" aria-controls="account-menu" aria-label="Account and settings">${esc(initial)}</button>
      <div class="menu" id="account-menu" hidden>
        <div class="menu-who"><span class="avatar" aria-hidden="true">${esc(initial)}</span><div><strong>Signed in</strong><span class="small muted">${esc(email)}</span></div></div>
        <div class="menu-row"><span>Theme</span><div class="theme-toggle"></div></div>
        <div class="menu-row"><span>Color</span><div class="swatches" role="group" aria-label="Color">${PALETTES.map(
          ([value, name, hex]) =>
            `<button type="button" data-pref="manuals-palette" data-value="${value}" aria-pressed="${pref("manuals-palette") === value}" aria-label="${name}" title="${name}" style="--swatch:${hex}"></button>`,
        ).join("")}</div></div>
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
  if (data.session) {
    startWatching();
    // Signs the household's thing photos while the page loads its data.
    loadItemPhotos();
  }
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
  mark_photo: "Marked your photo",
  show_diagram: "Showed the manual's drawing",
  list_items: "Looked at your things",
  ask_manual: "Read the manual",
  upcoming: "Checked what's coming up",
  revise_fact: "Revised a fact",
  check_flagged: "Read the pages again",
  look_up_online: "Looked it up online",
  check_recalls: "Checked for recalls",
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
const QUIET_TOOLS = new Set(["show_card", "fast_lane"]);
const HISTORY_ICON =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l3 2"></path></svg>';
const CAMERA_ICON =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"></path><circle cx="12" cy="13" r="3.5"></circle></svg>';
// The photo waiting to be sent: the full image for Muse and a small one for the bubble.
let pendingPhoto = null;

// Chats live on this device (they survive closing the app): the newest 20,
// 30 messages each. CURRENT_KEY says which one is open.
const CHATS_KEY = "manuals-chats";
const CURRENT_KEY = "manuals-chat-current";

function loadChats() {
  try {
    const chats = JSON.parse(localStorage.getItem(CHATS_KEY) || "null");
    if (Array.isArray(chats)) return chats;
    // Once: bring over the chat kept in this tab before chats were saved.
    const old = JSON.parse(sessionStorage.getItem(CHAT_KEY) || "[]");
    if (!old.length) return [];
    const id = uuid();
    localStorage.setItem(CURRENT_KEY, id);
    return [{ id, updated: new Date().toISOString(), messages: old }];
  } catch {
    return [];
  }
}

function storeChats(chats) {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats.slice(0, 20)));
  } catch {}
}

function currentChat() {
  try {
    return localStorage.getItem(CURRENT_KEY);
  } catch {
    return null;
  }
}

function openChatId(id) {
  try {
    if (id) localStorage.setItem(CURRENT_KEY, id);
    else localStorage.removeItem(CURRENT_KEY);
  } catch {}
}

function loadChat() {
  const id = currentChat();
  return (id && loadChats().find((c) => c.id === id)?.messages) || [];
}

const MARKED_KEPT = 3;
// What the open chat was opened for: its thing (kept on a new chat), the chips an empty one offers, and who to tell of changes.
let nextAbout = null;
let chatStarters = [];
let chatChange = null;

/** Saves the open chat and moves it to the top of the list; an empty one isn't kept. */
function saveChat(messages, id = currentChat()) {
  if (!messages.length) return;
  const chatId = id || uuid();
  if (!id) openChatId(chatId);
  const all = loadChats();
  const before = all.find((c) => c.id === chatId);
  const title = before?.title;
  const about = before?.about ?? (id ? null : nextAbout);
  const others = all.filter((c) => c.id !== chatId);
  // Marked photos are a few hundred KB each: keep the last few, so the chats still fit in storage.
  const kept = messages.slice(-30);
  let photos = 0;
  for (let i = kept.length - 1; i >= 0; i--) {
    if ((kept[i].marked || kept[i].diagram) && ++photos > MARKED_KEPT)
      kept[i] = { ...kept[i], marked: undefined, diagram: undefined, markedGone: true };
  }
  storeChats([
    {
      id: chatId,
      updated: new Date().toISOString(),
      messages: kept,
      ...(title ? { title } : {}),
      ...(about ? { about } : {}),
    },
    ...others,
  ]);
}

const PENCIL_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"></path></svg>';
const TRASH_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path></svg>';

const chatTitle = (c) => c.title || c.messages.find((m) => m.role === "user")?.content || "A chat";

/** The chat list: each chat by its name (or first question), newest first, with rename and delete. */
function renderChatList(editing = null) {
  const log = $(".chat-log", drawer);
  const chats = loadChats();
  log.innerHTML = chats.length
    ? `<div class="row" style="justify-content:space-between;align-items:center"><p class="small muted" style="margin:0">Previous chats</p><button type="button" class="link small" data-chat-clear>Delete all</button></div>${chats
        .map((c) => {
          const name = esc(chatTitle(c).slice(0, 90));
          const main =
            c.id === editing
              ? `<form class="chat-rename" data-rename-form="${esc(c.id)}"><label class="sr-only" for="chat-rename-input">Chat name</label><input id="chat-rename-input" value="${name}" maxlength="90" autocomplete="off"><button type="submit" class="small">Save</button></form>`
              : `<button type="button" class="chat-pick${c.id === currentChat() ? " open" : ""}" data-chat="${esc(c.id)}"><span class="chat-name">${name}</span><span class="small muted">${esc(ago(c.updated))}</span></button>`;
          return `<div class="chat-row">${main}${
            c.id === editing
              ? ""
              : `<button type="button" class="quiet small chat-icon" data-chat-rename="${esc(c.id)}" aria-label="Rename this chat" title="Rename">${PENCIL_ICON}</button><button type="button" class="quiet small chat-icon" data-chat-delete="${esc(c.id)}" aria-label="Delete this chat" title="Delete">${TRASH_ICON}</button>`
          }</div>`;
        })
        .join("")}`
    : '<p class="muted small">No previous chats yet.</p>';
  if (editing) {
    const input = $("#chat-rename-input", drawer);
    input?.focus();
    input?.select();
  }
}

/** Deletes one chat, or all of them; the open one closes into a new chat. */
function deleteChats(id) {
  storeChats(id ? loadChats().filter((c) => c.id !== id) : []);
  if (!id || id === currentChat()) openChatId(null);
}

let drawer;

function renderChat(messages, busy) {
  const log = $(".chat-log", drawer);
  log.innerHTML =
    messages
      .map((m, i) => {
        const shown = [...new Set(m.tools ?? [])].filter((t) => !QUIET_TOOLS.has(t));
        // One quiet line above the answer: what Muse looked at or did, not part of what it said.
        const tools = shown.length
          ? `<div class="msg-tools">${shown.map((t) => `<span${t === "revise_fact" ? ' class="changed"' : ""}>${esc(TOOL_NAMES[t] || t)}</span>`).join(" · ")}</div>`
          : "";
        const card = m.card && !m.answered ? cardForm(m.card, i) : "";
        const photo = m.photo?.startsWith("data:image/")
          ? `<img class="msg-photo" src="${esc(m.photo)}" alt="Your photo">`
          : m.marked?.startsWith("data:image/")
            ? `<a href="#" data-full="${i}" class="msg-marked" aria-label="Your photo, marked by Muse. Open it full size"><img src="${esc(m.marked)}" alt="Your photo with the part circled"></a>`
            : m.diagram?.image?.startsWith("data:image/")
              ? `<figure class="msg-diagram"><a href="#" data-full="${i}" aria-label="The manual's drawing, page ${Number(m.diagram.page)}. Open it full size"><img src="${esc(m.diagram.image)}" alt="Drawing from page ${Number(m.diagram.page)} of the manual${m.diagram.circled ? ", with the part circled" : ""}"></a><figcaption class="small muted">Page ${Number(m.diagram.page)} of your manual${m.diagram.circled ? "" : " · couldn't pinpoint the part"}</figcaption></figure>`
              : m.markedGone
                ? '<p class="small muted" style="margin:0 0 6px">(Picture no longer kept.)</p>'
                : "";
        // An instant answer from a saved line: one tap asks Muse to go further.
        const more =
          m.fast && i === messages.length - 1 && !busy
            ? '<div class="row" style="margin-top:8px"><button type="button" class="quiet small" data-more>Tell me more</button></div>'
            : "";
        return `<div class="msg ${m.role === "user" ? "user" : "muse"}${m.pending ? " muted" : ""}">${tools}${photo}${esc(m.content)}${card}${more}</div>`;
      })
      .join("") + (busy ? '<div class="msg muse muted">Reading…</div>' : "");
  if (!messages.length && !busy) {
    log.innerHTML = chatStarters.length
      ? `<p class="muted small" style="margin:0">Ask anything, or start with:</p><div class="chat-starters">${chatStarters
          .map(
            (st, i) =>
              `<button type="button" class="quiet" data-starter="${i}">${esc(st.label)}</button>`,
          )
          .join("")}</div>`
      : '<p class="muted small">Ask about anything you own, or tell it something: "I just cleaned the dishwasher filter", "the washer is at 230 washes".</p>';
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
    // With a page number, the label and page are enough (the tap brings the answer): a row stays one or two lines on a phone.
    list.innerHTML = found
      .map(
        (s) =>
          `<button type="button" role="option" class="suggest-row"><span class="suggest-item">${esc(s.item)}</span><strong>${esc(s.label)}</strong>${s.page ? `<span class="muted">p. ${s.page}</span>` : `<span>${esc(s.text)}</span>`}${s.unchecked ? '<span class="chip gold strong">Not checked yet</span>' : ""}</button>`,
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
/**
 * Opens the chat drawer and sends `text` if given. With `once`, a message
 * already in this chat (a setup button tapped again) just opens the chat.
 */
/**
 * Opens the chat drawer, sending `text` if given. `once` skips a text the open
 * chat already sent. `own` gives the text a chat of its own: the earlier chat
 * that started with it if there is one, else a new chat, so a setup doesn't
 * drag in (or bloat) whatever was being discussed before.
 */
/**
 * Opens the chat drawer, sending `text` if given. `once` skips a text the open
 * chat already sent; `own` gives the text a chat of its own. `about` opens that
 * thing's latest chat (or a new one for it), and `starters` are the chips an
 * empty chat offers: each sends its text, or with `draft` puts it in the box
 * to finish ("The Washer's counter shows "). `fresh` always starts a new chat
 * (still tagged with `about`), for a job that shouldn't pile onto an old one.
 */
export function openChat(
  text,
  onChange,
  { once = false, own = false, about = null, starters = [], fresh = false } = {},
) {
  chatChange = onChange;
  chatStarters = starters;
  if (fresh) {
    openChatId(null);
    nextAbout = about;
  } else if (about) {
    const latest = loadChats().find((c) => c.about === about);
    openChatId(latest?.id ?? null);
    nextAbout = latest ? null : about;
  } else nextAbout = null;
  if (own && text) {
    const mine = loadChats().find((c) =>
      c.messages.some((m) => m.role === "user" && m.content === text),
    );
    openChatId(mine?.id ?? null);
  }
  if (!drawer) {
    drawer = document.createElement("section");
    drawer.className = "chat";
    drawer.setAttribute("aria-label", "Chat with Muse");
    drawer.innerHTML = `
      <div class="chat-head">
        <button type="button" class="quiet small chat-icon" data-history aria-label="Previous chats" title="Previous chats">${HISTORY_ICON}</button>
        <h2 style="font-size:20px;flex:1">Ask Muse</h2>
        <button type="button" class="quiet small" data-clear>New chat</button>
        <button type="button" class="quiet small" data-close aria-label="Close chat">Close</button>
      </div>
      <div class="chat-log" aria-live="polite"></div>
      <div class="chat-pending" hidden>
        <img alt="Photo to send">
        <button type="button" class="quiet small" data-unphoto aria-label="Remove photo">×</button>
      </div>
      <form class="field">
        <label class="sr-only" for="chat-input">Ask or tell</label>
        <details class="chat-attach-menu">
          <summary class="button quiet chat-attach" title="Add a photo">${CAMERA_ICON}<span class="sr-only">Add a photo</span></summary>
          <div class="chat-attach-pop" role="group" aria-label="Add a photo">
            <label class="button quiet small" for="chat-camera">Take photo</label>
            <label class="button quiet small" for="chat-photo">Choose photo</label>
          </div>
        </details>
        <input id="chat-camera" type="file" accept="image/*" capture="environment" class="sr-only">
        <input id="chat-photo" type="file" accept="image/*" class="sr-only">
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
    // A new chat; the old one stays under Previous chats.
    $("[data-clear]", drawer).addEventListener("click", () => {
      openChatId(null);
      renderChat([]);
      $("#chat-input", drawer).focus();
    });
    $("[data-history]", drawer).addEventListener("click", renderChatList);
    const log = $(".chat-log", drawer);
    log.addEventListener("submit", (e) => {
      const renaming = e.target.closest("form[data-rename-form]");
      if (renaming) {
        e.preventDefault();
        const name = $("#chat-rename-input", drawer).value.trim();
        storeChats(
          loadChats().map((c) =>
            c.id === renaming.dataset.renameForm ? { ...c, title: name || undefined } : c,
          ),
        );
        renderChatList();
        return;
      }
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
      // Full size: browsers won't open a data: URL in a tab, so open it as a blob.
      const full = e.target.closest("[data-full]");
      if (full) {
        e.preventDefault();
        const m = loadChat()[Number(full.dataset.full)];
        const src = m?.marked || m?.diagram?.image;
        if (src)
          fetch(src)
            .then((r) => r.blob())
            .then((b) => window.open(URL.createObjectURL(b), "_blank", "noopener"));
        return;
      }
      // One tap, then a plain confirm, the same as deleting a thing.
      const del = e.target.closest("[data-chat-delete], [data-chat-clear]");
      if (del) {
        const one = del.dataset.chatDelete;
        const name = one
          ? chatTitle(loadChats().find((c) => c.id === one) ?? { messages: [] })
          : "";
        const ask = one
          ? `Delete the chat "${name.slice(0, 60)}"?`
          : "Delete all your previous chats on this device?";
        if (confirm(ask)) {
          deleteChats(one ?? null);
          renderChatList();
        }
        return;
      }
      const starter = e.target.closest("[data-starter]");
      if (starter) {
        const st = chatStarters[Number(starter.dataset.starter)];
        if (!st) return;
        if (st.draft) {
          const input = $("#chat-input", drawer);
          input.value = st.text;
          input.focus();
          input.setSelectionRange(st.text.length, st.text.length);
        } else send(st.text, chatChange ?? onChange);
        return;
      }
      const rename = e.target.closest("[data-chat-rename]");
      if (rename) {
        renderChatList(rename.dataset.chatRename);
        return;
      }
      const pick = e.target.closest("[data-chat]");
      if (pick) {
        openChatId(pick.dataset.chat);
        renderChat(loadChat());
        return;
      }
      if (e.target.closest("[data-more]")) {
        send("Tell me more.", onChange, "more");
        return;
      }
      const form = e.target.closest("[data-skip]")?.closest("form[data-card]");
      if (form) answerCard(Number(form.dataset.card), () => "Skip that for now.", onChange);
    });
    // The camera straight away, or one already in the gallery: Android shows only the gallery without `capture`.
    const pickPhoto = async (e) => {
      $(".chat-attach-menu", drawer).open = false;
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
    };
    $("#chat-camera", drawer).addEventListener("change", pickPhoto);
    $("#chat-photo", drawer).addEventListener("change", pickPhoto);
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
  const past = loadChat();
  renderChat(past);
  for (const m of past) if (m.pending) recoverTurn(m.pending, onChange);
  const sent = once && past.some((m) => m.role === "user" && m.content === text);
  if (text && !sent) send(text, onChange);
  else if (sent) $(".chat-log", drawer).lastElementChild?.scrollIntoView({ block: "end" });
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
  const turn = uuid();
  try {
    const history = messages
      .filter((m) => !m.pending)
      .map(({ role, content, history: remembered, photo: had }) => ({
        role,
        content: (had ? `[photo] ${content}`.trim() : remembered || content).slice(0, 2000),
      }));
    const out = await api("/api/chat", {
      messages: history,
      turn,
      ...(via ? { via } : {}),
      ...(photo ? { image: photo.image } : {}),
    });
    messages.push(assistantMessage(out));
    if (changedSomething(out.tools_used)) onChange?.();
  } catch (err) {
    if (err.dropped) {
      // The phone paused the page (another app, screen off) but the server keeps
      // going and saves the reply under this turn: pick it up when it's there.
      messages.push({ role: "assistant", content: STILL_WORKING, pending: turn });
      saveChat(messages);
      renderChat(messages);
      recoverTurn(turn, onChange);
      return;
    }
    messages.push({ role: "assistant", content: `Sorry, that didn't work: ${err.message}` });
  }
  saveChat(messages);
  renderChat(messages);
}

const STILL_WORKING = "Still working on it. The answer shows up here when it's done.";
const READ_ONLY = [
  "list_items",
  "ask_manual",
  "upcoming",
  "car_seat_status",
  "photo_check",
  "fast_lane",
];
const changedSomething = (tools = []) => tools.some((t) => !READ_ONLY.includes(t));

function assistantMessage({ reply, tools_used, card, fast, history, marked, diagram }) {
  return {
    role: "assistant",
    content: reply,
    tools: tools_used ?? [],
    card,
    ...(fast ? { fast: true } : {}),
    ...(marked ? { marked } : {}),
    ...(diagram ? { diagram } : {}),
    history,
  };
}

const recovering = new Set();

/** Waits for a dropped turn's saved reply (up to 3 minutes) and puts it in the chat. */
async function recoverTurn(turn, onChange) {
  if (recovering.has(turn)) return;
  recovering.add(turn);
  const until = Date.now() + 3 * 60_000;
  try {
    const supa = await db();
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 3000));
      const { data } = await supa
        .from("model_runs")
        .select("raw_output")
        .eq("kind", "chat")
        .like("raw_output", `%${turn}%`)
        .limit(1)
        .maybeSingle();
      let saved = null;
      try {
        saved = JSON.parse(data?.raw_output ?? "null");
      } catch {}
      if (saved?.turn !== turn) continue;
      settleTurn(
        turn,
        saved.error
          ? { role: "assistant", content: `Sorry, that didn't work: ${saved.error}` }
          : assistantMessage(saved),
      );
      if (!saved.error && changedSomething(saved.tools_used)) onChange?.();
      return;
    }
    settleTurn(turn, {
      role: "assistant",
      content: "Sorry, that answer got lost on the way. Ask again?",
    });
  } catch {
    recovering.delete(turn);
  }
}

function settleTurn(turn, message) {
  recovering.delete(turn);
  // The turn may belong to a chat that isn't the open one any more.
  const chat = loadChats().find((c) => c.messages.some((m) => m.pending === turn));
  if (!chat) return;
  const messages = chat.messages.map((m) => (m.pending === turn ? message : m));
  saveChat(messages, chat.id);
  if (chat.id === currentChat() && drawer && !drawer.classList.contains("hidden"))
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

/**
 * A thing's badge, as HTML: its photo when it has one, else its tinted icon.
 * Before the photos are signed it draws the icon and swaps the photo in after.
 */
export function itemIcon(item, size = 44) {
  const url = item?.id ? photos?.get(item.id)?.url : null;
  if (url)
    return `<span class="icon-badge photo" style="--s:${size}px" aria-hidden="true">${photoImg(url)}</span>`;
  if (!photos && item?.id) loadItemPhotos();
  const mark = item?.id ? ` data-photo-for="${esc(item.id)}"` : "";
  return `<span class="icon-badge ${tintKey(item)}"${mark} style="--s:${size}px" aria-hidden="true">${iconSvg(iconKey(item), Math.round(size * 0.6))}</span>`;
}

// --- Thing photos ------------------------------------------------------------
// A thing can have a real photo (items.photo_path in the private "item-photos"
// bucket) shown instead of its icon. Each page load reads which things have
// one and signs the paths in one batch; signed links are kept in
// sessionStorage until near their expiry, so moving between pages signs
// nothing new.
const PHOTO_BUCKET = "item-photos";
const PHOTO_SIGNED = "manuals-photo-links";
const SIGN_SECONDS = 3600;
const PHOTO_PX = 512;
let photos = null; // item id -> { path, url }; null until loaded
let photosLoading = null;
let photosReady = false; // false where the database has no photo_path yet

const photoImg = (url) => `<img src="${esc(url)}" alt="" decoding="async">`;

function readSigned() {
  try {
    return JSON.parse(sessionStorage.getItem(PHOTO_SIGNED)) ?? {};
  } catch {
    return {};
  }
}

function keepSigned(map) {
  try {
    sessionStorage.setItem(
      PHOTO_SIGNED,
      JSON.stringify(Object.fromEntries([...map.values()].map((p) => [p.path, p]))),
    );
  } catch {}
}

/** Signs the paths with no link, or one about to run out, in one call. */
async function signPaths(supa, paths) {
  const cached = readSigned();
  const soon = Date.now() + 10 * 60 * 1000;
  const out = {};
  const need = [];
  for (const path of paths) {
    if (cached[path]?.exp > soon) out[path] = cached[path];
    else need.push(path);
  }
  if (need.length) {
    const { data } = await supa.storage.from(PHOTO_BUCKET).createSignedUrls(need, SIGN_SECONDS);
    const exp = Date.now() + SIGN_SECONDS * 1000;
    for (const s of data ?? [])
      if (s.signedUrl && !s.error) out[s.path] = { path: s.path, url: s.signedUrl, exp };
  }
  return out;
}

/** Puts photos into icons drawn before they were signed. */
function fillPhotos() {
  for (const el of document.querySelectorAll("[data-photo-for]")) {
    const url = photos?.get(el.dataset.photoFor)?.url;
    if (!url) continue;
    el.className = "icon-badge photo";
    el.innerHTML = photoImg(url);
  }
}

/**
 * Which things have a photo, with signed links, once per page load. Resolves
 * to the map (item id -> { path, url }), or null where photos aren't set up.
 */
export function loadItemPhotos() {
  photosLoading ??= (async () => {
    const supa = await db();
    const { data, error } = await supa
      .from("items")
      .select("id, photo_path")
      .not("photo_path", "is", null);
    photosReady = !error;
    const rows = data ?? [];
    const signed = rows.length
      ? await signPaths(
          supa,
          rows.map((r) => r.photo_path),
        )
      : {};
    photos = new Map(
      rows.filter((r) => signed[r.photo_path]).map((r) => [r.id, signed[r.photo_path]]),
    );
    keepSigned(photos);
    fillPhotos();
    return photosReady ? photos : null;
  })().catch(() => {
    photos = new Map();
    return null;
  });
  return photosLoading;
}

/**
 * Sets a thing's photo from a picked file (shrunk to about 512 px, JPEG), or
 * takes it away with `null`. The old picture is removed from storage either way.
 */
export async function setItemPhoto(item, file) {
  const supa = await db();
  const { data: row, error: readError } = await supa
    .from("items")
    .select("household_id, photo_path")
    .eq("id", item.id)
    .maybeSingle();
  if (readError || !row) throw new Error(readError?.message ?? "That thing is gone.");
  let path = null;
  if (file) {
    const blob = await (await fetch(await shrink(file, PHOTO_PX))).blob();
    path = `${row.household_id}/${item.id}-${Date.now()}.jpg`;
    const up = await supa.storage
      .from(PHOTO_BUCKET)
      .upload(path, blob, { contentType: "image/jpeg" });
    if (up.error) throw new Error(`The photo didn't upload: ${up.error.message}`);
  }
  const { error } = await supa.from("items").update({ photo_path: path }).eq("id", item.id);
  if (error) {
    if (path) await supa.storage.from(PHOTO_BUCKET).remove([path]);
    throw new Error(error.message);
  }
  if (row.photo_path) await supa.storage.from(PHOTO_BUCKET).remove([row.photo_path]);
  await loadItemPhotos();
  if (path) {
    const signed = await signPaths(supa, [path]);
    if (signed[path]) photos.set(item.id, signed[path]);
  } else {
    photos.delete(item.id);
  }
  keepSigned(photos);
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

// --- A child: name, birthday, height and weight -----------------------------
// One sheet for every place a child shows (Atlas, a car seat, Household). It
// saves straight to the household's tables. Heights and weights are kept in cm
// and kg and typed in the units picked here, remembered on this device.
const KID_UNITS_KEY = "manuals-kid-units";
const CM_PER_IN = 2.54;
const KG_PER_LB = 0.45359237;
function kidUnits() {
  try {
    const u = localStorage.getItem(KID_UNITS_KEY);
    if (u === "metric" || u === "us") return u;
  } catch {}
  return /^en-US$/i.test(navigator.language) ? "us" : "metric";
}
const round1 = (n) => Math.round(n * 10) / 10;
/** A saved height and weight in the picked units, e.g. "36.2 in · 30.9 lb". */
export function kidSize(m, units = kidUnits()) {
  if (!m) return "";
  const us = units === "us";
  const h =
    m.height_cm == null
      ? ""
      : us
        ? `${round1(Number(m.height_cm) / CM_PER_IN)} in`
        : `${Number(m.height_cm)} cm`;
  const w =
    m.weight_kg == null
      ? ""
      : us
        ? `${round1(Number(m.weight_kg) / KG_PER_LB)} lb`
        : `${Number(m.weight_kg)} kg`;
  return [h, w].filter(Boolean).join(" · ");
}

/**
 * Opens the sheet for one child (or, with no id, for adding one). `seatId`
 * puts a newly added child on that car seat; `onChange` runs after a save.
 */
export async function openKid(childId, { onChange, seatId } = {}) {
  const supa = await db();
  let kid = null;
  let past = [];
  if (childId) {
    const [k, m] = await Promise.all([
      supa.from("children").select("id, nickname, birth_date").eq("id", childId).maybeSingle(),
      supa
        .from("measurements")
        .select("id, measured_on, height_cm, weight_kg")
        .eq("child_id", childId)
        .order("measured_on", { ascending: false })
        .limit(12),
    ]);
    if (k.error || !k.data) return toast(k.error?.message ?? "That child isn't saved anymore.");
    kid = k.data;
    past = m.data ?? [];
  }
  let units = kidUnits();
  const dialog = document.createElement("dialog");
  dialog.className = "sheet";
  dialog.setAttribute("aria-label", kid ? `About ${kid.nickname}` : "Add a child");
  const unitLabel = () => (units === "us" ? ["in", "lb"] : ["cm", "kg"]);
  /** What's typed in a field, in cm or kg: the kept exact value while the shown one is untouched. */
  const exactMetric = (input, name) => {
    if (!input.value) return null;
    if (input.dataset.shown === input.value && input.dataset.metric)
      return Number(input.dataset.metric);
    const per = name === "height" ? CM_PER_IN : KG_PER_LB;
    return units === "us" ? Number(input.value) * per : Number(input.value);
  };
  const pastRow = (m) =>
    `<li><span>${esc(new Date(`${m.measured_on}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }))}</span><span class="muted">${esc(kidSize(m, units))}</span><button type="button" class="link small" data-unmeasure="${m.id}" aria-label="Remove the ${esc(m.measured_on)} measurement">Remove</button></li>`;
  dialog.innerHTML = `<div class="sheet-grip" aria-hidden="true"></div>
    <form class="kid-form">
      <h2 style="font-size:22px;margin:0">${kid ? esc(kid.nickname) : "Add a child"}</h2>
      <label class="kid-field"><span class="small muted">Name or nickname</span>
        <input name="nickname" required maxlength="60" autocomplete="off" value="${esc(kid?.nickname ?? "")}"></label>
      <label class="kid-field"><span class="small muted">Birthday (for seats with a minimum age)</span>
        <input name="birth_date" type="date" max="${today()}" value="${esc(kid?.birth_date ?? "")}"></label>
      <div class="kid-field">
        <div class="row" style="justify-content:space-between;align-items:center">
          <strong>${past.length ? "New height and weight" : "Height and weight"}</strong>
          <div class="kid-units" role="group" aria-label="Units">
            <button type="button" class="quiet small" data-units="metric" aria-pressed="${units === "metric"}">cm · kg</button>
            <button type="button" class="quiet small" data-units="us" aria-pressed="${units === "us"}">in · lb</button>
          </div>
        </div>
        <div class="kid-pair">
          <label class="kid-field"><span class="small muted">Height (<span data-u="0">${unitLabel()[0]}</span>)</span><input name="height" type="number" inputmode="decimal" step="0.1" min="0"></label>
          <label class="kid-field"><span class="small muted">Weight (<span data-u="1">${unitLabel()[1]}</span>)</span><input name="weight" type="number" inputmode="decimal" step="0.1" min="0"></label>
        </div>
        <label class="kid-field"><span class="small muted">Measured on</span><input name="measured_on" type="date" max="${today()}" value="${today()}"></label>
        <span class="small muted">Car seat pages compare the newest numbers with the seat's limits.</span>
      </div>
      ${past.length ? `<div class="kid-field"><strong>Saved before</strong><ul class="kid-past">${past.map(pastRow).join("")}</ul></div>` : ""}
      <div class="row" style="gap:10px">
        <button type="submit" style="flex:1">Save</button>
        <button type="button" class="quiet" data-cancel style="flex:1">Cancel</button>
      </div>
      ${kid ? `<button type="button" class="link small danger" data-unkid>Remove ${esc(kid.nickname)}</button>` : ""}
    </form>`;
  document.body.append(dialog);
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  const form = $("form", dialog);
  dialog.addEventListener("cancel", close);
  dialog.addEventListener("click", async (e) => {
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        return close();
    }
    if (e.target.closest("[data-cancel]")) return close();
    const pick = e.target.closest("[data-units]");
    if (pick && pick.dataset.units !== units) {
      // Switching units converts whatever is typed, always from the exact
      // metric value, so switching back and forth never drifts.
      const toUs = pick.dataset.units === "us";
      for (const name of ["height", "weight"]) {
        const input = form.elements[name];
        const metric = exactMetric(input, name);
        if (metric == null) continue;
        const per = name === "height" ? CM_PER_IN : KG_PER_LB;
        input.value = String(round1(toUs ? metric / per : metric));
        input.dataset.metric = String(metric);
        input.dataset.shown = input.value;
      }
      units = pick.dataset.units;
      try {
        localStorage.setItem(KID_UNITS_KEY, units);
      } catch {}
      for (const b of dialog.querySelectorAll("[data-units]"))
        b.setAttribute("aria-pressed", String(b.dataset.units === units));
      for (const s of dialog.querySelectorAll("[data-u]"))
        s.textContent = unitLabel()[Number(s.dataset.u)];
      const list = $(".kid-past", dialog);
      if (list) list.innerHTML = past.map(pastRow).join("");
      return;
    }
    const gone = e.target.closest("[data-unmeasure]");
    if (gone) {
      gone.disabled = true;
      const { error } = await supa.from("measurements").delete().eq("id", gone.dataset.unmeasure);
      if (error) {
        gone.disabled = false;
        return toast(error.message);
      }
      past = past.filter((m) => m.id !== gone.dataset.unmeasure);
      gone.closest("li").remove();
      onChange?.();
      return;
    }
    if (e.target.closest("[data-unkid]")) {
      if (!confirm(`Remove ${kid.nickname}? Their measurements go too; their car seats stay.`))
        return;
      const { error } = await supa.from("children").delete().eq("id", kid.id);
      if (error) return toast(error.message);
      close();
      toast(`${kid.nickname} is removed.`);
      onChange?.();
    }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = form.elements;
    const nickname = f.nickname.value.trim();
    const birth = f.birth_date.value || null;
    const us = units === "us";
    const exactH = exactMetric(f.height, "height");
    const exactW = exactMetric(f.weight, "weight");
    const height = exactH == null ? null : round1(exactH);
    const weight = exactW == null ? null : Math.round(exactW * 100) / 100;
    if (height != null && (height < 30 || height > 200))
      return toast(
        `That height looks off: between ${us ? "12 and 78 in" : "30 and 200 cm"}, please.`,
      );
    if (weight != null && (weight < 1 || weight > 100))
      return toast(
        `That weight looks off: between ${us ? "2.2 and 220 lb" : "1 and 100 kg"}, please.`,
      );
    const save = $("[type=submit]", dialog);
    save.disabled = true;
    try {
      let id = kid?.id;
      if (!kid) {
        const { data, error } = await supa
          .from("children")
          .insert({ nickname, birth_date: birth })
          .select("id")
          .single();
        if (error) throw error;
        id = data.id;
        if (seatId) {
          const { error: e2 } = await supa.from("items").update({ child_id: id }).eq("id", seatId);
          if (e2) throw e2;
        }
      } else if (nickname !== kid.nickname || birth !== (kid.birth_date ?? null)) {
        const { error } = await supa
          .from("children")
          .update({ nickname, birth_date: birth })
          .eq("id", id);
        if (error) throw error;
      }
      if (height != null || weight != null) {
        const { error } = await supa.from("measurements").insert({
          child_id: id,
          measured_on: f.measured_on.value || today(),
          height_cm: height,
          weight_kg: weight,
          source: "app",
        });
        if (error) throw error;
      }
      close();
      toast(kid ? "Saved." : `${nickname} is added.`);
      onChange?.();
    } catch (err) {
      save.disabled = false;
      toast(err.message);
    }
  });
  dialog.showModal();
  if (!kid) form.elements.nickname.focus();
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
let watching = false;

// Another tab may finish a job, and a page restored with Back may show an old pill.
window.addEventListener("storage", (e) => {
  if (e.key === JOBS_KEY) drawJobs();
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) startWatching();
});

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
  const [j] = jobs;
  const what =
    jobs.length > 1
      ? `Working on ${jobs.length} manuals`
      : `${j.kind === "read" ? "Reading" : "Finding"} the ${j.label} manual`;
  pill.innerHTML = `<span class="jobs-dot" aria-hidden="true"></span><span class="jobs-text">${esc(what)}…</span><button type="button" class="jobs-close" aria-label="Stop showing this">×</button>`;
  // Stops watching, nothing more: work already on the server finishes or fails on its own.
  pill.querySelector(".jobs-close").addEventListener("click", () => {
    saveJobs([]);
  });
}

/** Is it done? A read is done when its manual is no longer pending or being read; a search when its log entry is in. */
async function checkJob(supa, job) {
  if (job.kind === "read") {
    const [{ data: m, error }, { data: failed }] = await Promise.all([
      supa
        .from("manuals")
        .select("status, status_detail, reading_since")
        .eq("item_id", job.item)
        .gte("updated_at", job.since)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      // A download that failed (a site that blocks apps) leaves no manual, only this log entry.
      supa
        .from("model_runs")
        .select("error")
        .eq("kind", "read")
        .eq("item_id", job.item)
        .eq("ok", false)
        .is("manual_id", null)
        .gte("created_at", job.since)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (error) throw error;
    return readVerdict(
      m,
      job,
      Date.now(),
      failed ? failed.error || couldntFinish(job.label) : null,
    );
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
  try {
    const supa = await db();
    while (loadJobs().length) {
      await new Promise((r) => setTimeout(r, 4000));
      for (const job of loadJobs()) await settle(supa, job);
    }
  } finally {
    watching = false;
    drawJobs();
  }
}

/** Checks one job, and tells the person once it's over. */
async function settle(supa, job) {
  let done = null;
  try {
    // A request that never answers would otherwise hold the pill up forever.
    done = await withTimeout(checkJob(supa, job));
  } catch {}
  if (!done && Date.now() - Date.parse(job.since) > JOB_MAX_MS) {
    done = {
      text:
        job.kind === "read"
          ? couldntFinish(job.label)
          : `The search for the ${job.label} manual didn't finish. Try again.`,
    };
  }
  if (!done) return;
  // Another tab may have told the person already.
  if (!loadJobs().some((j) => j.kind === job.kind && j.item === job.item)) return;
  forgetJob(job.kind, job.item);
  const here =
    location.pathname === "/things" && new URLSearchParams(location.search).get("id") === job.item;
  notify(done.text, here ? null : `/things?id=${job.item}`);
  window.dispatchEvent(new CustomEvent("manuals:job-done", { detail: job }));
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
