/**
 * LeetLive practice formats — problem generation, verification and views.
 *
 * Generated coding problems are only kept once their tests are verified: the
 * reference solution is run against every test, and any test the reference
 * fails is dropped. Model-written tests that are themselves wrong would teach
 * the wrong lessons, so this check is what makes hidden tests trustworthy.
 *
 * Each problem has two views:
 *   publicView   — what the candidate's browser receives
 *   privateBrief — what only the voice interviewer and the scorecard see
 */

import { getClient } from "../geminiClient.js";
import { FLASH_MODEL } from "../config.js";
import { runTests, normalizeLanguage } from "./runner.js";
import {
  GENERATE_LEVELS,
  GENERATE_CONCURRENCY,
  GENERATE_DEBUGGING,
  GENERATE_SYSTEM_DESIGN,
  GENERATE_DESIGN_REVIEW,
} from "./prompts.js";

export const FORMATS = ["levels", "concurrency", "debugging", "system-design", "design-review", "screen"];
export const CODING_FORMATS = ["levels", "concurrency", "debugging"];
const LEVELED_FORMATS = ["levels", "concurrency"];

// ── Gemini helper ───────────────────────────────────────────────────────────

export async function generateJson({ systemInstruction, prompt, schema }) {
  const client = getClient();
  if (!client) throw new Error("No Gemini client configured");
  const response = await client.models.generateContent({
    model: FLASH_MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { systemInstruction, responseMimeType: "application/json", responseSchema: schema },
  });
  const text = response?.candidates?.[0]?.content?.parts
    ?.filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join("");
  if (!text) throw new Error("The model returned no content");
  return JSON.parse(text);
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const STR = { type: "string" };
const TEST = {
  type: "object",
  properties: { name: STR, code: STR, hidden: { type: "boolean" } },
  required: ["name", "code", "hidden"],
};

const SCHEMAS = {
  leveled: {
    type: "object",
    properties: {
      title: STR,
      summary: STR,
      difficulty: STR,
      setup: STR,
      starter: STR,
      levels: {
        type: "array",
        items: {
          type: "object",
          properties: { title: STR, spec: STR, tests: { type: "array", items: TEST } },
          required: ["title", "spec", "tests"],
        },
      },
      reference: STR,
      interviewerNotes: { type: "array", items: STR },
    },
    required: ["title", "summary", "starter", "levels", "reference"],
  },
  debugging: {
    type: "object",
    properties: {
      title: STR,
      summary: STR,
      difficulty: STR,
      setup: STR,
      context: STR,
      buggy: STR,
      reference: STR,
      bugs: {
        type: "array",
        items: { type: "object", properties: { location: STR, description: STR }, required: ["location", "description"] },
      },
      tests: { type: "array", items: TEST },
    },
    required: ["title", "context", "buggy", "reference", "bugs", "tests"],
  },
  "system-design": {
    type: "object",
    properties: {
      title: STR,
      prompt: STR,
      questions: {
        type: "array",
        items: { type: "object", properties: { question: STR, strongAnswer: STR }, required: ["question", "strongAnswer"] },
      },
      twists: { type: "array", items: STR },
    },
    required: ["title", "prompt", "questions", "twists"],
  },
  "design-review": {
    type: "object",
    properties: {
      title: STR,
      summary: STR,
      doc: STR,
      flaws: {
        type: "array",
        items: {
          type: "object",
          properties: { title: STR, severity: STR, location: STR, explanation: STR },
          required: ["title", "severity", "explanation"],
        },
      },
    },
    required: ["title", "doc", "flaws"],
  },
};

const DEFAULT_TOPICS = {
  levels: "any realistic in-memory system — pick something different from a bank if no topic is given",
  concurrency: "a web crawler over a simulated site",
  debugging: "a small service module, e.g. an LRU cache, a rate limiter, an event scheduler or an order book",
  "system-design": "a backend system involving a slow, expensive model or GPU dependency, e.g. an LLM inference API, a batch evaluation platform, or a chat service with streaming responses",
  "design-review": "a backend service design, e.g. a job queue, a usage-metering service, a feature-flag system, or a document search index",
};

// ── Normalising ─────────────────────────────────────────────────────────────

function normalizeTests(tests, prefix) {
  return (tests || [])
    .filter((t) => t && String(t.code || "").trim())
    .map((t, i) => ({ id: `${prefix}${i + 1}`, name: String(t.name || `test ${i + 1}`), code: String(t.code), hidden: Boolean(t.hidden) }));
}

export function normalizePayload(format, raw) {
  if (LEVELED_FORMATS.includes(format)) {
    return {
      title: raw.title || "Untitled",
      summary: raw.summary || "",
      difficulty: raw.difficulty || "",
      setup: raw.setup || "",
      starter: raw.starter || "",
      reference: raw.reference || "",
      interviewerNotes: raw.interviewerNotes || [],
      levels: (raw.levels || []).map((lv, i) => ({
        title: lv.title || `Level ${i + 1}`,
        spec: lv.spec || "",
        tests: normalizeTests(lv.tests, `L${i + 1}-`),
      })),
    };
  }
  if (format === "debugging") {
    return {
      title: raw.title || "Untitled",
      summary: raw.summary || "",
      difficulty: raw.difficulty || "",
      setup: raw.setup || "",
      context: raw.context || "",
      buggy: raw.buggy || raw.starter || "",
      reference: raw.reference || "",
      bugs: raw.bugs || [],
      tests: normalizeTests(raw.tests, "T"),
    };
  }
  if (format === "system-design") {
    return { title: raw.title || "Untitled", prompt: raw.prompt || "", questions: raw.questions || [], twists: raw.twists || [] };
  }
  if (format === "design-review") {
    return { title: raw.title || "Untitled", summary: raw.summary || "", doc: raw.doc || "", flaws: raw.flaws || [] };
  }
  if (format === "screen") {
    return { title: raw.title || "Screening call", jobDescription: raw.jobDescription || "" };
  }
  throw new Error(`Unknown format "${format}"`);
}

function allTests(format, payload) {
  return LEVELED_FORMATS.includes(format) ? payload.levels.flatMap((l) => l.tests) : payload.tests || [];
}

// ── Verification ────────────────────────────────────────────────────────────

/**
 * Run the reference against every test and drop the ones it fails.
 * Returns { payload, report } — report explains what was dropped and why.
 */
export async function verifyPayload(format, payload, language) {
  if (!CODING_FORMATS.includes(format)) return { payload, report: { verified: false, reason: "not a coding format" } };
  if (!payload.reference.trim()) return { payload, report: { verified: false, reason: "no reference solution to verify against" } };

  const tests = allTests(format, payload);
  const ref = await runTests({ language, solution: payload.reference, setup: payload.setup, tests });
  if (ref.compileError) {
    return { payload, report: { verified: false, failed: true, reason: `Reference solution did not run: ${ref.compileError}` } };
  }
  const passing = new Set(ref.results.filter((r) => r.status === "pass").map((r) => r.id));
  const dropped = tests.filter((t) => !passing.has(t.id)).map((t) => {
    const r = ref.results.find((x) => x.id === t.id);
    return { id: t.id, name: t.name, status: r?.status, message: r?.message };
  });

  const keep = (list) => list.filter((t) => passing.has(t.id));
  const verified = LEVELED_FORMATS.includes(format)
    ? { ...payload, levels: payload.levels.map((l) => ({ ...l, tests: keep(l.tests) })) }
    : { ...payload, tests: keep(payload.tests) };

  const report = { verified: true, total: tests.length, kept: passing.size, dropped };

  // Every level must still have something to pass, and at least one visible test.
  if (LEVELED_FORMATS.includes(format)) {
    const thin = verified.levels.findIndex((l) => l.tests.length === 0 || !l.tests.some((t) => !t.hidden));
    if (thin !== -1) return { payload: verified, report: { ...report, failed: true, reason: `Level ${thin + 1} has no verified visible tests` } };
  }

  // A debugging problem is only useful if the buggy code actually fails something.
  if (format === "debugging") {
    if (verified.tests.length === 0) return { payload: verified, report: { ...report, failed: true, reason: "No verified tests" } };
    const buggy = await runTests({ language, solution: verified.buggy, setup: verified.setup, tests: verified.tests });
    const failing = buggy.compileError ? verified.tests.length : buggy.results.filter((r) => r.status !== "pass").length;
    report.failingOnBuggy = failing;
    if (failing === 0) return { payload: verified, report: { ...report, failed: true, reason: "The buggy code passes every test" } };
  }

  return { payload: verified, report };
}

// ── Generation ──────────────────────────────────────────────────────────────

function generationSetup(format) {
  switch (format) {
    case "levels": return { instruction: GENERATE_LEVELS, schema: SCHEMAS.leveled };
    case "concurrency": return { instruction: GENERATE_CONCURRENCY, schema: SCHEMAS.leveled };
    case "debugging": return { instruction: GENERATE_DEBUGGING, schema: SCHEMAS.debugging };
    case "system-design": return { instruction: GENERATE_SYSTEM_DESIGN, schema: SCHEMAS["system-design"] };
    case "design-review": return { instruction: GENERATE_DESIGN_REVIEW, schema: SCHEMAS["design-review"] };
    default: throw new Error(`Format "${format}" cannot be generated`);
  }
}

export async function generateProblem({ format, language, topic, difficulty }) {
  const { instruction, schema } = generationSetup(format);
  const lang = CODING_FORMATS.includes(format) ? normalizeLanguage(language) || "python" : "";
  const basePrompt = [
    `Create one new exercise.`,
    lang ? `Language: ${lang === "python" ? "Python 3" : "JavaScript (Node.js)"}. All code (setup, starter, buggy, reference, tests) must be in this language.` : "",
    `Topic: ${topic?.trim() || DEFAULT_TOPICS[format]}.`,
    difficulty ? `Difficulty: ${difficulty}.` : "Difficulty: senior engineer interview.",
  ].filter(Boolean).join("\n");

  let feedback = "";
  let lastReport = null;
  // Two tries: the second one is told exactly which tests failed and why.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await generateJson({ systemInstruction: instruction, prompt: basePrompt + feedback, schema });
    const payload = normalizePayload(format, raw);
    const { payload: verified, report } = await verifyPayload(format, payload, lang);
    lastReport = report;
    if (!report.failed) return { payload: verified, report, language: lang };

    const details = (report.dropped || []).slice(0, 8).map((d) => `- ${d.name}: ${d.status} ${d.message || ""}`).join("\n");
    feedback = `\n\nA previous attempt was rejected: ${report.reason}.${details ? `\nTests the reference solution failed:\n${details}` : ""}\nMake sure the reference passes every test, and that every level has visible tests.`;
  }
  const err = new Error(`Could not generate a verified problem: ${lastReport?.reason || "unknown reason"}`);
  err.report = lastReport;
  throw err;
}

// ── Views ───────────────────────────────────────────────────────────────────

const visible = (tests) => tests.filter((t) => !t.hidden).map(({ id, name, code }) => ({ id, name, code }));
const hiddenCount = (tests) => tests.filter((t) => t.hidden).length;

export function publicView(problem) {
  const { id, format, language, difficulty, topic, source, created_at: createdAt, payload: p } = problem;
  const base = { id, format, title: p.title, language, difficulty, topic, source, createdAt };
  if (LEVELED_FORMATS.includes(format)) {
    return {
      ...base,
      summary: p.summary,
      setup: p.setup,
      starter: p.starter,
      levels: p.levels.map((l) => ({ title: l.title, spec: l.spec, visibleTests: visible(l.tests), hiddenCount: hiddenCount(l.tests) })),
    };
  }
  if (format === "debugging") {
    return { ...base, summary: p.summary, setup: p.setup, context: p.context, starter: p.buggy, visibleTests: visible(p.tests), hiddenCount: hiddenCount(p.tests) };
  }
  if (format === "system-design") return { ...base, prompt: p.prompt };
  if (format === "design-review") return { ...base, summary: p.summary, doc: p.doc };
  if (format === "screen") return { ...base, jobDescription: p.jobDescription };
  return base;
}

/** What the interviewer and the scorecard may know but the candidate's browser never receives. */
export function privateBrief(problem) {
  if (!problem) return "";
  const { format, payload: p } = problem;
  const lines = [`## Private brief — never reveal`, `Exercise: ${p.title}`];
  if (LEVELED_FORMATS.includes(format)) {
    if (p.setup) lines.push("", "### Helper code the candidate can see", "```", p.setup, "```");
    p.levels.forEach((l, i) => lines.push("", `### Level ${i + 1}: ${l.title}`, l.spec));
    if (p.interviewerNotes?.length) lines.push("", "### Follow-up and debrief questions", ...p.interviewerNotes.map((q) => `- ${q}`));
  } else if (format === "debugging") {
    lines.push("", "### README the candidate sees", p.context, "", "### Planted bugs", ...p.bugs.map((b, i) => `${i + 1}. ${b.location}: ${b.description}`));
  } else if (format === "system-design") {
    lines.push("", "### Opening prompt", p.prompt, "", "### Question plan (in order)", ...p.questions.map((q, i) => `${i + 1}. ${q.question}\n   Strong answer covers: ${q.strongAnswer}`));
    lines.push("", "### Twists (inject one around the midpoint)", ...p.twists.map((t) => `- ${t}`));
  } else if (format === "design-review") {
    lines.push("", "### The document under review", p.doc, "", "### Planted flaws", ...p.flaws.map((f, i) => `${i + 1}. [${f.severity}] ${f.title}${f.location ? ` (${f.location})` : ""}: ${f.explanation}`));
  } else if (format === "screen") {
    lines.push("", "### Job description", p.jobDescription || "(none provided — ask about their target role)");
  }
  return lines.join("\n");
}

// ── Running a candidate's code ──────────────────────────────────────────────

function summarize(tests, results) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const vis = tests.filter((t) => !t.hidden).map((t) => {
    const r = byId.get(t.id) || { status: "not-run", message: "", stdout: "" };
    return { id: t.id, name: t.name, code: t.code, status: r.status, message: r.message, stdout: r.stdout, durationMs: r.durationMs };
  });
  const hid = tests.filter((t) => t.hidden);
  const hidPassed = hid.filter((t) => byId.get(t.id)?.status === "pass").length;
  return {
    visible: vis,
    hidden: { passed: hidPassed, total: hid.length },
    passed: tests.length > 0 && tests.every((t) => byId.get(t.id)?.status === "pass"),
  };
}

export async function runCandidate(problem, { code, level }) {
  const { format, language, payload: p } = problem;
  if (LEVELED_FORMATS.includes(format)) {
    const upTo = Math.max(1, Math.min(Number(level) || 1, p.levels.length));
    const levels = p.levels.slice(0, upTo);
    const run = await runTests({ language, solution: code, setup: p.setup, tests: levels.flatMap((l) => l.tests) });
    const perLevel = levels.map((l, i) => ({ level: i + 1, title: l.title, ...summarize(l.tests, run.results) }));
    return {
      compileError: run.compileError || "",
      stdout: run.stdout || "",
      levels: perLevel,
      levelPassed: perLevel.every((l) => l.passed),
      regressions: perLevel.slice(0, -1).filter((l) => !l.passed).map((l) => l.level),
      durationMs: run.durationMs,
    };
  }
  if (format === "debugging") {
    const run = await runTests({ language, solution: code, setup: p.setup, tests: p.tests });
    return { compileError: run.compileError || "", stdout: run.stdout || "", ...summarize(p.tests, run.results), durationMs: run.durationMs };
  }
  throw new Error(`Format "${format}" has no tests to run`);
}
