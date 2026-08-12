/**
 * LeetLive — Gemini Live WebSocket proxy
 *
 * Bridges browser WebSocket clients to a Gemini Live session:
 * browser audio/context messages go up, model audio/transcriptions come back.
 *
 * Stability notes:
 *  - Gemini hands out session-resumption handles; we forward them to the browser
 *    so a dropped socket can rejoin the *same* conversation instead of replaying
 *    the whole transcript as a fresh (and slow) opening turn.
 *  - `goAway` warns us a few seconds before the upstream connection is cut. We
 *    pass it on so the browser can reconnect on its own terms rather than
 *    noticing after the model has already gone silent.
 *  - Mic audio that arrives while the upstream session is still opening is
 *    buffered, not dropped — otherwise the first thing the candidate says gets
 *    swallowed and the model appears unresponsive.
 */

import { WebSocketServer, WebSocket } from "ws";
import { Modality } from "@google/genai";
import { getClient } from "./geminiClient.js";
import {
  LIVE_MODEL,
  LIVE_VOICE,
  PROFESSOR_VOICE,
  LIVE_SILENCE_MS,
  LIVE_END_SENSITIVITY,
  LIVE_COMPRESSION_TRIGGER_TOKENS,
  LIVE_COMPRESSION_TARGET_TOKENS,
} from "./config.js";
import { INTERVIEWER_SYSTEM_INSTRUCTION, PROFESSOR_SYSTEM_INSTRUCTION } from "./prompts.js";

// Roughly 4s of mic audio at 128ms/chunk. Enough to cover session setup without
// letting a stalled connect grow the buffer without bound.
const MAX_PENDING_AUDIO_CHUNKS = 32;

export function attachLiveProxy(server) {
  const wss = new WebSocketServer({ server, path: "/ws/gemini-live" });
  wss.on("connection", (ws, req) => handleBrowserConnection(ws, req));
  return wss;
}

function handleBrowserConnection(browserWs, req) {
  // Read mode from query parameter (default: "interview")
  const url = new URL(req.url, "http://localhost");
  const mode = url.searchParams.get("mode") || "interview";
  const resumeHandle = url.searchParams.get("resume") || null;
  const systemPrompt = mode === "professor"
    ? PROFESSOR_SYSTEM_INSTRUCTION
    : INTERVIEWER_SYSTEM_INSTRUCTION;
  const voice = mode === "professor" ? PROFESSOR_VOICE : LIVE_VOICE;
  console.log(
    `[Gemini Live] Browser connected (mode: ${mode}${resumeHandle ? ", resuming" : ""})`
  );

  const client = getClient();
  if (!client) {
    send(browserWs, { type: "error", error: "No Gemini client configured" });
    browserWs.close();
    return;
  }

  let geminiSession = null;
  let closed = false;
  // Messages the browser sent before the upstream session finished opening.
  // `onopen` fires while client.live.connect() is still resolving, so without
  // this queue the very first thing the browser sends — the problem context —
  // is dropped, and the interviewer sits there with nothing to talk about.
  let pending = [];

  const baseConfig = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: voice },
      },
    },
    realtimeInputConfig: {
      turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
      automaticActivityDetection: {
        startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
        endOfSpeechSensitivity: LIVE_END_SENSITIVITY,
        silenceDurationMs: LIVE_SILENCE_MS,
        prefixPaddingMs: 200,
      },
    },
    // Keep long interviews alive instead of dying when the window fills.
    contextWindowCompression: {
      triggerTokens: LIVE_COMPRESSION_TRIGGER_TOKENS,
      slidingWindow: { targetTokens: LIVE_COMPRESSION_TARGET_TOKENS },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };

  function callbacks(resumed) {
    return {
      onopen: () => {
        console.log(`[Gemini Live] Session opened (resumed: ${resumed})`);
      },
      onmessage: (msg) => relayGeminiMessage(browserWs, msg),
      onerror: (e) => {
        console.error("[Gemini Live] Error:", e?.message);
        send(browserWs, { type: "error", error: e?.message || "Live session error" });
      },
      onclose: (e) => {
        console.log(`[Gemini Live] Closed: code=${e?.code}`);
        send(browserWs, { type: "status", status: "idle" });
        // Let the browser drive the reconnect rather than leaving a half-dead
        // proxy socket around holding a stale session reference.
        if (!closed) {
          closed = true;
          try { browserWs.close(); } catch {}
        }
      },
    };
  }

  (async () => {
    let resumed = false;
    try {
      // A resumption handle can be stale (expired, or from a different model or
      // voice). Rather than failing the whole connect, fall back to a fresh
      // session — the browser replays transcript history in that case.
      if (resumeHandle) {
        try {
          geminiSession = await client.live.connect({
            model: LIVE_MODEL,
            config: { ...baseConfig, sessionResumption: { handle: resumeHandle } },
            callbacks: callbacks(true),
          });
          resumed = true;
        } catch (err) {
          console.warn("[Gemini Live] Resume failed, starting fresh:", err?.message);
          geminiSession = null;
        }
      }

      if (!geminiSession) {
        geminiSession = await client.live.connect({
          model: LIVE_MODEL,
          config: { ...baseConfig, sessionResumption: {} },
          callbacks: callbacks(false),
        });
      }

      if (closed) {
        try { geminiSession.close(); } catch {}
        return;
      }

      // Replay anything that arrived while we were still connecting, then tell
      // the browser it's clear to talk. Announcing readiness only now is what
      // guarantees the opening context turn actually reaches the model.
      for (const msg of pending) forwardToGemini(msg);
      pending = [];

      console.log("[Gemini Live] Session created successfully");
      send(browserWs, { type: "status", status: "connected", resumed });
    } catch (err) {
      console.error("[Gemini Live] Failed to connect:", err?.message);
      send(browserWs, { type: "error", error: err?.message || "Failed to connect" });
      browserWs.close();
    }
  })();

  function forwardToGemini(msg) {
    try {
      if (msg.type === "audio") {
        geminiSession.sendRealtimeInput({
          audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" },
        });
      } else if (msg.type === "context") {
        // Send problem context as text to Gemini Live
        geminiSession.sendClientContent({
          turns: [{ role: "user", parts: [{ text: msg.text }] }],
          turnComplete: msg.turnComplete === true,
        });
      }
    } catch (err) {
      console.error("[Gemini Live] Send failed:", err?.message);
    }
  }

  browserWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === "disconnect") {
      closed = true;
      if (geminiSession) {
        try { geminiSession.close(); } catch {}
      }
      return;
    }

    if (msg.type !== "audio" && msg.type !== "context") return;

    if (geminiSession) {
      forwardToGemini(msg);
    } else if (msg.type === "context" || pending.length < MAX_PENDING_AUDIO_CHUNKS) {
      // Context is small and load-bearing, so it is never dropped; audio is
      // capped so a stalled connect can't grow the queue without bound.
      pending.push(msg);
    }
  });

  browserWs.on("close", () => {
    console.log("[Gemini Live] Browser disconnected");
    closed = true;
    pending = [];
    if (geminiSession) {
      try { geminiSession.close(); } catch {}
    }
  });
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function relayGeminiMessage(browserWs, msg) {
  // The @google/genai SDK delivers serverContent at the top level of msg
  const serverContent = msg.serverContent;
  if (serverContent) {
    const parts = serverContent.modelTurn?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        send(browserWs, {
          type: "audio",
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType || "audio/pcm;rate=24000",
        });
      }
      if (part.text && part.thought) {
        send(browserWs, { type: "thinking", text: part.text });
      }
    }

    if (serverContent.inputTranscription?.text) {
      send(browserWs, {
        type: "inputTranscription",
        text: serverContent.inputTranscription.text,
      });
    }
    if (serverContent.outputTranscription?.text) {
      send(browserWs, {
        type: "outputTranscription",
        text: serverContent.outputTranscription.text,
      });
    }
    if (serverContent.turnComplete) {
      send(browserWs, { type: "turnComplete" });
    }
    if (serverContent.interrupted) {
      send(browserWs, { type: "interrupted" });
    }
  }

  // Checkpoint we can rejoin from if the socket drops.
  if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
    send(browserWs, {
      type: "resumptionHandle",
      handle: msg.sessionResumptionUpdate.newHandle,
    });
  }

  // The upstream connection is about to be torn down. Tell the browser now so
  // it can reconnect from the latest handle instead of hitting a hard drop.
  if (msg.goAway) {
    console.log("[Gemini Live] GoAway received, timeLeft:", msg.goAway.timeLeft);
    send(browserWs, { type: "goAway", timeLeft: msg.goAway.timeLeft });
  }
}
