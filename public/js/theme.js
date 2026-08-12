/**
 * LeetLive — Light / dark theme
 *
 * The theme lives in a data-theme attribute on <html>; the stylesheet does the
 * rest. An inline script in index.html applies it before first paint, so this
 * module only owns the toggle and the persistence.
 *
 * Until the user picks a theme explicitly we follow the OS setting — including
 * while the page is open, so a system-wide switch at dusk is picked up live.
 */

const STORAGE_KEY = "leetlive_theme";

const btnTheme = document.querySelector("#btn-theme");

function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (btnTheme) {
    btnTheme.title = theme === "light" ? "Switch to dark theme" : "Switch to light theme";
  }
}

export function initTheme() {
  applyTheme(currentTheme());

  btnTheme?.addEventListener("click", () => {
    const next = currentTheme() === "light" ? "dark" : "light";
    try { localStorage.setItem(STORAGE_KEY, next); } catch {}
    applyTheme(next);
  });

  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", (e) => {
    let chosen = null;
    try { chosen = localStorage.getItem(STORAGE_KEY); } catch {}
    if (!chosen) applyTheme(e.matches ? "light" : "dark");
  });
}
