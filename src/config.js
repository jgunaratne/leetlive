/**
 * LeetLive — Configuration
 *
 * All environment-derived settings and model names live here.
 */

export const PORT = process.env.PORT || 3000;

// Directory holding the TLS cert/key (cert.pem + key.pem). When both files are
// present the server runs over HTTPS — required for microphone access on any
// origin other than localhost (e.g. http://leetlive.local). Generate with:
//   openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/key.pem \
//     -out certs/cert.pem -days 825 -subj "/CN=leetlive.local" \
//     -addext "subjectAltName=DNS:leetlive.local,DNS:localhost,IP:127.0.0.1"
export const CERT_DIR = process.env.CERT_DIR || "certs";

export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
export const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "";
export const GOOGLE_CLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

export const FLASH_MODEL = "gemini-3.5-flash";
export const LIVE_MODEL = "gemini-3.1-flash-live-preview";

// Text chat with the professor in the right sidebar. Kept separate from
// FLASH_MODEL because the chat is conversational and latency-sensitive, while
// solve/visualize are one-shot structured generations.
export const CHAT_MODEL = "gemini-3.6-flash";

// Prebuilt voice for the Live interviewer. Charon is deep and measured —
// reads as calmer and more patient than the brighter voices (e.g. Orus, Puck).
export const LIVE_VOICE = "Charon";

// Warmer, more articulate voice for the professor / tutor mode.
export const PROFESSOR_VOICE = "Orus";

// ── Voice activity detection ────────────────────────────────────────────────
// How long the candidate has to stay quiet before Gemini treats the turn as
// finished and starts answering. This is the single biggest knob on perceived
// response latency: every millisecond here is dead air after you stop talking.
// Raise it if the interviewer keeps cutting you off while you think out loud;
// lower it if replies feel sluggish.
export const LIVE_SILENCE_MS = Number(process.env.LIVE_SILENCE_MS || 700);
export const LIVE_END_SENSITIVITY =
  process.env.LIVE_END_SENSITIVITY || "END_SENSITIVITY_HIGH";

// Sliding-window compression keeps long sessions alive: without it the session
// is terminated once the context window fills, which shows up as a mid-interview
// disconnect. Compaction is not free, so trigger late and keep a large tail.
export const LIVE_COMPRESSION_TRIGGER_TOKENS = "16000";
export const LIVE_COMPRESSION_TARGET_TOKENS = "8000";
