/**
 * LeetLive — Workspace context blocks
 *
 * The voice session and the professor chat both need to describe the same
 * workspace to Gemini: what the user has typed, the reference solution, the
 * visualization, and what has already been said. These builders are the single
 * source of truth for that wording so the two modes stay in sync.
 *
 * Gemini Live pushes these blocks incrementally (only what changed), so the
 * builders return individual blocks rather than one blob; buildWorkspaceContext()
 * assembles the full snapshot for the stateless chat endpoint.
 */

import { codePad } from "./dom.js";
import { state } from "./state.js";
import { extractVizDescription } from "./viz.js";

/**
 * Prefix each line with the same 1-based number shown in the editor gutter, so
 * the model can reference lines the way the user sees them.
 */
export function numberedCode(code) {
  return code
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(3)}| ${line}`)
    .join("\n");
}

export function codeBlock(code, who = "Candidate") {
  return [
    `## ${who}'s Current Code`,
    `Each line is prefixed with its line number followed by "|" (e.g. "  3| "). These numbers match the editor gutter the ${who.toLowerCase()} sees — use them when referring to specific lines. They are not part of the code.`,
    "```",
    numberedCode(code),
    "```",
  ].join("\n");
}

/** The reference solution, split into the blocks the model reads best. */
export function solutionBlocks(d) {
  const blocks = [
    `## Problem Info\nName: ${d.problemName || "Unknown"}\nDifficulty: ${d.difficulty || "Unknown"}\nCategory: ${d.category || "Unknown"}`,
    `## Approach\n${d.approach || "N/A"}`,
    `## Solution Code\n${d.solution || "N/A"}`,
    `## Complexity\nTime: ${d.timeComplexity || "N/A"}\nSpace: ${d.spaceComplexity || "N/A"}`,
  ];
  if (d.explanation) blocks.push(`## Detailed Explanation\n${d.explanation}`);
  return blocks;
}

export function vizBlock(html, who = "candidate") {
  return `## Interactive Visualization\nThe ${who} has an interactive visualization open that shows a step-by-step walkthrough of this algorithm.\n\n${extractVizDescription(html)}`;
}

/** The voice conversation so far, rendered as a labelled dialogue. */
export function historyBlock(history, opts = {}) {
  const who = opts.who || "Candidate";
  const assistant = opts.assistant || "Interviewer";
  const heading = opts.heading || "Previous Interview Conversation History";
  const intro =
    opts.intro ||
    "This session is a continuation of the mock interview. Here is what was previously discussed:";
  const lines = history
    .map((h) => `[${h.role === "user" ? who : assistant}]: ${h.text}`)
    .join("\n");
  return `## ${heading}\n${intro}\n${lines}`;
}

/**
 * Full workspace snapshot for the chat sidebar. Unlike the Live session — which
 * accumulates context turn by turn — the chat endpoint is stateless, so this is
 * rebuilt from scratch on every message and always reflects the current editor.
 */
export function buildWorkspaceContext() {
  const parts = [];
  const code = codePad.value;

  if (code.trim()) {
    parts.push(codeBlock(code, "Student"));
  } else {
    parts.push("## Student's Current Code\nThe coding pad is empty — the student has not written anything yet.");
  }

  if (state.currentSolveData?.solution) {
    parts.push(
      "## Reference Solution (teaching aid)\nAn AI-generated reference solution is available in the app. Use it to guide your teaching, but do not paste it wholesale unless the student asks."
    );
    parts.push(...solutionBlocks(state.currentSolveData));
  }

  if (state.currentVizHtml) {
    parts.push(vizBlock(state.currentVizHtml, "student"));
  }

  if (state.transcriptHistory?.length) {
    parts.push(
      historyBlock(state.transcriptHistory, {
        who: "Student",
        assistant: "Voice tutor",
        heading: "Voice Session Transcript",
        intro:
          "The student has also been talking through this problem out loud with the voice tutor. Here is that conversation:",
      })
    );
  }

  return parts.join("\n\n");
}
