/**
 * LeetLive — Client entry point
 *
 * Composition root: restores the persisted session, then wires every
 * feature module together.
 */

import { codePad, btnVisualize, btnMic, btnClearTranscript, btnReset } from "./dom.js";
import { state, loadPersistedState } from "./state.js";
import { initEditor, updateLineNumbers } from "./editor.js";
import { initSolve, initClear, renderSolveData, clearProblem } from "./solution.js";
import { initVisualize, renderViz, resetViz } from "./viz.js";
import { renderTranscriptLog, clearTranscriptLog } from "./transcript.js";
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

initEditor({ onChange: sendLiveContextDebounced });
initSolve({ onSolved: sendLiveContext });
initClear({ onCleared: sendLiveContext });
initVisualize({ onGenerated: sendLiveContext });
initLive();

// Transcript tab's Clear button — the only thing that resets the transcript
btnClearTranscript.addEventListener("click", () => {
  clearTranscriptLog();
  resetTurnBuffers();
  // Let the interviewer know the prior conversation was cleared
  sendLiveContext();
});

// Reset everything — code, solution, visualization, and transcript — to
// start fresh on a new problem
btnReset.addEventListener("click", () => {
  if (!confirm("Reset everything? This clears the code pad, solution, visualization, and interview transcript.")) return;
  clearProblem();
  resetViz();
  clearTranscriptLog();
  resetTurnBuffers();
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

updateLineNumbers();
