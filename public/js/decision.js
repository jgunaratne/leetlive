/**
 * LeetLive — Decision panel
 *
 * Calls /api/decision with the coding pad code and transcript text, then
 * renders a rich hiring-decision card with verdict, level, strengths,
 * weaknesses, improvement tips, and dimensional breakdowns.
 */

import { codePad } from "./dom.js";
import { state } from "./state.js";
import { escapeHtml } from "./util.js";

const btnDecision = document.getElementById("btn-decision");
const decisionPlaceholder = document.getElementById("decision-placeholder");
const decisionLoading = document.getElementById("decision-loading");
const decisionResult = document.getElementById("decision-result");

// ── Decision badge color mapping ────────────────────────────────────────────

const DECISION_META = {
  "Hire":         { className: "decision-hire",         icon: "✓", label: "Hire" },
  "Lean Hire":    { className: "decision-lean-hire",    icon: "↗", label: "Lean Hire" },
  "Borderline":   { className: "decision-borderline",   icon: "—", label: "Borderline" },
  "Lean No Hire": { className: "decision-lean-no-hire", icon: "↘", label: "Lean No Hire" },
  "No Hire":      { className: "decision-no-hire",      icon: "✕", label: "No Hire" },
};

// ── Build the transcript text ───────────────────────────────────────────────

function getTranscriptText() {
  if (!state.transcriptHistory || !state.transcriptHistory.length) return "";
  return state.transcriptHistory
    .map((t) => {
      const label = t.role === "user" ? "Candidate" : "Interviewer";
      return `[${label}] ${t.text}`;
    })
    .join("\n");
}

// ── Render helpers ──────────────────────────────────────────────────────────

function renderList(items, className) {
  if (!items || !items.length) return "";
  return `<ul class="${className}">${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`;
}

function renderDimensionCard(title, icon, text) {
  return `
    <div class="decision-dimension">
      <div class="dimension-header">
        <span class="dimension-icon">${icon}</span>
        <span class="dimension-title">${escapeHtml(title)}</span>
      </div>
      <div class="dimension-body">${escapeHtml(text)}</div>
    </div>
  `;
}

function renderDecision(data) {
  const meta = DECISION_META[data.decision] || DECISION_META["Borderline"];

  decisionResult.innerHTML = `
    <!-- Verdict Banner -->
    <div class="decision-verdict ${meta.className}">
      <div class="verdict-icon">${meta.icon}</div>
      <div class="verdict-text">
        <span class="verdict-label">${escapeHtml(meta.label)}</span>
        <span class="verdict-level">${escapeHtml(data.level)}</span>
      </div>
    </div>

    <!-- Summary -->
    <div class="decision-summary">${escapeHtml(data.summary)}</div>

    <!-- Dimensions -->
    <div class="decision-dimensions">
      ${renderDimensionCard("Code Quality", "⌨", data.codeQuality)}
      ${renderDimensionCard("Communication", "💬", data.communication)}
      ${renderDimensionCard("Problem Solving", "🧩", data.problemSolving)}
    </div>

    <!-- Strengths & Weaknesses -->
    <div class="decision-signals">
      <div class="signal-col signal-strengths">
        <h4 class="signal-heading signal-heading-positive">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1l2.2 4.6L15 6.3l-3.5 3.4.8 4.9L8 12.3 3.7 14.6l.8-4.9L1 6.3l4.8-.7z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
          Strengths
        </h4>
        ${renderList(data.strengths, "signal-list")}
      </div>
      <div class="signal-col signal-weaknesses">
        <h4 class="signal-heading signal-heading-negative">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2"/><path d="M8 5v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="11.5" r="0.8" fill="currentColor"/></svg>
          Areas of Concern
        </h4>
        ${renderList(data.weaknesses, "signal-list")}
      </div>
    </div>

    <!-- Improvements -->
    <div class="decision-improvements">
      <h4 class="signal-heading signal-heading-info">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1v14M1 8h14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
        How to Improve
      </h4>
      ${renderList(data.improvements, "signal-list improvements-list")}
    </div>
  `;
}

// ── Init ─────────────────────────────────────────────────────────────────────

export function resetDecision() {
  decisionResult.classList.add("hidden");
  decisionLoading.classList.add("hidden");
  decisionPlaceholder.classList.remove("hidden");
  decisionPlaceholder.innerHTML = `
    <p>Complete a mock interview, then click <strong>Evaluate</strong> to get a hiring decision</p>
  `;
}

export function initDecision() {
  btnDecision.addEventListener("click", async () => {
    const code = codePad.value.trim();
    const transcript = getTranscriptText();

    if (!code && !transcript) {
      decisionPlaceholder.innerHTML = `
        <p style="color: var(--color-warning)">Write some code or complete a mock interview first</p>
      `;
      return;
    }

    decisionPlaceholder.classList.add("hidden");
    decisionResult.classList.add("hidden");
    decisionLoading.classList.remove("hidden");
    btnDecision.disabled = true;

    try {
      const res = await fetch("/api/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, transcript }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to generate decision");
      }

      const data = await res.json();
      decisionLoading.classList.add("hidden");
      decisionResult.classList.remove("hidden");
      renderDecision(data);
    } catch (err) {
      decisionLoading.classList.add("hidden");
      decisionPlaceholder.classList.remove("hidden");
      decisionPlaceholder.innerHTML = `
        <p style="color: var(--color-error)">${escapeHtml(err.message)}</p>
      `;
    } finally {
      btnDecision.disabled = false;
    }
  });
}
