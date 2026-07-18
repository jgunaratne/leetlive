/**
 * LeetLive — Client entry point
 *
 * Composition root: restores the persisted session, then wires every
 * feature module together.
 */

import { codePad, btnVisualize, btnMic, btnClearTranscript, btnReset } from "./dom.js";
import { state, loadPersistedState, saveState } from "./state.js";
import { initEditor, updateLineNumbers } from "./editor.js";
import { initSolve, initClear, renderSolveData, clearProblem } from "./solution.js";
import { initVisualize, renderViz, resetViz } from "./viz.js";
import { renderTranscriptLog, clearTranscriptLog } from "./transcript.js";
import { initDecision, resetDecision } from "./decision.js";
import { initTimer, resetTimer, ensureTimerRunning } from "./timer.js";
import { initHistory, saveCurrentSession, startNewSession } from "./history.js";
import {
  initLive,
  sendLiveContext,
  sendLiveContextDebounced,
  sendAudioChunk,
  resetTurnBuffers,
} from "./live.js";
import { startMic, stopMic, micActive } from "./audio.js";

// ── Tab switching ───────────────────────────────────────────────────────────

const tabBar = document.querySelector("#col1-tabs");
tabBar.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  const tabId = btn.dataset.tab;

  tabBar.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");

  document.querySelectorAll("#col-code .tab-content").forEach((tc) => {
    tc.classList.toggle("active", tc.dataset.tab === tabId);
  });
});

// ── Restore persisted session ───────────────────────────────────────────────

const persisted = loadPersistedState();
if (persisted) {
  // Restore coding pad (support old 'codeStub' key for backward compat)
  if (persisted.codePad || persisted.codeStub) {
    codePad.value = persisted.codePad || persisted.codeStub;
  }

  if (persisted.solveData) {
    renderSolveData(persisted.solveData);
  }

  if (Array.isArray(persisted.transcriptHistory) && persisted.transcriptHistory.length) {
    state.transcriptHistory = persisted.transcriptHistory;
    renderTranscriptLog();
  }

  if (persisted.vizHtml) {
    state.currentVizHtml = persisted.vizHtml;
    renderViz(persisted.vizHtml);
    btnVisualize.disabled = false;
  }
}

// ── Feature wiring ──────────────────────────────────────────────────────────

initEditor({
  onChange: () => {
    sendLiveContextDebounced();
    ensureTimerRunning();
  },
});
initSolve({ onSolved: () => { sendLiveContext(); saveCurrentSession(); } });
initClear({ onCleared: () => { sendLiveContext(); saveCurrentSession(); } });
initVisualize({ onGenerated: () => { sendLiveContext(); saveCurrentSession(); } });
initLive();
initDecision();
initTimer();

// ── History sidebar ─────────────────────────────────────────────────────────

/**
 * Full reset: clears all app state back to initial (but does NOT delete
 * the saved session from the database).
 */
function resetAppState() {
  clearProblem();
  resetViz();
  resetDecision();
  clearTranscriptLog();
  resetTurnBuffers();
  resetTimer();
  updateLineNumbers();
}

/**
 * Restore full app state from a loaded session record.
 */
function restoreFromSession(session) {
  resetAppState();

  codePad.value = session.code || "";
  updateLineNumbers();

  let solveData = null;
  try { solveData = JSON.parse(session.solve_data || "{}"); } catch {}
  if (solveData && solveData.solution) {
    renderSolveData(solveData);
  }

  let transcript = [];
  try { transcript = JSON.parse(session.transcript_history || "[]"); } catch {}
  if (Array.isArray(transcript) && transcript.length) {
    state.transcriptHistory = transcript;
    renderTranscriptLog();
  }

  if (session.viz_html) {
    state.currentVizHtml = session.viz_html;
    renderViz(session.viz_html);
    btnVisualize.disabled = false;
  }

  saveState();
}

initHistory({
  onSessionLoaded: restoreFromSession,
  onNewSession: () => {
    resetAppState();
    saveState();
  },
});

// Transcript tab's Clear button — the only thing that resets the transcript
btnClearTranscript.addEventListener("click", () => {
  clearTranscriptLog();
  resetTurnBuffers();
  sendLiveContext();
  saveCurrentSession();
});

// Reset everything — code, solution, visualization, decision, and transcript —
// to start fresh on a new problem. Also saves the current session before reset
// and starts a new one.
btnReset.addEventListener("click", () => {
  if (!confirm("Reset everything? This clears the code pad, solution, visualization, and interview transcript.")) return;
  // Save current work before clearing
  saveCurrentSession();
  resetAppState();
  // Start a new session for the blank slate
  startNewSession();
  saveState();
  sendLiveContext();
});

// Mic toggle
btnMic.addEventListener("click", () => {
  if (micActive()) {
    stopMic();
  } else {
    startMic(sendAudioChunk);
  }
});

// Auto-save to backend periodically when the user types
let autoSaveTimer = null;
codePad.addEventListener("input", () => {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => saveCurrentSession(), 5000);
});

updateLineNumbers();
