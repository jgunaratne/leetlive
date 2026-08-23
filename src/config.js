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

export const FLASH_MODEL = "gemini-3.7-flash";
export const LIVE_MODEL = "gemini-3.1-flash-live-preview";

// Text chat with the professor in the right sidebar. Currently the same model
// as FLASH_MODEL but kept as its own constant: the chat is conversational and
// latency-sensitive, while solve/visualize are one-shot structured generations,
// so the two are free to diverge again.
export const CHAT_MODEL = "gemini-3.7-flash";

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

// How much speech has to be detected before Gemini commits to "the user is
// talking". Anything shorter is discarded as noise and never reaches the model,
// so a clipped one-word reply ("ok", "yep", "right") looks like the interviewer
// ignoring you. Keep this well below the length of a single spoken syllable
// (~150ms); false positives are harmless because end-of-speech closes them out
// immediately, whereas a swallowed turn is a dead conversation.
export const LIVE_PREFIX_PADDING_MS = Number(process.env.LIVE_PREFIX_PADDING_MS || 20);

// Sliding-window compression keeps long sessions alive: without it the session
// is terminated once the context window fills, which shows up as a mid-interview
// disconnect. Compaction is not free, so trigger late and keep a large tail.
//
// Every compaction also drops the oldest turns — including the code we pushed
// earlier — which is why the model starts answering about a stale coding pad.
// Triggering later means fewer of those amnesia events; LIVE_CODE_REFRESH_TURNS
// on the client repairs the ones that still happen.
export const LIVE_COMPRESSION_TRIGGER_TOKENS = "32000";
export const LIVE_COMPRESSION_TARGET_TOKENS = "16000";

// How often the proxy pings idle browser sockets. Long stretches of an interview
// are silence in both directions, and an idle WebSocket is exactly what proxies,
// NAT tables and laptop sleep quietly reap. A ping keeps the path warm and, when
// the pong never comes, tells us the socket is dead so the browser can rebuild
// it instead of talking into a void.
export const LIVE_PING_INTERVAL_MS = Number(process.env.LIVE_PING_INTERVAL_MS || 20000);
