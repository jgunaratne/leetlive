/**
 * LeetLive practice runner.
 *
 * Runs candidate code against a list of tests and returns a result per test.
 * Tests are snippets that use `assert`; a test passes when it runs without
 * throwing. The harness for each language lives in ./harness.
 *
 *   runTests({ language, solution, setup, tests: [{ id, code }] })
 *     → { ok, compileError?, results: [{ id, status, message, stdout, durationMs }], durationMs }
 *
 * status is one of: pass | fail | error | timeout | not-run
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import {
  RUNNER_SANDBOX,
  RUNNER_PYTHON,
  RUNNER_NODE,
  RUNNER_DOCKER_PYTHON_IMAGE,
  RUNNER_DOCKER_NODE_IMAGE,
  RUNNER_DOCKER_MEMORY,
  RUNNER_DOCKER_CPUS,
  RUNNER_PER_TEST_TIMEOUT_MS,
  RUNNER_MAX_RUN_MS,
  SUPPORTED_LANGUAGES,
} from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_DIR = path.join(__dirname, "harness");
const RESULT_MARKER = "__LEETLIVE_RESULT__";
const MAX_CAPTURE = 1_000_000;

const HARNESS = {
  python: { file: "harness.py", local: () => [RUNNER_PYTHON, ["-I", "-u"]], image: () => RUNNER_DOCKER_PYTHON_IMAGE, bin: "python" },
  javascript: { file: "harness.cjs", local: () => [RUNNER_NODE, []], image: () => RUNNER_DOCKER_NODE_IMAGE, bin: "node" },
};

export function normalizeLanguage(language) {
  const l = String(language || "").toLowerCase();
  if (["py", "python", "python3"].includes(l)) return "python";
  if (["js", "javascript", "node", "typescript", "ts"].includes(l)) return "javascript";
  return null;
}

function commandFor(language, workDir) {
  const h = HARNESS[language];
  if (RUNNER_SANDBOX === "docker") {
    return [
      "docker",
      [
        "run", "--rm", "-i",
        "--network", "none",
        "--memory", RUNNER_DOCKER_MEMORY,
        "--cpus", RUNNER_DOCKER_CPUS,
        "--pids-limit", "256",
        "--read-only", "--tmpfs", "/tmp",
        "-v", `${HARNESS_DIR}:/harness:ro`,
        "-v", `${workDir}:/work:ro`,
        "-w", "/work",
        h.image(),
        h.bin, ...(language === "python" ? ["-I", "-u"] : []), `/harness/${h.file}`, "/work/spec.json",
      ],
    ];
  }
  const [bin, args] = h.local();
  return [bin, [...args, path.join(HARNESS_DIR, h.file), path.join(workDir, "spec.json")]];
}

export async function runTests({ language, solution, setup = "", tests = [], perTestTimeoutMs = RUNNER_PER_TEST_TIMEOUT_MS }) {
  const lang = normalizeLanguage(language);
  if (!lang) {
    return { ok: false, compileError: `Unsupported language "${language}". Use one of: ${SUPPORTED_LANGUAGES.join(", ")}.`, results: [] };
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "leetlive-run-"));
  const specTests = tests.map((t) => ({ id: String(t.id), code: String(t.code || "") }));
  fs.writeFileSync(
    path.join(workDir, "spec.json"),
    JSON.stringify({ solution: String(solution || ""), setup: String(setup || ""), tests: specTests, perTestTimeoutMs })
  );

  const started = Date.now();
  const budget = Math.min(RUNNER_MAX_RUN_MS, perTestTimeoutMs * (specTests.length + 2) + 5000);
  const [bin, args] = commandFor(lang, workDir);

  const outcome = await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;
    let child;
    try {
      child = spawn(bin, args, {
        cwd: workDir,
        // Minimal environment: no API keys or other secrets reach candidate code.
        env: { PATH: process.env.PATH, HOME: workDir, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ spawnError: err.message });
      return;
    }
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch {}
    }, budget);
    child.stdout.on("data", (d) => { if (stdout.length < MAX_CAPTURE) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < MAX_CAPTURE) stderr += d; });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ spawnError: err.message });
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, killed });
    });
  });

  fs.rm(workDir, { recursive: true, force: true }, () => {});
  const durationMs = Date.now() - started;

  if (outcome.spawnError) {
    return { ok: false, compileError: `Could not start the ${lang} runner: ${outcome.spawnError}`, results: [], durationMs };
  }

  const line = outcome.stdout.split("\n").find((l) => l.startsWith(RESULT_MARKER));
  if (!line) {
    const reason = outcome.killed
      ? `The run exceeded ${Math.round(budget / 1000)}s and was stopped.`
      : (outcome.stderr || "The runner exited without a result.").slice(-2000);
    return {
      ok: false,
      compileError: reason,
      results: specTests.map((t) => ({ id: t.id, status: outcome.killed ? "timeout" : "not-run", message: "", stdout: "", durationMs: 0 })),
      durationMs,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(line.slice(RESULT_MARKER.length));
  } catch {
    return { ok: false, compileError: "Could not read the runner's result.", results: [], durationMs };
  }

  if (parsed.compileError) {
    return {
      ok: false,
      compileError: parsed.compileError,
      results: specTests.map((t) => ({ id: t.id, status: "not-run", message: "", stdout: "", durationMs: 0 })),
      stdout: parsed.stdout || "",
      durationMs,
    };
  }

  const results = parsed.results || [];
  return { ok: results.every((r) => r.status === "pass"), results, stdout: parsed.stdout || "", durationMs };
}

/** Which languages can actually run here — shown in the UI so a missing interpreter is obvious. */
export async function runnerStatus() {
  const checks = await Promise.all(
    SUPPORTED_LANGUAGES.map(async (language) => {
      const sample = language === "python"
        ? { solution: "def add(a, b):\n    return a + b", tests: [{ id: "1", code: "assert add(1, 2) == 3" }] }
        : { solution: "function add(a, b) { return a + b; }", tests: [{ id: "1", code: "assert.equal(add(1, 2), 3);" }] };
      const r = await runTests({ language, ...sample, perTestTimeoutMs: 3000 });
      return [language, { available: r.ok, detail: r.ok ? "" : r.compileError || "" }];
    })
  );
  return { sandbox: RUNNER_SANDBOX, languages: Object.fromEntries(checks) };
}
