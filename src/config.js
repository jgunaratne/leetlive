/**
 * LeetLive — Configuration
 *
 * All environment-derived settings and model names live here.
 */

export const PORT = process.env.PORT || 3000;

export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
export const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "";
export const GOOGLE_CLOUD_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

export const FLASH_MODEL = "gemini-3.5-flash";
export const LIVE_MODEL = "gemini-3.1-flash-live-preview";

// Prebuilt voice for the Live interviewer. Charon is deep and measured —
// reads as calmer and more patient than the brighter voices (e.g. Orus, Puck).
export const LIVE_VOICE = "Charon";

// Warmer, more articulate voice for the professor / tutor mode.
export const PROFESSOR_VOICE = "Orus";
