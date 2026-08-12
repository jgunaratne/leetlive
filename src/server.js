/**
 * LeetLive — Server entry point
 *
 * Express + WebSocket server that proxies:
 *   1. Gemini Flash for solving code + generating visualizations
 *   2. Gemini Live for real-time voice tutoring
 */

import express from "express";
import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { PORT, CERT_DIR, FLASH_MODEL, LIVE_MODEL, CHAT_MODEL, GEMINI_API_KEY, GOOGLE_CLOUD_PROJECT } from "./config.js";
import { solveRouter } from "./routes/solve.js";
import { visualizeRouter } from "./routes/visualize.js";
import { decisionRouter } from "./routes/decision.js";
import { sessionsRouter } from "./routes/sessions.js";
import { chatRouter } from "./routes/chat.js";
import { attachLiveProxy } from "./live.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(solveRouter);
app.use(visualizeRouter);
app.use(decisionRouter);
app.use(sessionsRouter);
app.use(chatRouter);

// Prefer HTTPS: microphone access (getUserMedia) requires a secure context on
// any origin other than localhost. If certs/cert.pem + certs/key.pem exist we
// serve over TLS; otherwise fall back to plain HTTP (fine for localhost dev).
const certDir = path.isAbsolute(CERT_DIR) ? CERT_DIR : path.join(__dirname, "..", CERT_DIR);
const certPath = path.join(certDir, "cert.pem");
const keyPath = path.join(certDir, "key.pem");
const hasCerts = fs.existsSync(certPath) && fs.existsSync(keyPath);

const server = hasCerts
  ? https.createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
  : http.createServer(app);
const scheme = hasCerts ? "https" : "http";

attachLiveProxy(server);

server.listen(PORT, () => {
  console.log(`\n🚀 LeetLive running at ${scheme}://localhost:${PORT}\n`);
  console.log(`   Gemini Flash model: ${FLASH_MODEL}`);
  console.log(`   Gemini Live model:  ${LIVE_MODEL}`);
  console.log(`   Gemini Chat model:  ${CHAT_MODEL}`);
  console.log(`   Auth: ${GEMINI_API_KEY ? "API Key" : GOOGLE_CLOUD_PROJECT ? "Vertex AI" : "⚠️  NOT CONFIGURED"}`);
  console.log();
});
