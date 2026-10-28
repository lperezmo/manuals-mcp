// Applies the saved theme (light, system or dark) and wires up any
// .theme-toggle on the page. Runs in <head> so the page never flashes.
(() => {
  const KEY = "manuals-theme";
  const read = () => {
    try {
      return localStorage.getItem(KEY) || "system";
    } catch {
      return "system";
    }
  };
  const apply = (mode) => {
    if (mode === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", mode);
    for (const b of document.querySelectorAll(".theme-toggle button")) {
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    }
  };
  apply(read());

  const ICONS = {
    light:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
    system:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M12 6.5a5.5 5.5 0 0 0 0 11z" fill="currentColor" stroke="none"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  };
  const LABELS = { light: "Light", system: "Match system", dark: "Dark" };

  // Builds any toggle on the page that has no buttons yet; pages that draw
  // their header later fire "manuals:theme-toggle" to get theirs.
  const build = () => {
    for (const holder of document.querySelectorAll(".theme-toggle:empty")) {
      holder.setAttribute("role", "group");
      holder.setAttribute("aria-label", "Theme");
      for (const mode of ["light", "system", "dark"]) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.mode = mode;
        b.title = LABELS[mode];
        b.setAttribute("aria-label", LABELS[mode]);
        b.innerHTML = ICONS[mode];
        b.addEventListener("click", () => {
          try {
            localStorage.setItem(KEY, mode);
          } catch {}
          apply(mode);
        });
        holder.append(b);
      }
    }
    apply(read());
  };
  document.addEventListener("DOMContentLoaded", build);
  window.addEventListener("manuals:theme-toggle", build);
})();
