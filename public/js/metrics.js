/**
 * LeetLive — Interview attempt metrics
 *
 * Tracks how the candidate got to their answer, not just whether they got
 * there. The app can already tell a working solution from a broken one; what
 * it could not tell was "solved it" from "solved it with help", which is the
 * distinction a real hiring loop turns on.
 *
 * Everything here is per *attempt*: one interview-mode session on one problem.
 * Professor mode is deliberately not tracked — that is teaching, where needing
 * help is the point, and grading independence there would be measuring the
 * wrong thing.
 */

// A spoken turn this long is treated as the candidate explaining themselves
// rather than answering "yep" or asking where the input comes from. It is a
// proxy, not a judgement: the grader gets the transcript too and is told to
// check this against it.
const APPROACH_MIN_WORDS = 12;

// The ladder tops out here. Past level 4 the interviewer has described the
// solution's structure, and there is nothing left to give that would still be
// a hint rather than the answer.
export const MAX_HINT_LEVEL = 4;

function emptyAttempt() {
  return {
    startedAt: null,
    firstCodeAt: null,
    approachAt: null,
    // { level, at } — every rung pulled, in order, including repeats.
    hints: [],
  };
}

let attempt = emptyAttempt();

/**
 * Begin a fresh attempt. Called when an interview-mode live session starts, so
 * every timing below is measured from the moment the interview actually began
 * rather than from page load.
 */
export function startAttempt() {
  attempt = emptyAttempt();
  attempt.startedAt = Date.now();
}

export function resetMetrics() {
  attempt = emptyAttempt();
}

function tracking() {
  return attempt.startedAt !== null;
}

/**
 * The candidate typed in the coding pad. Only the first one counts — this is
 * the "how long did they think before reaching for the keyboard" signal.
 */
export function noteFirstCode() {
  if (!tracking() || attempt.firstCodeAt) return;
  attempt.firstCodeAt = Date.now();
}

/**
 * A completed spoken turn. The first substantive one from the candidate stands
 * in for "stated their approach".
 */
export function noteSpokenTurn(role, text) {
  if (!tracking() || role !== "user" || attempt.approachAt) return;
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= APPROACH_MIN_WORDS) {
    attempt.approachAt = Date.now();
  }
}

export function noteHint(level) {
  if (!tracking()) return;
  attempt.hints.push({ level, at: Date.now() });
}

/** Rung the next pull would land on, or null once the ladder is exhausted. */
export function nextHintLevel() {
  const next = highestHintLevel() + 1;
  return next > MAX_HINT_LEVEL ? null : next;
}

export function highestHintLevel() {
  return attempt.hints.reduce((max, h) => Math.max(max, h.level), 0);
}

export function hintsRemaining() {
  return Math.max(0, MAX_HINT_LEVEL - highestHintLevel());
}

function elapsed(then) {
  if (!then || !attempt.startedAt) return null;
  return then - attempt.startedAt;
}

/**
 * Machine-readable summary. This is what gets persisted with the session and
 * what the trends endpoint aggregates, so keep the shape stable.
 */
export function getMetricsSummary() {
  return {
    startedAt: attempt.startedAt ? new Date(attempt.startedAt).toISOString() : null,
    timeToFirstCodeMs: elapsed(attempt.firstCodeAt),
    timeToApproachMs: elapsed(attempt.approachAt),
    statedApproach: attempt.approachAt !== null,
    hints: attempt.hints.map((h) => ({ level: h.level, atMs: elapsed(h.at) })),
    hintCount: attempt.hints.length,
    highestHintLevel: highestHintLevel(),
    unassisted: attempt.hints.length === 0,
  };
}

function humanMs(ms) {
  if (ms === null || ms === undefined) return "never";
  const total = Math.round(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min ? `${min}m ${sec}s` : `${sec}s`;
}

/**
 * Prose version for the hiring-decision prompt. The grader reads this next to
 * the transcript, so it says how each number was measured — a metric it cannot
 * interrogate is one it will over-trust.
 */
export function formatMetricsBlock() {
  const s = getMetricsSummary();
  const lines = [
    "## Session Metrics (measured by the app, not self-reported)",
    "",
    `- Time to first line of code: ${humanMs(s.timeToFirstCodeMs)}`,
    `- Time to stated approach: ${humanMs(s.timeToApproachMs)}` +
      " (first spoken turn of 12+ words — a proxy for stating an approach;" +
      " check it against the transcript before relying on it)",
    `- Hints pulled: ${s.hintCount === 0 ? "none" : s.hintCount}`,
  ];

  for (const h of s.hints) {
    lines.push(`  - Level ${h.level} at ${humanMs(h.atMs)}`);
  }

  lines.push(
    `- Highest hint level reached: ${s.highestHintLevel || "none"}`,
    `- Unassisted: ${s.unassisted ? "yes — solved with no hints" : "no"}`,
    "",
    "Hints are pulled by the candidate on an explicit button, never volunteered",
    "by the interviewer, so every hint above is a moment the candidate could not",
    "move on unaided. The levels are: 1 orients them toward what the problem is",
    "really asking, 2 names the data structure, 3 names the technique and how it",
    "maps to this problem, 4 describes the loop-and-branch structure of the",
    "solution in words.",
  );

  return lines.join("\n");
}

/**
 * Persisted alongside the session row. An attempt that never started has no
 * metrics — not a perfect set of them. Reporting the empty object keeps a
 * session where nobody ever opened an interview out of the trend aggregates,
 * where it would otherwise land as a flawless unassisted run.
 */
export function serializeMetrics() {
  return tracking() ? JSON.stringify(getMetricsSummary()) : "{}";
}
