/**
 * LeetLive — Gemini Live session
 *
 * WebSocket lifecycle (connect / disconnect / auto-reconnect), server message
 * handling, and context sync (code, solution, viz, transcript history) to the
 * interviewer. On every reconnect the full transcript history is replayed so
 * the interviewer keeps the whole conversation.
 */

import {
  codePad,
  btnGeminiLive,
  btnCloseLive,
  btnConnectLive,
  btnDisconnectLive,
  btnMic,
  liveStatus,
  statusText,
  transcript,
  liveSyncIndicator,
} from "./dom.js";
import { state } from "./state.js";
import { initCaption, updateCaption, appendToTranscriptLog } from "./transcript.js";
import { playAudio, startMic, stopMic, resetPlayback } from "./audio.js";
import { extractVizDescription } from "./viz.js";
import { triggerSolve } from "./solution.js";

let liveWs = null;
let isManualDisconnect = false;
let autoReconnectTimer = null;
let currentMode = "interview"; // "interview" or "professor"

// Text accumulated for the in-flight interviewer/user turns
let interviewerText = "";
let userText = "";
let shouldResetInterviewer = false;
let shouldResetUser = false;

// Panel title / icon elements
const livePanelTitle = document.getElementById("live-panel-title");
const livePanelIcon = document.getElementById("live-panel-icon");

// ── Connection lifecycle ────────────────────────────────────────────────────

export function connectLive(isUserAction = false) {
  if (liveWs) return;

  if (isUserAction) {
    isManualDisconnect = false;
  }

  statusText.textContent = isUserAction ? "Connecting..." : "Reconnecting...";
  btnConnectLive.disabled = true;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  liveWs = new WebSocket(`${protocol}//${window.location.host}/ws/gemini-live?mode=${currentMode}`);

  liveWs.onopen = () => {
    console.log("[Live] WebSocket connected, waiting for Gemini session...");
  };

  liveWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleLiveMessage(msg);
    } catch {}
  };

  liveWs.onclose = () => {
    console.log("[Live] WebSocket closed");
    cleanupLiveSession();
  };

  liveWs.onerror = (err) => {
    console.error("[Live] WebSocket error:", err);
    cleanupLiveSession();
  };
}

export function disconnectLive(manual = true) {
  isManualDisconnect = manual;
  if (liveWs) {
    // Remove handlers to prevent duplicate calls
    liveWs.onclose = null;
    liveWs.onerror = null;
    try {
      liveWs.send(JSON.stringify({ type: "disconnect" }));
      liveWs.close();
    } catch {}
  }
  cleanupLiveSession();
}

function cleanupLiveSession() {
  // Save any active turn text into history before resetting
  if (interviewerText.trim()) {
    appendToTranscriptLog("interviewer", interviewerText.trim());
    interviewerText = "";
  }
  if (userText.trim()) {
    appendToTranscriptLog("user", userText.trim());
    userText = "";
  }

  liveWs = null;
  stopMic();
  document.body.classList.remove("live-connected", "interviewer-speaking");
  liveStatus.classList.add("hidden");
  btnConnectLive.classList.remove("hidden");
  btnConnectLive.disabled = false;
  btnDisconnectLive.classList.add("hidden");
  btnMic.classList.add("hidden");
  resetPlayback();

  if (isManualDisconnect) {
    statusText.textContent = "Click to connect";
    clearTimeout(autoReconnectTimer);
  } else {
    statusText.textContent = "Connection lost. Reconnecting automatically...";
    clearTimeout(autoReconnectTimer);
    autoReconnectTimer = setTimeout(() => {
      if (!isManualDisconnect && !liveWs) {
        connectLive(false);
      }
    }, 1500);
  }
}

// Called when the transcript is cleared so stale turn text doesn't get
// re-appended on the next disconnect.
export function resetTurnBuffers() {
  interviewerText = "";
  userText = "";
  shouldResetInterviewer = false;
  shouldResetUser = false;
}

// ── Incoming messages ───────────────────────────────────────────────────────

function handleLiveMessage(msg) {
  switch (msg.type) {
    case "status":
      if (msg.status === "connected") {
        document.body.classList.add("live-connected");
        liveStatus.classList.remove("hidden");
        btnConnectLive.classList.add("hidden");
        btnDisconnectLive.classList.remove("hidden");
        btnMic.classList.remove("hidden");
        btnMic.disabled = false;
        statusText.textContent = "Connected — Interview in progress";
        // Clear welcome text and init caption
        transcript.innerHTML = "";
        interviewerText = "";
        userText = "";
        initCaption();
        // Auto-solve if there's code but no solution yet, so the
        // interviewer has full problem context from the start
        if (codePad.value.trim() && !state.currentSolveData) {
          triggerSolve().then(() => sendLiveContext({ turnComplete: true }));
        } else {
          // Send full problem context as a completed turn so Gemini
          // processes it before the voice conversation begins
          sendLiveContext({ turnComplete: true });
        }
        // Start mic automatically
        startMic(sendAudioChunk);
      } else if (msg.status === "idle") {
        cleanupLiveSession();
      }
      break;

    case "audio":
      playAudio(msg.data, msg.mimeType);
      document.body.classList.add("interviewer-speaking");
      break;

    case "turnComplete":
      document.body.classList.remove("interviewer-speaking");
      // Log the completed interviewer turn to transcript
      if (interviewerText.trim()) {
        appendToTranscriptLog("interviewer", interviewerText.trim());
      }
      // Next time the interviewer speaks, reset the caption text
      shouldResetInterviewer = true;
      break;

    case "interrupted":
      document.body.classList.remove("interviewer-speaking");
      // Log whatever was said before interruption
      if (interviewerText.trim()) {
        appendToTranscriptLog("interviewer", interviewerText.trim());
      }
      shouldResetInterviewer = true;
      break;

    case "inputTranscription":
      if (msg.text?.trim()) {
        if (shouldResetUser) {
          userText = "";
          shouldResetUser = false;
        }
        userText += msg.text.trim() + " ";
        updateCaption("user", userText.trim());
      }
      break;

    case "outputTranscription":
      if (msg.text?.trim()) {
        if (shouldResetInterviewer) {
          // Log user text from the previous turn
          if (userText.trim()) {
            appendToTranscriptLog("user", userText.trim());
          }
          interviewerText = "";
          shouldResetInterviewer = false;
          shouldResetUser = true;
        }
        interviewerText += msg.text.trim() + " ";
        updateCaption("interviewer", interviewerText.trim());
      }
      break;

    case "thinking":
      break;

    case "error":
      statusText.textContent = `Error: ${msg.error}`;
      break;
  }
}

// ── Outgoing messages ───────────────────────────────────────────────────────

export function sendAudioChunk(base64) {
  if (!liveWs || liveWs.readyState !== WebSocket.OPEN) return;
  liveWs.send(JSON.stringify({ type: "audio", data: base64 }));
}

let liveContextTimer = null;

export function sendLiveContextDebounced() {
  clearTimeout(liveContextTimer);
  liveContextTimer = setTimeout(() => {
    sendLiveContext({ turnComplete: false });
  }, 2000);

  // Show sync indicator while typing
  if (liveWs && liveWs.readyState === WebSocket.OPEN && liveSyncIndicator) {
    liveSyncIndicator.classList.remove("hidden");
  }
}

export function sendLiveContext(options = {}) {
  if (!liveWs || liveWs.readyState !== WebSocket.OPEN) return;

  const turnComplete = options.turnComplete === true;
  const parts = [];

  if (codePad.value.trim()) {
    // Prefix each line with the same 1-based number shown in the editor gutter
    // so the interviewer can reference lines the way the candidate sees them.
    const numbered = codePad.value
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(3)}| ${line}`)
      .join("\n");
    parts.push(`## Candidate's Current Code\nEach line is prefixed with its line number followed by "|" (e.g. "  3| "). These numbers match the editor gutter the candidate sees — use them when referring to specific lines. They are not part of the code.\n\`\`\`\n${numbered}\n\`\`\``);
  }

  if (state.currentSolveData) {
    const d = state.currentSolveData;
    parts.push(`## Problem Info\nName: ${d.problemName || "Unknown"}\nDifficulty: ${d.difficulty || "Unknown"}\nCategory: ${d.category || "Unknown"}`);
    parts.push(`## Approach\n${d.approach || "N/A"}`);
    parts.push(`## Solution Code\n${d.solution || "N/A"}`);
    parts.push(`## Complexity\nTime: ${d.timeComplexity || "N/A"}\nSpace: ${d.spaceComplexity || "N/A"}`);
    if (d.explanation) {
      parts.push(`## Detailed Explanation\n${d.explanation}`);
    }
  }

  if (state.currentVizHtml) {
    const vizText = extractVizDescription(state.currentVizHtml);
    parts.push(`## Interactive Visualization\nThe candidate has an interactive visualization open that shows a step-by-step walkthrough of this algorithm.\n\n${vizText}`);
  }

  // Include the full conversation history so a reconnected session picks up
  // exactly where the interview left off
  if (state.transcriptHistory.length > 0) {
    const historyLines = state.transcriptHistory.map((h) => {
      const speaker = h.role === "user" ? "Candidate" : "Interviewer";
      return `[${speaker}]: ${h.text}`;
    }).join("\n");
    parts.push(`## Previous Interview Conversation History\nThis session is a continuation of the mock interview. Here is what was previously discussed:\n${historyLines}`);
  }

  if (parts.length === 0) {
    parts.push("The candidate has not loaded a problem yet. Ask them what LeetCode problem they'd like to practice.");
  }

  liveWs.send(JSON.stringify({
    type: "context",
    text: parts.join("\n\n"),
    turnComplete,
  }));
}

// ── UI wiring ───────────────────────────────────────────────────────────────

function updatePanelForMode() {
  if (livePanelTitle) {
    livePanelTitle.textContent = currentMode === "professor" ? "Professor" : "Interviewer";
  }
}

async function startLiveSession(mode) {
  // If switching modes while already connected, disconnect first
  if (liveWs && currentMode !== mode) {
    disconnectLive();
  }
  currentMode = mode;
  updatePanelForMode();
  document.body.classList.add("live-open");

  // Auto-solve if there's code but no solution yet
  if (codePad.value.trim() && !state.currentSolveData) {
    await triggerSolve();
  }

  // Auto-connect
  if (!liveWs) {
    connectLive(true);
  }
}

export function initLive() {
  btnGeminiLive.addEventListener("click", () => startLiveSession("interview"));

  const btnProfessor = document.getElementById("btn-professor");
  if (btnProfessor) {
    btnProfessor.addEventListener("click", () => startLiveSession("professor"));
  }

  btnCloseLive.addEventListener("click", () => {
    disconnectLive();
    document.body.classList.remove("live-open");
  });

  btnConnectLive.addEventListener("click", () => connectLive(true));
  btnDisconnectLive.addEventListener("click", () => {
    disconnectLive(true);
    document.body.classList.remove("live-open");
  });
}
