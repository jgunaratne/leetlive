/**
 * LeetLive — Solve panel
 *
 * Calls /api/solve, renders the reference solution, and owns the code-pad
 * Clear button (which clears the problem, not the interview transcript).
 */

import {
  codePad,
  btnSolve,
  btnClear,
  btnVisualize,
  btnGeminiLive,
  solutionPlaceholder,
  solutionLoading,
  solutionCode,
  solutionExplanation,
  timeBadge,
  spaceBadge,
  timeValue,
  spaceValue,
  problemBadge,
  badgeDifficulty,
  badgeName,
  badgeCategory,
} from "./dom.js";
import { state, saveState } from "./state.js";
import { escapeHtml } from "./util.js";
import { updateLineNumbers } from "./editor.js";

// Renders solve results into the Solution tab. Shared by the Solve button
// and session restore on page load.
export function renderSolveData(data) {
  state.currentSolveData = data;
  state.currentSolution = data.solution;
  state.currentProblemName = data.problemName;

  solutionPlaceholder.classList.add("hidden");
  solutionLoading.classList.add("hidden");
  solutionCode.classList.remove("hidden");
  solutionCode.querySelector("code").textContent = data.solution;

  if (data.explanation || data.approach) {
    solutionExplanation.classList.remove("hidden");
    solutionExplanation.innerHTML = `
      <strong>Approach:</strong> ${escapeHtml(data.approach || "")}<br><br>
      ${escapeHtml(data.explanation || "")}
    `;
  }

  if (data.timeComplexity) {
    timeValue.textContent = data.timeComplexity;
    timeBadge.classList.remove("hidden");
  }
  if (data.spaceComplexity) {
    spaceValue.textContent = data.spaceComplexity;
    spaceBadge.classList.remove("hidden");
  }

  if (data.problemName) {
    badgeName.textContent = data.problemName;
    badgeDifficulty.textContent = data.difficulty || "Medium";
    badgeDifficulty.className = `badge-difficulty ${(data.difficulty || "Medium").toLowerCase()}`;
    badgeCategory.textContent = data.category || "";
    problemBadge.classList.remove("hidden");
  }

  btnVisualize.disabled = false;
  btnGeminiLive.disabled = false;
}

let _onSolved = null;

export async function triggerSolve() {
  const stub = codePad.value.trim();
  if (!stub) return;

  solutionPlaceholder.classList.add("hidden");
  solutionCode.classList.add("hidden");
  solutionExplanation.classList.add("hidden");
  solutionLoading.classList.remove("hidden");
  timeBadge.classList.add("hidden");
  spaceBadge.classList.add("hidden");
  btnSolve.disabled = true;

  try {
    const res = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codeStub: stub }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to solve");
    }

    const data = await res.json();
    renderSolveData(data);
    saveState();
    _onSolved?.();
  } catch (err) {
    solutionLoading.classList.add("hidden");
    solutionPlaceholder.classList.remove("hidden");
    solutionPlaceholder.innerHTML = `
      <p style="color: var(--color-error)">${escapeHtml(err.message)}</p>
    `;
  } finally {
    btnSolve.disabled = false;
  }
}

export function initSolve({ onSolved } = {}) {
  _onSolved = onSolved || null;
  btnSolve.addEventListener("click", () => triggerSolve());
}

// Clears the code pad, solve results, and problem badge back to the initial
// state. Does NOT touch the transcript — that has its own Clear button.
export function clearProblem() {
  codePad.value = "";
  state.currentSolution = null;
  state.currentProblemName = null;
  state.currentSolveData = null;
  state.currentVizHtml = null;

  solutionCode.classList.add("hidden");
  solutionExplanation.classList.add("hidden");
  solutionLoading.classList.add("hidden");
  timeBadge.classList.add("hidden");
  spaceBadge.classList.add("hidden");
  problemBadge.classList.add("hidden");
  solutionPlaceholder.classList.remove("hidden");
  solutionPlaceholder.innerHTML = `
    <p>Paste a problem stub in the <strong>Coding Pad</strong> and click <strong>Solve</strong> to see the reference solution</p>
  `;
  btnVisualize.disabled = true;
  btnGeminiLive.disabled = true;

  saveState();
  updateLineNumbers();
}

export function initClear({ onCleared } = {}) {
  btnClear.addEventListener("click", () => {
    clearProblem();
    onCleared?.();
  });
}
