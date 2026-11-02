/**
 * LeetLive practice formats — REST routes (all under /api/practice).
 *
 *   GET    /api/practice/status                 runner + formats + time budgets
 *   GET    /api/practice/problems?format=        list
 *   POST   /api/practice/problems/generate       { format, language, topic, difficulty }
 *   POST   /api/practice/problems/import         { format, language, payload } — bring your own problem
 *   POST   /api/practice/problems/screen         { title, jobDescription }
 *   GET    /api/practice/problems/:id            candidate's view (no hidden parts)
 *   DELETE /api/practice/problems/:id
 *   POST   /api/practice/problems/:id/run        { code, level }
 *   POST   /api/practice/scorecard               { format, problemId, code, notes, transcript, results, metrics }
 *   GET    /api/practice/attempts?format=        list
 *   GET    /api/practice/attempts/:id
 *   POST   /api/practice/attempts                upsert
 *   DELETE /api/practice/attempts/:id
 */

import { Router } from "express";
import { runnerStatus, normalizeLanguage } from "./runner.js";
import { FORMAT_BUDGET_MINUTES } from "./config.js";
import { LIVE_PERSONAS, SCORE_RUBRICS } from "./prompts.js";
import {
  FORMATS,
  CODING_FORMATS,
  generateProblem,
  normalizePayload,
  verifyPayload,
  publicView,
  privateBrief,
  runCandidate,
  generateJson,
} from "./problems.js";
import {
  saveProblem,
  listProblems,
  getProblem,
  deleteProblem,
  saveAttempt,
  listAttempts,
  getAttempt,
  deleteAttempt,
} from "./db.js";

export const practiceRouter = Router();

const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

let cachedStatus = null;
practiceRouter.get("/api/practice/status", async (req, res) => {
  if (!cachedStatus || req.query.refresh) cachedStatus = await runnerStatus();
  res.json({ runner: cachedStatus, formats: FORMATS, budgets: FORMAT_BUDGET_MINUTES });
});

// ── Problems ────────────────────────────────────────────────────────────────

practiceRouter.get("/api/practice/problems", (req, res) => {
  res.json(listProblems(req.query.format || null));
});

practiceRouter.post("/api/practice/problems/generate", async (req, res) => {
  const { format, language, topic, difficulty } = req.body || {};
  if (!FORMATS.includes(format) || format === "screen") return fail(res, 400, "Pick a format that can be generated");
  try {
    const { payload, report, language: lang } = await generateProblem({ format, language, topic, difficulty });
    const id = saveProblem({ format, title: payload.title, language: lang, difficulty: payload.difficulty || difficulty || "", topic: topic || "", payload });
    res.json({ problem: publicView(getProblem(id)), verification: report });
  } catch (err) {
    console.error("[Practice] Generate failed:", err.message);
    fail(res, 500, err.message, { verification: err.report || null });
  }
});

practiceRouter.post("/api/practice/problems/import", async (req, res) => {
  const { format, language, payload: raw } = req.body || {};
  if (!FORMATS.includes(format)) return fail(res, 400, "Unknown format");
  const lang = CODING_FORMATS.includes(format) ? normalizeLanguage(language) : "";
  if (CODING_FORMATS.includes(format) && !lang) return fail(res, 400, "Coding formats need a language: python or javascript");
  try {
    const payload = normalizePayload(format, raw || {});
    const { payload: verified, report } = await verifyPayload(format, payload, lang);
    if (report.failed) return fail(res, 422, report.reason, { verification: report });
    const id = saveProblem({ format, title: verified.title, language: lang, source: "imported", payload: verified });
    res.json({ problem: publicView(getProblem(id)), verification: report });
  } catch (err) {
    fail(res, 400, err.message);
  }
});

practiceRouter.post("/api/practice/problems/screen", (req, res) => {
  const { title, jobDescription } = req.body || {};
  const payload = normalizePayload("screen", { title: title || "Screening call", jobDescription });
  const id = saveProblem({ format: "screen", title: payload.title, source: "imported", payload });
  res.json({ problem: publicView(getProblem(id)) });
});

practiceRouter.get("/api/practice/problems/:id", (req, res) => {
  const problem = getProblem(req.params.id);
  if (!problem) return fail(res, 404, "Problem not found");
  res.json(publicView(problem));
});

practiceRouter.delete("/api/practice/problems/:id", (req, res) => {
  deleteProblem(req.params.id);
  res.json({ ok: true });
});

practiceRouter.post("/api/practice/problems/:id/run", async (req, res) => {
  const problem = getProblem(req.params.id);
  if (!problem) return fail(res, 404, "Problem not found");
  if (!CODING_FORMATS.includes(problem.format)) return fail(res, 400, "This format has no tests to run");
  try {
    res.json(await runCandidate(problem, req.body || {}));
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ── Scorecard ───────────────────────────────────────────────────────────────

const SCORECARD_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", description: "One of: Hire, Lean Hire, Borderline, Lean No Hire, No Hire" },
    summary: { type: "string" },
    dimensions: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, rating: { type: "integer" }, evidence: { type: "string" } },
        required: ["name", "rating", "evidence"],
      },
    },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    improvements: { type: "array", items: { type: "string" } },
    coverage: {
      type: "object",
      properties: { found: { type: "array", items: { type: "string" } }, missed: { type: "array", items: { type: "string" } } },
    },
  },
  required: ["decision", "summary", "dimensions", "strengths", "weaknesses", "improvements"],
};

function transcriptText(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) return "";
  return transcript.map((t) => `${t.role === "user" ? "Candidate" : "Interviewer"}: ${t.text}`).join("\n");
}

practiceRouter.post("/api/practice/scorecard", async (req, res) => {
  const { format, problemId, code, notes, transcript, results, metrics } = req.body || {};
  if (!SCORE_RUBRICS[format]) return fail(res, 400, "Unknown format");
  const problem = problemId ? getProblem(problemId) : null;
  const prompt = [
    `Score this ${format} practice interview.`,
    problem ? privateBrief(problem) : "",
    code ? `## Candidate's code\n\`\`\`\n${code}\n\`\`\`` : "",
    notes ? `## Candidate's notes\n${notes}` : "",
    results ? `## Latest test results\n\`\`\`json\n${JSON.stringify(results, null, 2).slice(0, 12000)}\n\`\`\`` : "",
    metrics ? `## Timing and progress\n\`\`\`json\n${JSON.stringify(metrics, null, 2)}\n\`\`\`` : "",
    transcriptText(transcript) ? `## Transcript\n${transcriptText(transcript)}` : "## Transcript\n(no voice session)",
  ].filter(Boolean).join("\n\n");
  try {
    res.json(await generateJson({ systemInstruction: SCORE_RUBRICS[format], prompt, schema: SCORECARD_SCHEMA }));
  } catch (err) {
    console.error("[Practice] Scorecard failed:", err.message);
    fail(res, 500, err.message);
  }
});

// ── Attempts ────────────────────────────────────────────────────────────────

practiceRouter.get("/api/practice/attempts", (req, res) => {
  res.json(listAttempts(req.query.format || null));
});

practiceRouter.get("/api/practice/attempts/:id", (req, res) => {
  const attempt = getAttempt(req.params.id);
  if (!attempt) return fail(res, 404, "Attempt not found");
  res.json(attempt);
});

practiceRouter.post("/api/practice/attempts", (req, res) => {
  const body = req.body || {};
  if (!FORMATS.includes(body.format)) return fail(res, 400, "Unknown format");
  res.json({ id: saveAttempt(body) });
});

practiceRouter.delete("/api/practice/attempts/:id", (req, res) => {
  deleteAttempt(req.params.id);
  res.json({ ok: true });
});

// ── Voice ───────────────────────────────────────────────────────────────────

/**
 * System instruction for a practice voice session, or null when `mode` is not
 * a practice format — in which case the live proxy keeps its original
 * interviewer / professor behaviour unchanged.
 */
export function practiceLiveInstruction(mode, problemId) {
  const persona = LIVE_PERSONAS[mode];
  if (!persona) return null;
  const problem = problemId ? getProblem(problemId) : null;
  return problem ? `${persona}\n\n${privateBrief(problem)}` : persona;
}
