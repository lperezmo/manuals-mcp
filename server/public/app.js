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

/** POST to one of the server's endpoints as the signed-in user. */
export async function api(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await token()}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || json.summary || `Request failed (${res.status})`);
  return json;
}

/** Runs one of the 8 tools, exactly as an AI would. */
export const tool = (name, args = {}) => api("/api/tool", { name, args });

const NAV = [
  ["/", "Home"],
  ["/things", "Things"],
  ["/history", "History"],
  ["/connect", "Connect your AI"],
];

function header(current, signedIn) {
  const links = NAV.map(
    ([href, label]) =>
      `<a href="${href}"${href === current ? ' aria-current="page"' : ""}>${label}</a>`,
  ).join("");
  return `<a class="brand" href="/">manuals</a>
    ${signedIn ? `<nav class="nav" aria-label="Main">${links}</nav>` : '<span style="flex:1"></span>'}
    <div class="head-tools">
      <div class="theme-toggle"></div>
      ${signedIn ? '<button type="button" class="quiet small" id="sign-out">Sign out</button>' : ""}
    </div>`;
}

/**
 * Starts a page. Signed in: draws the header and returns the session.
 * Signed out: the home page shows sign-in, other pages go home.
 */
export async function boot(current, { open = false } = {}) {
  const supa = await db();
  const { data } = await supa.auth.getSession();
  const signedIn = Boolean(data.session);
  const top = $("#top");
  top.innerHTML = header(current, signedIn);
  window.dispatchEvent(new Event("manuals:theme-toggle"));
  $("#sign-out")?.addEventListener("click", async () => {
    await supa.auth.signOut();
    location.assign("/");
  });
  if (!signedIn && current !== "/" && !open) {
    location.assign("/");
    return null;
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
          <input id="pw" type="password" autocomplete="current-password" required placeholder="Password">
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
};

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
      .map((m) => {
        const tools = m.tools?.length
          ? `<div class="chips">${[...new Set(m.tools)].map((t) => `<span class="chip ${t === "revise_fact" ? "teal strong" : ""}">${esc(TOOL_NAMES[t] || t)}</span>`).join("")}</div>`
          : "";
        return `<div class="msg ${m.role === "user" ? "user" : "muse"}">${esc(m.content)}${tools}</div>`;
      })
      .join("") + (busy ? '<div class="msg muse muted">Reading…</div>' : "");
  if (!messages.length && !busy) {
    log.innerHTML =
      '<p class="muted small">Ask about anything you own, or tell it something: "I just cleaned the dishwasher filter", "the washer is at 230 washes".</p>';
  }
  log.scrollTop = log.scrollHeight;
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
      <form class="field">
        <label class="sr-only" for="chat-input">Ask or tell</label>
        <input id="chat-input" autocomplete="off" placeholder="Ask or tell">
        <button type="submit">Send</button>
      </form>`;
    document.body.append(drawer);
    $("[data-close]", drawer).addEventListener("click", () => drawer.classList.add("hidden"));
    $("[data-clear]", drawer).addEventListener("click", () => {
      saveChat([]);
      renderChat([]);
    });
    $("form", drawer).addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("#chat-input", drawer);
      const value = input.value.trim();
      input.value = "";
      if (value) send(value, onChange);
    });
  }
  drawer.classList.remove("hidden");
  renderChat(loadChat());
  if (text) send(text, onChange);
  else $("#chat-input", drawer).focus();
}

async function send(text, onChange) {
  const messages = [...loadChat(), { role: "user", content: text }];
  saveChat(messages);
  renderChat(messages, true);
  try {
    const history = messages.map(({ role, content }) => ({
      role,
      content: content.slice(0, 2000),
    }));
    const { reply, tools_used } = await api("/api/chat", { messages: history });
    messages.push({ role: "assistant", content: reply, tools: tools_used });
    if (
      tools_used.some(
        (t) => !["list_items", "ask_manual", "upcoming", "car_seat_status"].includes(t),
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
