/**
 * LeetLive — DOM element references
 *
 * Single place where the document is queried; every module imports from here.
 */

export const $ = (sel) => document.querySelector(sel);

// Coding pad
export const codePad = $("#code-pad");
export const lineNumbers = $("#line-numbers");
export const btnSolve = $("#btn-solve");
export const btnClear = $("#btn-clear");
export const btnVisualize = $("#btn-visualize");
export const btnGeminiLive = $("#btn-gemini-live");
export const btnReset = $("#btn-reset");

// Transcript
export const transcriptLog = $("#transcript-log");
export const btnClearTranscript = $("#btn-clear-transcript");

// Live session
export const btnCloseLive = $("#btn-close-live");
export const btnConnectLive = $("#btn-connect-live");
export const btnDisconnectLive = $("#btn-disconnect-live");
export const btnMic = $("#btn-mic");
export const liveStatus = $("#live-status");
export const connectionStatus = $("#live-connection-status");
export const statusText = connectionStatus.querySelector(".status-text");
export const transcript = $("#transcript");
export const liveSyncIndicator = $("#live-sync-indicator");

// Solution
export const solutionPlaceholder = $("#solution-placeholder");
export const solutionLoading = $("#solution-loading");
export const solutionCode = $("#solution-code");
export const solutionExplanation = $("#solution-explanation");
export const timeBadge = $("#time-badge");
export const spaceBadge = $("#space-badge");
export const timeValue = $("#time-value");
export const spaceValue = $("#space-value");

// Problem badge
export const problemBadge = $("#problem-badge");
export const badgeDifficulty = $("#badge-difficulty");
export const badgeName = $("#badge-name");
export const badgeCategory = $("#badge-category");

// Visualization
export const vizPlaceholder = $("#viz-placeholder");
export const vizLoading = $("#viz-loading");
export const vizFrame = $("#viz-frame");
