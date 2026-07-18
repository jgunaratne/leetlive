/**
 * LeetLive — Session History Sidebar
 *
 * Manages the hamburger-menu sidebar that lists past sessions,
 * lets the user switch between them, and persists work via the API.
 */

import { codePad } from "./dom.js";
import { state, saveState, loadPersistedState } from "./state.js";
import { escapeHtml } from "./util.js";

/* ── DOM references ─────────────────────────────────────────────────── */
const sidebarOverlay = document.querySelector("#sidebar-overlay");
const sidebar = document.querySelector("#history-sidebar");
const btnHamburger = document.querySelector("#btn-hamburger");
const btnCloseSidebar = document.querySelector("#btn-close-sidebar");
const sessionList = document.querySelector("#session-list");
const btnClearHistory = document.querySelector("#btn-clear-history");

/* ── State ──────────────────────────────────────────────────────────── */
let currentSessionId = null;
let _onSessionLoaded = null;
let _onNewSession = null;

/* ── Sidebar open / close ───────────────────────────────────────────── */
function openSidebar() {
  document.body.classList.add("sidebar-open");
  renderSessionList();
}

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
}

/* ── API helpers ────────────────────────────────────────────────────── */
async function fetchSessions() {
  const res = await fetch("/api/sessions");
  return res.json();
}

async function renderSessionList() {
  const sessions = await fetchSessions();

  if (!sessions || sessions.length === 0) {
    sessionList.innerHTML =
      '<div class="session-list-empty">No saved sessions yet</div>';
    return;
  }

  sessionList.innerHTML = sessions
    .map((s) => {
      const name = s.problem_name ? escapeHtml(s.problem_name) : "Untitled Session";
      const diff = (s.difficulty || "").toLowerCase();
      const date = new Date(s.updated_at || s.created_at).toLocaleDateString();
      const active = s.id === currentSessionId ? " session-entry-active" : "";

      return `
        <div class="session-entry${active}" data-id="${s.id}">
          <span class="difficulty-dot ${diff}"></span>
          <div class="session-info">
            <div class="session-name">${name}</div>
            <div class="session-meta">${escapeHtml(date)}</div>
          </div>
          <button class="session-delete" data-delete-id="${s.id}" title="Delete session">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>`;
    })
    .join("");

  /* Wire click handlers */
  sessionList.querySelectorAll(".session-entry").forEach((el) => {
    el.addEventListener("click", (e) => {
      /* Ignore clicks on the delete button */
      if (e.target.closest(".session-delete")) return;
      loadSession(el.dataset.id);
    });
  });

  sessionList.querySelectorAll(".session-delete").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteSession(btn.dataset.deleteId);
      await renderSessionList();
    });
  });
}

/* ── Session CRUD ───────────────────────────────────────────────────── */
async function loadSession(id) {
  const res = await fetch(`/api/sessions/${id}`);
  const session = await res.json();

  currentSessionId = id;
  codePad.value = session.code || "";

  let solveData = {};
  try {
    solveData = JSON.parse(session.solve_data || "{}");
  } catch {
    solveData = {};
  }

  if (_onSessionLoaded) {
    _onSessionLoaded(session);
  }

  closeSidebar();
}

async function saveCurrentSession() {
  if (!currentSessionId) return;

  const body = {
    problem_name: state.currentProblemName || "",
    difficulty: state.currentSolveData?.difficulty || "",
    category: state.currentSolveData?.category || "",
    code: codePad.value,
    solve_data: JSON.stringify(state.currentSolveData || {}),
    viz_html: state.currentVizHtml || "",
    transcript_history: JSON.stringify(state.transcriptHistory || []),
    timer_seconds: 0,
  };

  await fetch(`/api/sessions/${currentSessionId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function deleteSession(id) {
  await fetch(`/api/sessions/${id}`, { method: "DELETE" });
  if (id === currentSessionId) {
    startNewSession();
  }
}

async function clearAllHistory() {
  if (!confirm("Delete all saved sessions? This cannot be undone.")) return;
  await fetch("/api/sessions", { method: "DELETE" });
  startNewSession();
}

/* ── New session ────────────────────────────────────────────────────── */
function startNewSession() {
  currentSessionId = crypto.randomUUID();
  if (_onNewSession) _onNewSession();
}

function getCurrentSessionId() {
  return currentSessionId;
}

/* ── Initialisation ─────────────────────────────────────────────────── */
export function initHistory(opts = {}) {
  _onSessionLoaded = opts.onSessionLoaded || null;
  _onNewSession = opts.onNewSession || null;

  currentSessionId = crypto.randomUUID();

  btnHamburger.addEventListener("click", openSidebar);
  btnCloseSidebar.addEventListener("click", closeSidebar);
  sidebarOverlay.addEventListener("click", closeSidebar);
  btnClearHistory.addEventListener("click", clearAllHistory);

  const btnNewSession = document.querySelector("#btn-new-session");
  if (btnNewSession) {
    btnNewSession.addEventListener("click", () => {
      startNewSession();
      closeSidebar();
    });
  }
}

export { saveCurrentSession, startNewSession, getCurrentSessionId };
