/**
 * LeetLive — Application state + localStorage persistence
 */

import { codePad } from "./dom.js";

const STORAGE_KEY = "leetlive_state";

export const state = {
  currentSolution: null,
  currentProblemName: null,
  currentSolveData: null,
  currentVizHtml: null,
  transcriptHistory: [], // { role: "user" | "interviewer", text: string, time: string }
};

export function saveState() {
  const snapshot = {
    codePad: codePad.value,
    solveData: state.currentSolveData,
    vizHtml: state.currentVizHtml,
    transcriptHistory: state.transcriptHistory,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {}
}

export function loadPersistedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
