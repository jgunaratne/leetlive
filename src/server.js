/**
 * LeetLive — Server entry point
 *
 * Express + WebSocket server that proxies:
 *   1. Gemini Flash for solving code + generating visualizations
 *   2. Gemini Live for real-time voice tutoring
 */

import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

import { PORT, FLASH_MODEL, LIVE_MODEL, GEMINI_API_KEY, GOOGLE_CLOUD_PROJECT } from "./config.js";
import { solveRouter } from "./routes/solve.js";
import { visualizeRouter } from "./routes/visualize.js";
import { decisionRouter } from "./routes/decision.js";
import { sessionsRouter } from "./routes/sessions.js";
import { attachLiveProxy } from "./live.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(solveRouter);
app.use(visualizeRouter);
app.use(decisionRouter);
app.use(sessionsRouter);

const server = http.createServer(app);
attachLiveProxy(server);

server.listen(PORT, () => {
  console.log(`\n🚀 LeetLive running at http://localhost:${PORT}\n`);
  console.log(`   Gemini Flash model: ${FLASH_MODEL}`);
  console.log(`   Gemini Live model:  ${LIVE_MODEL}`);
  console.log(`   Auth: ${GEMINI_API_KEY ? "API Key" : GOOGLE_CLOUD_PROJECT ? "Vertex AI" : "⚠️  NOT CONFIGURED"}`);
  console.log();
});
