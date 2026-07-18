/**
 * LeetLive — Client-side Application
 *
 * Manages:
 *   1. Coding pad + tabbed Solution view → Gemini Flash solve
 *   2. Visualization generation → iframe rendering
 *   3. Gemini Live voice session for mock coding interviews
 */

// ── DOM Elements ────────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const codePad = $("#code-pad");
const lineNumbers = $("#line-numbers");
const btnSolve = $("#btn-solve");
const btnClear = $("#btn-clear");
const btnVisualize = $("#btn-visualize");
const btnGeminiLive = $("#btn-gemini-live");
const transcriptLog = $("#transcript-log");
const btnCloseLive = $("#btn-close-live");
const btnConnectLive = $("#btn-connect-live");
const btnDisconnectLive = $("#btn-disconnect-live");
const btnMic = $("#btn-mic");

// Solution elements
const solutionPlaceholder = $("#solution-placeholder");
const solutionLoading = $("#solution-loading");
const solutionCode = $("#solution-code");
const solutionExplanation = $("#solution-explanation");
const timeBadge = $("#time-badge");
const spaceBadge = $("#space-badge");
const timeValue = $("#time-value");
const spaceValue = $("#space-value");

// Problem badge
const problemBadge = $("#problem-badge");
const badgeDifficulty = $("#badge-difficulty");
const badgeName = $("#badge-name");
const badgeCategory = $("#badge-category");

// Live elements
const liveStatus = $("#live-status");
const connectionStatus = $("#live-connection-status");
const statusText = connectionStatus.querySelector(".status-text");
const transcript = $("#transcript");

// Visualization elements
const vizPlaceholder = $("#viz-placeholder");
const vizLoading = $("#viz-loading");
const vizFrame = $("#viz-frame");

// ── State ───────────────────────────────────────────────────────────────────
let currentSolution = null;
let currentProblemName = null;
let currentSolveData = null;
let currentVizHtml = null;
let liveWs = null;
let audioContext = null;
let micStream = null;
let micProcessor = null;
let isRecording = false;
let nextPlayTime = 0;

const GEMINI_SAMPLE_RATE = 24000;
const MIC_SAMPLE_RATE = 16000;
const STORAGE_KEY = "leetlive_state";

// ── LocalStorage Persistence ────────────────────────────────────────────────
function saveState() {
  const state = {
    codePad: codePad.value,
    solveData: currentSolveData,
    vizHtml: currentVizHtml,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);

    // Restore coding pad (support old 'codeStub' key for backward compat)
    if (state.codePad || state.codeStub) {
      codePad.value = state.codePad || state.codeStub;
    }

    // Restore solve data
    if (state.solveData) {
      const data = state.solveData;
      currentSolveData = data;
      currentSolution = data.solution;
      currentProblemName = data.problemName;

      solutionPlaceholder.classList.add("hidden");
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

    // Restore visualization
    if (state.vizHtml) {
      currentVizHtml = state.vizHtml;
      vizPlaceholder.classList.add("hidden");
      vizFrame.classList.remove("hidden");
      vizFrame.srcdoc = state.vizHtml;
      // Auto-enable visualize button
      btnVisualize.disabled = false;
    }

    updateLineNumbers();
  } catch {}
}

// Save coding pad on every input & update line numbers
codePad.addEventListener("input", () => {
  saveState();
  updateLineNumbers();
});

// Restore state on page load
loadState();

// ══════════════════════════════════════════════════════════════════════════════
// TAB SWITCHING
// ══════════════════════════════════════════════════════════════════════════════

const tabBar = $("#col1-tabs");
tabBar.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab-btn");
  if (!btn) return;
  const tabId = btn.dataset.tab;

  // Update tab buttons
  tabBar.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");

  // Update tab content
  document.querySelectorAll("#col-code .tab-content").forEach((tc) => {
    tc.classList.toggle("active", tc.dataset.tab === tabId);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SOLVE
// ══════════════════════════════════════════════════════════════════════════════

btnSolve.addEventListener("click", async () => {
  const stub = codePad.value.trim();
  if (!stub) return;

  // Show loading
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
      body: JSON.stringify({ codeStub: stub }),  // server still expects 'codeStub'
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to solve");
    }

    const data = await res.json();
    currentSolution = data.solution;
    currentProblemName = data.problemName;
    currentSolveData = data;

    // Show solution
    solutionLoading.classList.add("hidden");
    solutionCode.classList.remove("hidden");
    solutionCode.querySelector("code").textContent = data.solution;

    // Show explanation
    if (data.explanation || data.approach) {
      solutionExplanation.classList.remove("hidden");
      solutionExplanation.innerHTML = `
        <strong>Approach:</strong> ${escapeHtml(data.approach || "")}<br><br>
        ${escapeHtml(data.explanation || "")}
      `;
    }

    // Show complexity badges
    if (data.timeComplexity) {
      timeValue.textContent = data.timeComplexity;
      timeBadge.classList.remove("hidden");
    }
    if (data.spaceComplexity) {
      spaceValue.textContent = data.spaceComplexity;
      spaceBadge.classList.remove("hidden");
    }

    // Show problem badge
    if (data.problemName) {
      badgeName.textContent = data.problemName;
      badgeDifficulty.textContent = data.difficulty || "Medium";
      badgeDifficulty.className = `badge-difficulty ${(data.difficulty || "Medium").toLowerCase()}`;
      badgeCategory.textContent = data.category || "";
      problemBadge.classList.remove("hidden");
    }

    // Enable buttons
    btnVisualize.disabled = false;
    btnGeminiLive.disabled = false;

    // Persist to localStorage
    saveState();

    // Update Gemini Live context if connected
    sendLiveContext();
  } catch (err) {
    solutionLoading.classList.add("hidden");
    solutionPlaceholder.classList.remove("hidden");
    solutionPlaceholder.innerHTML = `
      <p style="color: var(--color-error)">${escapeHtml(err.message)}</p>
    `;
  } finally {
    btnSolve.disabled = false;
  }
});

// ── Clear ───────────────────────────────────────────────────────────────────
btnClear.addEventListener("click", () => {
  codePad.value = "";
  currentSolution = null;
  currentProblemName = null;
  currentSolveData = null;
  currentVizHtml = null;
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
  // Clear localStorage
  localStorage.removeItem(STORAGE_KEY);
  transcriptHistory = [];
  transcriptLog.innerHTML = `
    <div class="transcript-log-empty">
      <p>Start a mock interview to see the conversation transcript here.</p>
    </div>
  `;
  updateLineNumbers();
  // Update live context
  sendLiveContext();
});

// ══════════════════════════════════════════════════════════════════════════════
// VISUALIZE
// ══════════════════════════════════════════════════════════════════════════════

btnVisualize.addEventListener("click", async () => {

  vizPlaceholder.classList.add("hidden");
  vizFrame.classList.add("hidden");
  vizLoading.classList.remove("hidden");
  btnVisualize.disabled = true;

  try {
    const res = await fetch("/api/visualize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codeStub: codePad.value.trim(),
        solution: currentSolution,
        problemName: currentProblemName,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "Failed to generate visualization");
    }

    const data = await res.json();
    vizLoading.classList.add("hidden");
    vizFrame.classList.remove("hidden");

    // Write HTML to iframe
    vizFrame.srcdoc = data.html;
    currentVizHtml = data.html;
    saveState();

    // Update Gemini Live context if connected
    sendLiveContext();
  } catch (err) {
    vizLoading.classList.add("hidden");
    vizPlaceholder.classList.remove("hidden");
    vizPlaceholder.innerHTML = `
      <p style="color: var(--color-error)">${escapeHtml(err.message)}</p>
    `;
  } finally {
    btnVisualize.disabled = false;
  }
});



// ══════════════════════════════════════════════════════════════════════════════
// GEMINI LIVE — Voice Session
// ══════════════════════════════════════════════════════════════════════════════

btnGeminiLive.addEventListener("click", () => {
  document.body.classList.add("live-open");
});

btnCloseLive.addEventListener("click", () => {
  disconnectLive();
  document.body.classList.remove("live-open");
});

let isManualDisconnect = false;
let autoReconnectTimer = null;
let transcriptHistory = []; // Stores { role: "user" | "interviewer", text: string, time: string }

// ── Connect to Gemini Live ──────────────────────────────────────────────────
btnConnectLive.addEventListener("click", () => connectLive(true));

async function connectLive(isUserAction = false) {
  if (liveWs) return;

  if (isUserAction) {
    isManualDisconnect = false;
  }

  statusText.textContent = isManualDisconnect ? "Connecting..." : "Reconnecting...";
  btnConnectLive.disabled = true;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  liveWs = new WebSocket(`${protocol}//${window.location.host}/ws/gemini-live`);

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

// ── Disconnect ──────────────────────────────────────────────────────────────
btnDisconnectLive.addEventListener("click", () => disconnectLive(true));

function disconnectLive(manual = true) {
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
  if (interviewerText && interviewerText.trim()) {
    appendToTranscriptLog("interviewer", interviewerText.trim());
    interviewerText = "";
  }
  if (userText && userText.trim()) {
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
  nextPlayTime = 0;

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

// ── Handle Gemini Live messages ─────────────────────────────────────────────
let interviewerText = "";
let userText = "";
let shouldResetInterviewer = false;
let shouldResetUser = false;

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
        // Send full problem context now that Gemini session is ready
        sendLiveContext();
        // Start mic automatically
        startMic();
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
        // Reset user text on next interviewer turn
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

// ── Caption Display ─────────────────────────────────────────────────────────
function initCaption() {
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

function updateCaption(role, text) {
  const id = role === "user" ? "caption-user" : "caption-interviewer";
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("hidden");
  el.querySelector(".caption-text").textContent = text;
  transcript.parentElement.scrollTop = transcript.parentElement.scrollHeight;
}

function appendToTranscriptLog(role, text) {
  if (!text || !text.trim()) return;

  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  transcriptHistory.push({ role, text: text.trim(), time });

  // Remove the empty state message if present
  const empty = transcriptLog.querySelector(".transcript-log-empty");
  if (empty) empty.remove();

  const entry = document.createElement("div");
  entry.className = `tlog-entry tlog-${role}`;
  const label = role === "user" ? "You" : "Interviewer";
  entry.innerHTML = `
    <div class="tlog-meta">
      <span class="tlog-label">${escapeHtml(label)}</span>
      <span class="tlog-time">${escapeHtml(time)}</span>
    </div>
    <div class="tlog-text">${escapeHtml(text.trim())}</div>
  `;
  transcriptLog.appendChild(entry);
  transcriptLog.scrollTop = transcriptLog.scrollHeight;
}

// ── Audio Playback (PCM 24kHz from Gemini) ──────────────────────────────────
function ensureAudioContext() {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext({ sampleRate: GEMINI_SAMPLE_RATE });
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  return audioContext;
}

function playAudio(base64Data, mimeType) {
  const ctx = ensureAudioContext();

  // Decode base64 to raw bytes
  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  // Parse sample rate from mimeType (e.g. "audio/pcm;rate=24000")
  const rateMatch = (mimeType || "").match(/rate=(\d+)/);
  const sampleRate = rateMatch ? parseInt(rateMatch[1]) : GEMINI_SAMPLE_RATE;

  // Convert PCM16 to Float32
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }

  const buffer = ctx.createBuffer(1, float32.length, sampleRate);
  buffer.copyToChannel(float32, 0);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);

  const now = ctx.currentTime;
  const startTime = Math.max(now + 0.04, nextPlayTime);
  source.start(startTime);
  nextPlayTime = startTime + buffer.duration;
}

// ── Microphone (PCM 16kHz to Gemini) ────────────────────────────────────────
async function startMic() {
  if (isRecording) return;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: MIC_SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const micCtx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
    const source = micCtx.createMediaStreamSource(micStream);

    // Use ScriptProcessor for compatibility (AudioWorklet preferred but needs HTTPS)
    const processor = micCtx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (!liveWs || liveWs.readyState !== WebSocket.OPEN) return;
      const inputData = event.inputBuffer.getChannelData(0);

      // Convert Float32 to PCM16 base64
      const int16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      const bytes = new Uint8Array(int16.buffer);
      const base64 = btoa(String.fromCharCode(...bytes));

      liveWs.send(JSON.stringify({ type: "audio", data: base64 }));
    };

    source.connect(processor);
    processor.connect(micCtx.destination);

    micProcessor = { processor, source, context: micCtx };
    isRecording = true;
    btnMic.classList.add("recording");
  } catch (err) {
    console.error("[Mic] Failed to start:", err);
    statusText.textContent = "Microphone access denied";
  }
}

function stopMic() {
  if (micProcessor) {
    try {
      micProcessor.processor.disconnect();
      micProcessor.source.disconnect();
      micProcessor.context.close();
    } catch {}
    micProcessor = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  isRecording = false;
  btnMic.classList.remove("recording");
}

btnMic.addEventListener("click", () => {
  if (isRecording) {
    stopMic();
  } else {
    startMic();
  }
});

// ── Send context to Gemini Live ─────────────────────────────────────────────
let liveContextTimer = null;

function sendLiveContextDebounced() {
  clearTimeout(liveContextTimer);
  liveContextTimer = setTimeout(() => {
    sendLiveContext({ turnComplete: false });
  }, 2000);

  // Show sync indicator while typing
  const syncIndicator = $("#live-sync-indicator");
  if (liveWs && liveWs.readyState === WebSocket.OPEN && syncIndicator) {
    syncIndicator.classList.remove("hidden");
  }
}

function sendLiveContext(options = {}) {
  if (!liveWs || liveWs.readyState !== WebSocket.OPEN) return;

  const turnComplete = options.turnComplete === true;
  const parts = [];

  if (codePad.value.trim()) {
    parts.push(`## Candidate's Current Code\n\`\`\`\n${codePad.value.trim()}\n\`\`\``);
  }

  if (currentSolveData) {
    const d = currentSolveData;
    parts.push(`## Problem Info\nName: ${d.problemName || "Unknown"}\nDifficulty: ${d.difficulty || "Unknown"}\nCategory: ${d.category || "Unknown"}`);
    parts.push(`## Approach\n${d.approach || "N/A"}`);
    parts.push(`## Solution Code\n${d.solution || "N/A"}`);
    parts.push(`## Complexity\nTime: ${d.timeComplexity || "N/A"}\nSpace: ${d.spaceComplexity || "N/A"}`);
    if (d.explanation) {
      parts.push(`## Detailed Explanation\n${d.explanation}`);
    }
  }

  if (currentVizHtml) {
    // Extract meaningful text content from the visualization HTML
    // so the interviewer can reference specific UI elements and controls
    const vizText = extractVizDescription(currentVizHtml);
    parts.push(`## Interactive Visualization\nThe candidate has an interactive visualization open that shows a step-by-step walkthrough of this algorithm.\n\n${vizText}`);
  }

  // Include full conversation history so far if reconnecting or continuing session
  if (transcriptHistory.length > 0) {
    const historyLines = transcriptHistory.map((h) => {
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

function extractVizDescription(html) {
  // Parse the viz HTML to extract text descriptions, labels, and structure
  // so the interviewer knows what the candidate is seeing
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const descriptions = [];

    // Get title/headers
    const headers = doc.querySelectorAll("h1, h2, h3");
    if (headers.length) {
      descriptions.push("Sections: " + [...headers].map(h => h.textContent.trim()).join(", "));
    }

    // Get button labels (controls)
    const buttons = doc.querySelectorAll("button");
    if (buttons.length) {
      descriptions.push("Controls: " + [...buttons].map(b => b.textContent.trim()).filter(Boolean).join(", "));
    }

    // Get any labels or descriptions
    const labels = doc.querySelectorAll("label, .label, .description, .info, .hint");
    if (labels.length) {
      descriptions.push("Labels: " + [...labels].slice(0, 10).map(l => l.textContent.trim()).filter(Boolean).join("; "));
    }

    // Get preset/example labels
    const presets = doc.querySelectorAll(".preset, .example, [data-example]");
    if (presets.length) {
      descriptions.push("Preset examples: " + [...presets].map(p => p.textContent.trim()).filter(Boolean).join(", "));
    }

    // Summarize the body text for any explanatory content
    const bodyText = doc.body?.textContent?.replace(/\s+/g, " ").trim() || "";
    if (bodyText.length > 100) {
      descriptions.push("Visualization content summary: " + bodyText.slice(0, 1500));
    }

    return descriptions.join("\n") || "An interactive algorithm visualization is displayed.";
  } catch {
    return "An interactive algorithm visualization is displayed with play/pause controls, step-by-step execution, and variable state tracking.";
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Line Numbers & Code Pad Editor Controls ──────────────────────────────────
function updateLineNumbers() {
  if (!lineNumbers || !codePad) return;
  const lineCount = (codePad.value.match(/\n/g) || []).length + 1;
  let html = "";
  for (let i = 1; i <= lineCount; i++) {
    html += `<span>${i}</span>`;
  }
  lineNumbers.innerHTML = html;
}

if (codePad && lineNumbers) {
  codePad.addEventListener("scroll", () => {
    lineNumbers.scrollTop = codePad.scrollTop;
  });
}

// ── Keyboard shortcuts & Auto-indentation for Code Pad ───────────────────────
codePad.addEventListener("keydown", (e) => {
  // Ctrl/Cmd + Enter to solve
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    btnSolve.click();
    return;
  }

  // Auto-indentation on Enter (Return)
  if (e.key === "Enter") {
    e.preventDefault();
    const val = codePad.value;
    const start = codePad.selectionStart;
    const end = codePad.selectionEnd;

    // Find start of current line up to cursor
    const lineStart = val.lastIndexOf("\n", start - 1) + 1;
    const currentLine = val.substring(lineStart, start);

    // Extract leading indentation
    const indentMatch = currentLine.match(/^[ \t]*/);
    let indent = indentMatch ? indentMatch[0] : "";

    // If line ends with block opener (:, {, [, (), increase indent by 4 spaces
    const trimmed = currentLine.trimEnd();
    if (/[:\{\[\(]$/.test(trimmed)) {
      indent += "    ";
    }

    // Insert newline + indent
    codePad.value = val.substring(0, start) + "\n" + indent + val.substring(end);
    codePad.selectionStart = codePad.selectionEnd = start + 1 + indent.length;

    updateLineNumbers();
    saveState();
    sendLiveContextDebounced();
    return;
  }

  // Tab & Shift+Tab handling
  if (e.key === "Tab") {
    e.preventDefault();
    const val = codePad.value;
    const start = codePad.selectionStart;
    const end = codePad.selectionEnd;

    if (e.shiftKey) {
      // Shift+Tab: Unindent
      const lineStart = val.lastIndexOf("\n", start - 1) + 1;
      const selectedText = val.substring(lineStart, end);
      const lines = selectedText.split("\n");
      const unindented = lines.map((line) => line.replace(/^( {1,4}|\t)/, ""));
      const newText = unindented.join("\n");

      codePad.value = val.substring(0, lineStart) + newText + val.substring(end);
      const firstLineDiff = lines[0].length - unindented[0].length;
      const totalDiff = selectedText.length - newText.length;
      codePad.selectionStart = Math.max(lineStart, start - firstLineDiff);
      codePad.selectionEnd = Math.max(lineStart, end - totalDiff);
    } else {
      // Tab: Indent
      if (start !== end && val.substring(start, end).includes("\n")) {
        // Multi-line indent
        const lineStart = val.lastIndexOf("\n", start - 1) + 1;
        const selectedText = val.substring(lineStart, end);
        const lines = selectedText.split("\n");
        const indented = lines.map((line) => "    " + line);
        const newText = indented.join("\n");

        codePad.value = val.substring(0, lineStart) + newText + val.substring(end);
        codePad.selectionStart = start + 4;
        codePad.selectionEnd = end + lines.length * 4;
      } else {
        // Single cursor or single line indent (insert 4 spaces)
        codePad.value = val.substring(0, start) + "    " + val.substring(end);
        codePad.selectionStart = codePad.selectionEnd = start + 4;
      }
    }

    updateLineNumbers();
    saveState();
    sendLiveContextDebounced();
  }

  // Smart Backspace / Delete for Indentation & Braces
  if (e.key === "Backspace") {
    const val = codePad.value;
    const start = codePad.selectionStart;
    const end = codePad.selectionEnd;

    if (start === end && start > 0) {
      const lineStart = val.lastIndexOf("\n", start - 1) + 1;
      const beforeCursor = val.substring(lineStart, start);

      // Smart unindent: If line before cursor is only spaces/tabs, delete up to tab stop (4 spaces)
      if (/^[ \t]+$/.test(beforeCursor)) {
        e.preventDefault();
        const len = beforeCursor.length;
        const deleteCount = len % 4 === 0 ? 4 : len % 4;
        const newBefore = beforeCursor.slice(0, len - deleteCount);
        codePad.value = val.substring(0, lineStart) + newBefore + val.substring(start);
        codePad.selectionStart = codePad.selectionEnd = lineStart + newBefore.length;
        updateLineNumbers();
        saveState();
        sendLiveContextDebounced();
        return;
      }

      // Delete matching pairs () {} [] "" '' ``
      const charBefore = val[start - 1];
      const charAfter = val[start];
      const pairs = { "(": ")", "{": "}", "[": "]", '"': '"', "'": "'", "`": "`" };
      if (pairs[charBefore] && pairs[charBefore] === charAfter) {
        e.preventDefault();
        codePad.value = val.substring(0, start - 1) + val.substring(start + 1);
        codePad.selectionStart = codePad.selectionEnd = start - 1;
        updateLineNumbers();
        saveState();
        sendLiveContextDebounced();
        return;
      }
    }
  }

  // Auto-unindent when typing closing braces/brackets }, ], )
  if (["}", "]", ")"].includes(e.key)) {
    const val = codePad.value;
    const start = codePad.selectionStart;
    const end = codePad.selectionEnd;

    if (start === end && start > 0) {
      const lineStart = val.lastIndexOf("\n", start - 1) + 1;
      const beforeCursor = val.substring(lineStart, start);

      // If line before cursor is only 4+ spaces, unindent by 4 spaces when typing closing brace
      if (/^ {4,}$/.test(beforeCursor)) {
        e.preventDefault();
        const unindentedBefore = beforeCursor.slice(0, -4);
        codePad.value = val.substring(0, lineStart) + unindentedBefore + e.key + val.substring(end);
        codePad.selectionStart = codePad.selectionEnd = lineStart + unindentedBefore.length + 1;
        updateLineNumbers();
        saveState();
        sendLiveContextDebounced();
        return;
      }
    }
  }

  // Auto-close opening brackets
  const openPairs = { "(": ")", "{": "}", "[": "]" };
  if (openPairs[e.key]) {
    const val = codePad.value;
    const start = codePad.selectionStart;
    const end = codePad.selectionEnd;
    const closeChar = openPairs[e.key];

    e.preventDefault();
    if (start !== end) {
      // Wrap selected text
      const selected = val.substring(start, end);
      codePad.value = val.substring(0, start) + e.key + selected + closeChar + val.substring(end);
      codePad.selectionStart = start + 1;
      codePad.selectionEnd = end + 1;
    } else {
      // Insert pair
      codePad.value = val.substring(0, start) + e.key + closeChar + val.substring(end);
      codePad.selectionStart = codePad.selectionEnd = start + 1;
    }
    updateLineNumbers();
    saveState();
    sendLiveContextDebounced();
    return;
  }
});

// ── Debounced live context sync on typing ───────────────────────────────────
codePad.addEventListener("input", sendLiveContextDebounced);
