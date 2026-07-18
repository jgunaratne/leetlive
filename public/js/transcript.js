/**
 * LeetLive — Interview transcript
 *
 * Live captions in the interview panel, plus the persistent transcript log
 * on the Transcript tab. The log survives disconnects, reconnects, and page
 * reloads; it only resets from its own Clear button.
 */

import { transcript, transcriptLog } from "./dom.js";
import { state, saveState } from "./state.js";
import { escapeHtml } from "./util.js";

const TRANSCRIPT_EMPTY_HTML = `
    <div class="transcript-log-empty">
      <p>Start a mock interview to see the conversation transcript here.</p>
    </div>
  `;

// ── Captions (interview panel) ──────────────────────────────────────────────

export function initCaption() {
  transcript.innerHTML = `
    <div id="caption-user" class="caption caption-user hidden">
      <span class="caption-label">You</span>
      <span class="caption-text"></span>
    </div>
    <div id="caption-interviewer" class="caption caption-interviewer">
      <span class="caption-label">Interviewer</span>
      <span class="caption-text">Connected</span>
    </div>
  `;
}

export function updateCaption(role, text) {
  const id = role === "user" ? "caption-user" : "caption-interviewer";
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("hidden");
  el.querySelector(".caption-text").textContent = text;
  transcript.parentElement.scrollTop = transcript.parentElement.scrollHeight;
}

// ── Transcript log (Transcript tab) ─────────────────────────────────────────

function renderTranscriptEntry({ role, text, time }) {
  const entry = document.createElement("div");
  entry.className = `tlog-entry tlog-${role}`;
  const label = role === "user" ? "You" : "Interviewer";
  entry.innerHTML = `
    <div class="tlog-meta">
      <span class="tlog-label">${escapeHtml(label)}</span>
      <span class="tlog-time">${escapeHtml(time)}</span>
    </div>
    <div class="tlog-text">${escapeHtml(text)}</div>
  `;
  transcriptLog.appendChild(entry);
}

export function renderTranscriptLog() {
  transcriptLog.innerHTML = state.transcriptHistory.length ? "" : TRANSCRIPT_EMPTY_HTML;
  state.transcriptHistory.forEach(renderTranscriptEntry);
  transcriptLog.scrollTop = transcriptLog.scrollHeight;
}

export function appendToTranscriptLog(role, text) {
  if (!text || !text.trim()) return;

  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const item = { role, text: text.trim(), time };
  state.transcriptHistory.push(item);
  saveState();

  const empty = transcriptLog.querySelector(".transcript-log-empty");
  if (empty) empty.remove();

  renderTranscriptEntry(item);
  transcriptLog.scrollTop = transcriptLog.scrollHeight;
}

export function clearTranscriptLog() {
  state.transcriptHistory = [];
  renderTranscriptLog();
  saveState();
}
