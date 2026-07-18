/**
 * LeetLive — Server
 *
 * Express + WebSocket server that proxies:
 *   1. Gemini Flash for solving code + generating visualizations
 *   2. Gemini Live for real-time voice tutoring
 */

import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI } from "@google/genai";
import { Modality } from "@google/genai";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "";
const GOOGLE_CLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
const FLASH_MODEL = "gemini-3.5-flash";
const LIVE_MODEL = "gemini-3.1-flash-live-preview";

// ── Gemini Client (same dual-auth pattern as orchestrator) ──────────────────
let vertexClient = null;
let apiKeyClient = null;

function getVertexClient() {
  if (!vertexClient && GOOGLE_CLOUD_PROJECT) {
    vertexClient = new GoogleGenAI({
      vertexai: true,
      project: GOOGLE_CLOUD_PROJECT,
      location: GOOGLE_CLOUD_LOCATION,
    });
    console.log(`[Gemini] Vertex AI client ready (project=${GOOGLE_CLOUD_PROJECT})`);
  }
  return vertexClient;
}

function getApiKeyClient() {
  if (!apiKeyClient && GEMINI_API_KEY) {
    apiKeyClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    console.log(`[Gemini] API key client ready`);
  }
  return apiKeyClient;
}

function getClient() {
  return getApiKeyClient() || getVertexClient();
}

// ── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// ── POST /api/solve — Solve a LeetCode problem ─────────────────────────────
app.post("/api/solve", async (req, res) => {
  const { codeStub, language } = req.body;
  if (!codeStub) return res.status(400).json({ error: "No code stub provided" });

  const client = getClient();
  if (!client) return res.status(500).json({ error: "No Gemini client configured" });

  const systemInstruction = [
    "You are a world-class competitive programmer and LeetCode expert.",
    "The user will provide you with a LeetCode problem code stub.",
    "Your job is to:",
    "1. Identify the problem from the code stub",
    "2. Write a clean, efficient, and well-commented solution",
    "3. Explain the approach briefly",
    "4. Analyze time and space complexity",
    "",
    "Return your response in this exact JSON format:",
    '{',
    '  "problemName": "Name of the problem",',
    '  "difficulty": "Easy|Medium|Hard",',
    '  "category": "Array|String|Tree|etc",',
    '  "approach": "Brief explanation of the approach",',
    '  "solution": "The complete solution code",',
    '  "timeComplexity": "O(...)",',
    '  "spaceComplexity": "O(...)",',
    '  "explanation": "Detailed step-by-step explanation"',
    '}',
  ].join("\n");

  try {
    const response = await client.models.generateContent({
      model: FLASH_MODEL,
      contents: [{ role: "user", parts: [{ text: `Solve this LeetCode problem:\n\n${codeStub}` }] }],
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            problemName: { type: "string" },
            difficulty: { type: "string" },
            category: { type: "string" },
            approach: { type: "string" },
            solution: { type: "string" },
            timeComplexity: { type: "string" },
            spaceComplexity: { type: "string" },
            explanation: { type: "string" },
          },
          required: ["problemName", "solution", "approach", "timeComplexity", "spaceComplexity", "explanation"],
        },
      },
    });

    const text = response?.candidates?.[0]?.content?.parts
      ?.filter((p) => p.text)
      .map((p) => p.text)
      .join("");
    const parsed = JSON.parse(text);
    res.json(parsed);
  } catch (err) {
    console.error("[Solve] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/visualize — Generate an interactive HTML visualization ────────
app.post("/api/visualize", async (req, res) => {
  const { codeStub, solution, problemName } = req.body;
  if (!codeStub) return res.status(400).json({ error: "No code stub provided" });

  const client = getClient();
  if (!client) return res.status(500).json({ error: "No Gemini client configured" });

  const systemInstruction = [
    "You are an expert at creating interactive, visual algorithm walkthroughs for LeetCode problems.",
    "Given a LeetCode problem and its solution, create a SINGLE self-contained HTML file that provides",
    "an interactive, step-by-step visualization of how the algorithm works.",
    "",
    "Requirements:",
    "- The HTML must be completely self-contained (inline CSS and JavaScript)",
    "- Use a dark theme (background: #0f0f23, text: #e0e0e0)",
    "- Create a visually stunning, modern UI with smooth animations",
    "- Include interactive controls: Play, Pause, Step Forward, Step Backward, Speed slider",
    "- Show the data structure state at each step with color-coded elements",
    "- Highlight the current operation with glowing effects",
    "- Show variable states in a heads-up display (HUD)",
    "- Include a code panel that highlights the current line being executed",
    "- Allow users to input custom test cases",
    "- Use preset examples from the problem description",
    "- Add a live execution log showing what's happening at each step",
    "- Make it responsive and fill the available space",
    "- Use modern fonts (system-ui or monospace for code)",
    "- Add subtle gradients and glassmorphism effects",
    "",
    "Return ONLY the raw HTML content. No markdown, no code fences, no explanation.",
    "The HTML should be ready to render directly in an iframe.",
  ].join("\n");

  try {
    const prompt = solution
      ? `Create an interactive visualization for this LeetCode problem:\n\nProblem: ${problemName || "Unknown"}\n\nCode Stub:\n${codeStub}\n\nSolution:\n${solution}`
      : `Create an interactive visualization for this LeetCode problem:\n\nCode Stub:\n${codeStub}`;

    const response = await client.models.generateContent({
      model: FLASH_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { systemInstruction },
    });

    const html = response?.candidates?.[0]?.content?.parts
      ?.filter((p) => p.text)
      .map((p) => p.text)
      .join("");
    res.json({ html });
  } catch (err) {
    console.error("[Visualize] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HTTP Server + WebSocket ─────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws/gemini-live" });

// ── Gemini Live WebSocket handler ───────────────────────────────────────────
wss.on("connection", (browserWs) => {
  console.log("[Gemini Live] Browser connected");

  const client = getClient();
  if (!client) {
    browserWs.send(JSON.stringify({ type: "error", error: "No Gemini client configured" }));
    browserWs.close();
    return;
  }

  let geminiSession = null;
  let closed = false;

  const systemInstruction = [
    "You are a seasoned coding interviewer at a top-tier tech company (think Google, Meta, Amazon level).",
    "You conduct realistic mock coding interviews to help candidates prepare.",
    "",
    "## CRITICAL: Be Brief and Patient",
    "- Keep every response to 1–2 sentences MAX. No long monologues.",
    "- Silence is okay. A real interviewer sits quietly while the candidate thinks and codes.",
    "- Do NOT fill silence with commentary. Wait for the candidate to speak or ask for help.",
    "- When you do speak, be direct and concise. No preambles like 'Great question!' or 'That's a really interesting approach!'",
    "- One thought at a time. Never stack multiple questions or points in one response.",
    "",
    "## Your Style",
    "- Calm, patient, and minimal — like a senior engineer who listens more than talks",
    "- Short confirmations: 'Makes sense.', 'Go ahead.', 'Yep.', 'And the complexity?'",
    "- Short nudges when stuck: 'What if you used a hash map?' not a full explanation of hash maps",
    "- You speak clearly and at a relaxed pace",
    "",
    "## Interview Flow",
    "1. Present the problem briefly. Ask 'Any questions?' — then stop and wait.",
    "2. Let the candidate talk through their approach. Respond with at most one short follow-up.",
    "3. While they code, stay quiet unless they talk to you or ask for help.",
    "4. If they're stuck for a long time and ask, give ONE small hint.",
    "5. After they finish, ask about complexity in one sentence.",
    "6. Save follow-up questions for after they're done.",
    "",
    "## Context",
    "The candidate is using LeetLive, an app that has:",
    "1. A coding pad where they write their solution — you can see their code in real-time",
    "2. An AI-generated reference solution (ANSWER KEY — never reveal unless they give up)",
    "3. An interactive visualization of the algorithm",
    "",
    "You receive context updates with the candidate's code and the reference solution.",
    "Use it to evaluate their work, but do NOT narrate their code as they type.",
    "Only comment on code if they explicitly ask or if they've been stuck and silent for a while.",
    "",
    "## Rules",
    "- Do NOT explain the solution unprompted. Let the candidate think.",
    "- Do NOT give long speeches. One sentence, then wait.",
    "- Do NOT comment on every code change. Stay quiet while they work.",
    "- Do NOT stack questions. Ask one thing, then listen.",
    "- Short feedback: 'That works.' or 'Consider the time complexity.' — not paragraphs.",
    "",
    "You are having a voice conversation. Keep it natural, brief, and unhurried.",
    "Speak slowly and deliberately. Pause between sentences. There is no rush.",
  ].join("\n");

  (async () => {
    try {
      const sessionConfig = {
        responseModalities: [Modality.AUDIO],
        systemInstruction: { parts: [{ text: systemInstruction }] },
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Orus" },
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
          onmessage: (msg) => handleGeminiMessage(browserWs, msg),
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

  // Handle messages from browser
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
        closed = true;
        if (geminiSession) {
          try { geminiSession.close(); } catch {}
        }
      }
    } catch {}
  });

  browserWs.on("close", () => {
    console.log("[Gemini Live] Browser disconnected");
    closed = true;
    if (geminiSession) {
      try { geminiSession.close(); } catch {}
    }
  });
});

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function handleGeminiMessage(browserWs, msg) {
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
      if (part.text) {
        if (part.thought) {
          send(browserWs, { type: "thinking", text: part.text });
        }
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

// ── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 LeetLive running at http://localhost:${PORT}\n`);
  console.log(`   Gemini Flash model: ${FLASH_MODEL}`);
  console.log(`   Gemini Live model:  ${LIVE_MODEL}`);
  console.log(`   Auth: ${GEMINI_API_KEY ? "API Key" : GOOGLE_CLOUD_PROJECT ? "Vertex AI" : "⚠️  NOT CONFIGURED"}`);
  console.log();
});
