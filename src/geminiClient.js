/**
 * LeetLive — Gemini client factory
 *
 * Dual-auth: prefers an API key, falls back to Vertex AI via ADC.
 */

import { GoogleGenAI } from "@google/genai";
import {
  GEMINI_API_KEY,
  GOOGLE_CLOUD_PROJECT,
  GOOGLE_CLOUD_LOCATION,
} from "./config.js";

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

export function getClient() {
  return getApiKeyClient() || getVertexClient();
}
