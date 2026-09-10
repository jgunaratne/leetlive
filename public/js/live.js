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
import {
  startAttempt,
  noteHint,
  noteSpokenTurn,
  nextHintLevel,
  hintsRemaining,
} from "./metrics.js";

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

// Set when we already know the drop is coming (a goAway) and there is no point
// waiting out a backoff we only need for genuine outages.
let nextReconnectDelayMs = null;

// Whether the current socket ever reached a live Gemini session. A socket that
// dies before that is usually a handle the server could not resume, so the
// handle is dropped rather than retried into the same failure forever.
let sawConnected = false;

// Model turns since the coding pad was last pushed. Sliding-window compression
// eventually evicts the oldest turns, taking the code with it — which is what it
// looks like when the interviewer starts discussing a version of the code you
// edited ten minutes ago. Re-send the pad every so often to repair that.
const CODE_REFRESH_TURNS = 8;
let turnsSinceCodeSent = 0;

// Snapshot of what the model has already been told, so context updates only
// carry what actually changed. Re-sending the full problem + solution +
// transcript on every edit bloats the session context and makes replies
// progressively slower.
let sentContext = emptySentContext();

// True between the first audio chunk of a model turn and its turnComplete.
// Pushing context mid-turn confuses the model, so updates wait.
let modelSpeaking = false;
let contextUpdatePending = false;

// ── Turn state ──────────────────────────────────────────────────────────────
//
// A context push with `turnComplete: false` deliberately does not ask for a
// reply — a code edit should not make the interviewer start talking. The
// side effect is that it leaves the user turn *open*, and mic audio sent with
// sendRealtimeInput joins that same open turn. End-of-speech from VAD does not
// reliably close a turn that client content opened, so the model sits waiting
// for more input and the candidate has to repeat themselves to get an answer.
//
// The repair: notice end-of-speech ourselves and, if no reply materialises,
// close the turn explicitly. Both timings are heuristics — VAD's own decision
// is not visible to us, and model latency varies — so they live here as
// constants to be tuned against real sessions.

// No new input transcription for this long means the candidate stopped talking.
// Long enough to sit through a mid-sentence pause, short enough that the
// watchdog below still fires inside a natural conversational gap.
const SPEECH_GAP_MS = 900;

// How long after end-of-speech to wait for the model before assuming the turn
// is stuck open. Comfortably longer than a normal time-to-first-audio, so a
// merely slow reply is never cut off by a redundant turn close.
const TURN_WATCHDOG_MS = 3500;

// Set when a context push left the user turn open. Only then is a stuck turn
// possible, and only then does the watchdog have anything to fix.
let turnLeftOpen = false;
let speechGapTimer = null;
let responseWatchdog = null;

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
const btnHint = document.getElementById("btn-hint");
const btnHintLabel = document.getElementById("btn-hint-label");

// Which mode this attempt gets recorded under: "" until a live session has
// actually been started, then "interview", and "professor" once professor mode
// has been used at all. Professor mode latches — see getSessionMode().
let sessionModeRecord = "";

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

  sawConnected = false;
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
  clearTurnTimers();
  turnLeftOpen = false;
  modelSpeaking = false;
  contextUpdatePending = false;
  sentContext = emptySentContext();
  turnsSinceCodeSent = 0;
  document.body.classList.remove("live-connected", "interviewer-speaking");
  liveStatus.classList.add("hidden");
  btnConnectLive.classList.remove("hidden");
  btnConnectLive.disabled = false;
  btnDisconnectLive.classList.add("hidden");
  btnMic.classList.add("hidden");
  if (btnHint) btnHint.classList.add("hidden");
  if (liveSyncIndicator) liveSyncIndicator.classList.add("hidden");
  resetPlayback();

  clearTimeout(autoReconnectTimer);
  clearTimeout(liveContextTimer);
  liveContextTimer = null;

  if (isManualDisconnect) {
    statusText.textContent = "Click to connect";
    reconnectAttempts = 0;
  } else {
    // A socket that never reached a live session almost always means the server
    // could not resume our handle. Retrying with it just reproduces the failure,
    // so start clean — the transcript replay puts the conversation back.
    if (!sawConnected && resumptionHandle) {
      console.warn("[Live] Dropped before connecting — discarding resume handle");
      resumptionHandle = null;
    }

    // Back off so a server-side outage isn't hammered once a second, but stay
    // fast for the common case of a single dropped connection.
    const delay = nextReconnectDelayMs ?? Math.min(
      RECONNECT_BASE_MS * 2 ** reconnectAttempts,
      RECONNECT_MAX_MS
    );
    nextReconnectDelayMs = null;
    reconnectAttempts++;
    statusText.textContent = "Connection lost. Reconnecting automatically...";
    autoReconnectTimer = setTimeout(() => {
      if (!isManualDisconnect && !liveWs) {
        connectLive(false);
      }
    }, delay);
  }
}

// ── Turn state ──────────────────────────────────────────────────────────────

function clearTurnTimers() {
  clearTimeout(speechGapTimer);
  speechGapTimer = null;
  clearTimeout(responseWatchdog);
  responseWatchdog = null;
}

/**
 * Called on every input transcription. Each one pushes the end-of-speech
 * decision further out, so the gap is measured from the last thing the
 * candidate said rather than the first.
 */
function noteSpeechActivity() {
  // Still talking — whatever we were waiting on is not stuck, it is ongoing.
  clearTimeout(responseWatchdog);
  responseWatchdog = null;
  clearTimeout(speechGapTimer);
  speechGapTimer = setTimeout(handleEndOfSpeech, SPEECH_GAP_MS);
}

/**
 * The candidate has stopped talking and a reply is due. This is the one moment
 * where pushing context is free: the utterance is finished and the answer has
 * not started, so an update here neither splits the audio turn nor interrupts
 * the interviewer.
 */
function handleEndOfSpeech() {
  speechGapTimer = null;
  // A finished utterance is the unit "did they explain themselves" is measured
  // in, and this is the moment it finishes.
  noteSpokenTurn("user", userText);
  flushDebouncedContext();

  // With no open turn, VAD closes the audio turn on its own and a close from us
  // would only risk prompting an unasked-for reply.
  if (!turnLeftOpen) return;

  clearTimeout(responseWatchdog);
  responseWatchdog = setTimeout(() => {
    responseWatchdog = null;
    if (!turnLeftOpen) return;
    console.warn("[Live] No reply after end of speech — closing the open turn");
    sendCloseTurn();
  }, TURN_WATCHDOG_MS);
}

/**
 * Close a dangling user turn without adding anything to it, so the model
 * answers what has already been said instead of waiting for more.
 */
function sendCloseTurn() {
  if (!liveWs || liveWs.readyState !== WebSocket.OPEN) return;
  turnLeftOpen = false;
  liveWs.send(JSON.stringify({ type: "closeTurn" }));
}

// ── Hints ───────────────────────────────────────────────────────────────────

/**
 * The mode this attempt is recorded under. Switching between interview and
 * professor mid-attempt does not split the session in two — it is one problem,
 * one session row — but professor mode latches, because an attempt where the
 * candidate was taught cannot be read as an unaided interview.
 *
 * Empty until a live session has actually been started, so a session where the
 * user only ever typed in the pad is not counted as an interview they aced.
 */
export function getSessionMode() {
  return sessionModeRecord;
}

export function resetSessionMode() {
  sessionModeRecord = "";
}

/**
 * Pull the next rung of the hint ladder. The workspace is pushed first without
 * completing the turn, so the hint is given against the code as it stands now;
 * the request itself completes the turn and is what asks for the reply.
 */
function requestHint() {
  if (!liveWs || liveWs.readyState !== WebSocket.OPEN) return;
  const level = nextHintLevel();
  if (level === null) return;

  sendLiveContext({ turnComplete: false });
  liveWs.send(JSON.stringify({
    type: "context",
    text: `[HINT REQUEST: level ${level}]`,
    turnComplete: true,
  }));
  turnLeftOpen = false;
  clearTurnTimers();

  noteHint(level);
  updateHintButton();
}

function updateHintButton() {
  if (!btnHint || !btnHintLabel) return;

  // Interview-only: the professor teaches on request already, so a rationed
  // hint ladder there would be measuring the wrong thing.
  const available = currentMode === "interview" && !!liveWs;
  btnHint.classList.toggle("hidden", !available);
  if (!available) return;

  const left = hintsRemaining();
  btnHint.disabled = left === 0;
  btnHintLabel.textContent = left === 0 ? "No hints left" : `Hint · ${left} left`;
  btnHint.title = left === 0
    ? "You've used all four hints"
    : `Ask for the next hint — ${left} of 4 remaining`;
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
        sawConnected = true;
        turnsSinceCodeSent = 0;
        document.body.classList.add("live-connected");
        liveStatus.classList.remove("hidden");
        btnConnectLive.classList.add("hidden");
        btnDisconnectLive.classList.remove("hidden");
        btnMic.classList.remove("hidden");
        btnMic.disabled = false;
        updateHintButton();
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

    case "resumeRejected":
      // The server could not pick the old session back up. Forget the handle so
      // the reconnect that follows starts a fresh session and replays history.
      console.warn("[Live] Resume rejected — next attempt starts fresh");
      resumptionHandle = null;
      break;

    case "goAway":
      // Gemini is about to drop us. Reconnect now, from the latest checkpoint,
      // instead of waiting for the socket to die mid-sentence.
      console.log("[Live] GoAway — reconnecting early:", msg.timeLeft);
      reconnectAttempts = 0;
      // This drop is expected, not a fault — waiting out a backoff here is pure
      // dead air in the middle of a conversation.
      nextReconnectDelayMs = 0;
      disconnectLive(false);
      break;

    case "audio":
      // The model is answering, so the user turn has been consumed — whatever
      // we were about to fix is no longer broken.
      clearTurnTimers();
      turnLeftOpen = false;
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
      turnsSinceCodeSent++;
      flushPendingContext();
      if (turnsSinceCodeSent >= CODE_REFRESH_TURNS && codePad.value.trim()) {
        // Between turns is the only safe moment to re-push the pad, and the gap
        // right after an answer is where it costs the least.
        sendLiveContext({ turnComplete: false });
      }
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
        // Transcription is the only end-of-speech signal visible from here —
        // VAD makes its decision server-side and never tells us. Context is
        // deliberately NOT flushed here: pushing client content mid-sentence
        // splits the audio turn the candidate is still speaking into. It gets
        // flushed at end-of-speech instead.
        noteSpeechActivity();
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
    liveContextTimer = null;
    sendLiveContext({ turnComplete: false });
  }, 2000);

  // Show sync indicator while typing
  if (liveWs && liveWs.readyState === WebSocket.OPEN && liveSyncIndicator) {
    liveSyncIndicator.classList.remove("hidden");
  }
}

/**
 * Cut the edit debounce short and push now. Called the moment the candidate
 * stops speaking: the debounce exists to avoid a context update per keystroke,
 * not to make the model answer questions about code that has already changed.
 */
function flushDebouncedContext() {
  if (!liveContextTimer) return;
  clearTimeout(liveContextTimer);
  liveContextTimer = null;
  sendLiveContext({ turnComplete: false });
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

  // Re-send the pad when it changed, and also when it has simply been too many
  // turns — context compaction may have evicted the copy the model was holding.
  const codeIsStale = turnsSinceCodeSent >= CODE_REFRESH_TURNS;
  let codeSent = false;
  if (code.trim() && (code !== sentContext.code || codeIsStale)) {
    parts.push(codeBlock(code, who));
    codeSent = true;
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

  // A push that does not complete the turn leaves it open for mic audio to join
  // — the condition the end-of-speech watchdog exists to unstick.
  turnLeftOpen = !turnComplete;
  if (turnComplete) clearTurnTimers();

  sentContext = { code, solve: solveKey, viz: vizKey, history: true };
  if (codeSent) turnsSinceCodeSent = 0;
  if (liveSyncIndicator) liveSyncIndicator.classList.add("hidden");
}

// ── UI wiring ───────────────────────────────────────────────────────────────

function updatePanelForMode() {
  if (livePanelTitle) {
    livePanelTitle.textContent = currentMode === "professor" ? "Professor" : "Interviewer";
  }
  updateHintButton();
}

async function startLiveSession(mode) {
  // If switching modes while already connected, disconnect first
  if (liveWs && currentMode !== mode) {
    disconnectLive();
  }
  currentMode = mode;

  if (mode === "professor") {
    // Latches for the rest of the attempt — see getSessionMode().
    sessionModeRecord = "professor";
  } else {
    if (sessionModeRecord !== "professor") sessionModeRecord = "interview";
    // A fresh interview run: time-to-first-code and time-to-approach are only
    // meaningful measured from the moment the interview actually started.
    startAttempt();
  }
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

  if (btnHint) {
    btnHint.addEventListener("click", requestHint);
  }

  btnConnectLive.addEventListener("click", () => connectLive(true));
  btnDisconnectLive.addEventListener("click", () => {
    disconnectLive(true);
    document.body.classList.remove("live-open");
  });
}
