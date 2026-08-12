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
import { playAudio, startMic, stopMic, resetPlayback, flushPlayback } from "./audio.js";
import { codeBlock, solutionBlocks, vizBlock, historyBlock } from "./workspace.js";
import { triggerSolve } from "./solution.js";

let liveWs = null;
let isManualDisconnect = false;
let autoReconnectTimer = null;
let currentMode = "interview"; // "interview" or "professor"

// Handle from the most recent resumption checkpoint. Passed back on reconnect so
// the model keeps the conversation instead of restarting cold.
let resumptionHandle = null;
let reconnectAttempts = 0;

const RECONNECT_BASE_MS = 800;
const RECONNECT_MAX_MS = 15000;

// Snapshot of what the model has already been told, so context updates only
// carry what actually changed. Re-sending the full problem + solution +
// transcript on every edit bloats the session context and makes replies
// progressively slower.
let sentContext = emptySentContext();

// True between the first audio chunk of a model turn and its turnComplete.
// Pushing context mid-turn confuses the model, so updates wait.
let modelSpeaking = false;
let contextUpdatePending = false;

function emptySentContext() {
  return { code: null, solve: null, viz: null, history: false };
}

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

  if (isUserAction) {
    // A deliberate connect starts a new conversation — drop any stale handle.
    resumptionHandle = null;
    reconnectAttempts = 0;
  }

  statusText.textContent = isUserAction ? "Connecting..." : "Reconnecting...";
  btnConnectLive.disabled = true;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ mode: currentMode });
  if (resumptionHandle) params.set("resume", resumptionHandle);
  liveWs = new WebSocket(`${protocol}//${window.location.host}/ws/gemini-live?${params}`);

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
  if (manual) resumptionHandle = null;
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

  if (liveWs) {
    // Drop handlers first so closing doesn't re-enter cleanup, then actually
    // close — leaving the socket open leaks a proxy session per reconnect.
    liveWs.onclose = null;
    liveWs.onerror = null;
    liveWs.onmessage = null;
    try { liveWs.close(); } catch {}
  }
  liveWs = null;

  stopMic();
  modelSpeaking = false;
  contextUpdatePending = false;
  sentContext = emptySentContext();
  document.body.classList.remove("live-connected", "interviewer-speaking");
  liveStatus.classList.add("hidden");
  btnConnectLive.classList.remove("hidden");
  btnConnectLive.disabled = false;
  btnDisconnectLive.classList.add("hidden");
  btnMic.classList.add("hidden");
  if (liveSyncIndicator) liveSyncIndicator.classList.add("hidden");
  resetPlayback();

  clearTimeout(autoReconnectTimer);
  clearTimeout(liveContextTimer);

  if (isManualDisconnect) {
    statusText.textContent = "Click to connect";
    reconnectAttempts = 0;
  } else {
    // Back off so a server-side outage isn't hammered once a second, but stay
    // fast for the common case of a single dropped connection.
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** reconnectAttempts,
      RECONNECT_MAX_MS
    );
    reconnectAttempts++;
    statusText.textContent = "Connection lost. Reconnecting automatically...";
    autoReconnectTimer = setTimeout(() => {
      if (!isManualDisconnect && !liveWs) {
        connectLive(false);
      }
    }, delay);
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
        reconnectAttempts = 0;
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

        if (msg.resumed) {
          // The model still holds the conversation, so skip the history replay
          // and just sync the workspace — without prompting a fresh reply.
          sentContext.history = true;
          sendLiveContext({ turnComplete: false });
          startMic(sendAudioChunk);
          break;
        }

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

    case "resumptionHandle":
      resumptionHandle = msg.handle;
      break;

    case "goAway":
      // Gemini is about to drop us. Reconnect now, from the latest checkpoint,
      // instead of waiting for the socket to die mid-sentence.
      console.log("[Live] GoAway — reconnecting early:", msg.timeLeft);
      reconnectAttempts = 0;
      disconnectLive(false);
      break;

    case "audio":
      playAudio(msg.data, msg.mimeType);
      modelSpeaking = true;
      document.body.classList.add("interviewer-speaking");
      break;

    case "turnComplete":
      document.body.classList.remove("interviewer-speaking");
      modelSpeaking = false;
      // Log the completed interviewer turn to transcript
      if (interviewerText.trim()) {
        appendToTranscriptLog("interviewer", interviewerText.trim());
      }
      // Next time the interviewer speaks, reset the caption text
      shouldResetInterviewer = true;
      flushPendingContext();
      break;

    case "interrupted":
      document.body.classList.remove("interviewer-speaking");
      modelSpeaking = false;
      // Drop the audio Gemini already streamed for this turn — it arrives well
      // ahead of playback, so without this the interviewer keeps talking for
      // seconds after being interrupted.
      flushPlayback();
      // Log whatever was said before interruption
      if (interviewerText.trim()) {
        appendToTranscriptLog("interviewer", interviewerText.trim());
      }
      shouldResetInterviewer = true;
      flushPendingContext();
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

function flushPendingContext() {
  if (!contextUpdatePending) return;
  contextUpdatePending = false;
  sendLiveContext({ turnComplete: false });
}

/**
 * Push context to the interviewer, sending only what has changed since the last
 * push. The solution, explanation and transcript history run to thousands of
 * tokens; re-sending them on every keystroke burst is what makes replies drift
 * from snappy to sluggish over the course of an interview.
 */
export function sendLiveContext(options = {}) {
  if (!liveWs || liveWs.readyState !== WebSocket.OPEN) return;

  const turnComplete = options.turnComplete === true;

  // Never interrupt the interviewer mid-answer with a code update; hold it
  // until the turn ends. A turn-completing send is the caller asking for a
  // reply, so that one goes through regardless.
  if (!turnComplete && modelSpeaking) {
    contextUpdatePending = true;
    return;
  }

  const parts = [];
  const code = codePad.value;
  const solveKey = state.currentSolveData ? JSON.stringify(state.currentSolveData) : null;
  const vizKey = state.currentVizHtml || null;
  const isProfessor = currentMode === "professor";
  const who = isProfessor ? "Student" : "Candidate";

  if (code.trim() && code !== sentContext.code) {
    parts.push(codeBlock(code, who));
  }

  if (solveKey && solveKey !== sentContext.solve) {
    parts.push(...solutionBlocks(state.currentSolveData));
  }

  if (vizKey && vizKey !== sentContext.viz) {
    parts.push(vizBlock(vizKey, who.toLowerCase()));
  }

  // Replay the conversation only when the model has no memory of it — i.e. on a
  // cold session. A resumed session already holds the whole exchange.
  if (!sentContext.history && state.transcriptHistory.length > 0) {
    parts.push(
      historyBlock(state.transcriptHistory, {
        who,
        assistant: isProfessor ? "Professor" : "Interviewer",
        heading: isProfessor
          ? "Previous Tutoring Conversation History"
          : "Previous Interview Conversation History",
        intro: isProfessor
          ? "This session is a continuation of the tutoring session. Here is what was previously discussed:"
          : "This session is a continuation of the mock interview. Here is what was previously discussed:",
      })
    );
  }

  if (parts.length === 0) {
    // Nothing changed. Staying quiet keeps the session small and avoids nudging
    // the model into an unprompted reply.
    if (!turnComplete) {
      if (liveSyncIndicator) liveSyncIndicator.classList.add("hidden");
      return;
    }
    parts.push("The candidate has not loaded a problem yet. Ask them what LeetCode problem they'd like to practice.");
  }

  liveWs.send(JSON.stringify({
    type: "context",
    text: parts.join("\n\n"),
    turnComplete,
  }));

  sentContext = { code, solve: solveKey, viz: vizKey, history: true };
  if (liveSyncIndicator) liveSyncIndicator.classList.add("hidden");
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
