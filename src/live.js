/**
 * LeetLive — Gemini Live WebSocket proxy
 *
 * Bridges browser WebSocket clients to a Gemini Live session:
 * browser audio/context messages go up, model audio/transcriptions come back.
 */

import { WebSocketServer, WebSocket } from "ws";
import { Modality } from "@google/genai";
import { getClient } from "./geminiClient.js";
import { LIVE_MODEL, LIVE_VOICE, PROFESSOR_VOICE } from "./config.js";
import { INTERVIEWER_SYSTEM_INSTRUCTION, PROFESSOR_SYSTEM_INSTRUCTION } from "./prompts.js";

export function attachLiveProxy(server) {
  const wss = new WebSocketServer({ server, path: "/ws/gemini-live" });
  wss.on("connection", (ws, req) => handleBrowserConnection(ws, req));
  return wss;
}

function handleBrowserConnection(browserWs, req) {
  // Read mode from query parameter (default: "interview")
  const url = new URL(req.url, "http://localhost");
  const mode = url.searchParams.get("mode") || "interview";
  const systemPrompt = mode === "professor"
    ? PROFESSOR_SYSTEM_INSTRUCTION
    : INTERVIEWER_SYSTEM_INSTRUCTION;
  const voice = mode === "professor" ? PROFESSOR_VOICE : LIVE_VOICE;
  console.log(`[Gemini Live] Browser connected (mode: ${mode})`);

  const client = getClient();
  if (!client) {
    browserWs.send(JSON.stringify({ type: "error", error: "No Gemini client configured" }));
    browserWs.close();
    return;
  }

  let geminiSession = null;

  (async () => {
    try {
      const sessionConfig = {
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
            endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
            silenceDurationMs: 1500,
            prefixPaddingMs: 200,
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      };

      geminiSession = await client.live.connect({
        model: LIVE_MODEL,
        config: sessionConfig,
        callbacks: {
          onopen: () => {
            console.log("[Gemini Live] Session opened");
            send(browserWs, { type: "status", status: "connected" });
          },
          onmessage: (msg) => relayGeminiMessage(browserWs, msg),
          onerror: (e) => {
            console.error("[Gemini Live] Error:", e.message);
            send(browserWs, { type: "error", error: e.message });
          },
          onclose: (e) => {
            console.log(`[Gemini Live] Closed: code=${e?.code}`);
            send(browserWs, { type: "status", status: "idle" });
          },
        },
      });

      console.log("[Gemini Live] Session created successfully");
    } catch (err) {
      console.error("[Gemini Live] Failed to connect:", err.message);
      send(browserWs, { type: "error", error: err.message });
      browserWs.close();
    }
  })();

  browserWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "audio" && geminiSession) {
        geminiSession.sendRealtimeInput({
          audio: { data: msg.data, mimeType: "audio/pcm;rate=16000" },
        });
      } else if (msg.type === "context" && geminiSession) {
        // Send problem context as text to Gemini Live
        geminiSession.sendClientContent({
          turns: [
            {
              role: "user",
              parts: [{ text: msg.text }],
            },
          ],
          turnComplete: msg.turnComplete === true,
        });
      } else if (msg.type === "disconnect") {
        if (geminiSession) {
          try { geminiSession.close(); } catch {}
        }
      }
    } catch {}
  });

  browserWs.on("close", () => {
    console.log("[Gemini Live] Browser disconnected");
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

  // GoAway — log but don't crash
  if (msg.goAway) {
    console.log("[Gemini Live] GoAway received:", msg.goAway);
  }
}
