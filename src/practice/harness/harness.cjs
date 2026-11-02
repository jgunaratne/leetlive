/**
 * LeetLive practice runner — JavaScript harness.
 *
 * Reads a JSON spec (setup code, solution code, tests) and runs every test
 * against the solution, printing one JSON result line.
 *
 * Each test gets its own vm context with the setup and solution freshly loaded,
 * so module-level state never leaks between tests. Top-level declarations share
 * the context's global lexical scope, so tests use the candidate's classes and
 * functions directly. Each test body runs as an async function, so tests can
 * `await` concurrent code. Tests check behaviour with `assert` (node:assert/strict).
 */

"use strict";

const fs = require("fs");
const vm = require("vm");
const util = require("util");
const assert = require("node:assert/strict");

const MAX_OUTPUT = 2000;
const RESULT_MARKER = "__LEETLIVE_RESULT__";

function trim(text) {
  text = text || "";
  return text.length <= MAX_OUTPUT ? text : text.slice(0, MAX_OUTPUT) + "\n…(truncated)";
}

// The candidate may write ES-module style. Strip `export` keywords so the code
// runs as a plain script; nothing imports from it.
function asScript(code) {
  return String(code || "")
    .replace(/^\s*export\s+default\s+/gm, "")
    .replace(/^(\s*)export\s+(?=(class|function|async|const|let|var)\b)/gm, "$1");
}

function describe(err) {
  if (!err) return "Unknown error";
  const head = `${err.name || "Error"}: ${err.message || String(err)}`;
  const frames = String(err.stack || "")
    .split("\n")
    .slice(1)
    .filter((l) => /solution\.js|setup\.js|test_/.test(l))
    .slice(0, 3);
  return frames.length ? `${head}\n${frames.join("\n")}` : head;
}

async function main() {
  const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const perTestMs = Math.max(500, Number(spec.perTestTimeoutMs) || 5000);

  let sink = [];
  const logger = (...args) => sink.push(args.map((a) => (typeof a === "string" ? a : util.inspect(a))).join(" "));
  const consoleStub = { log: logger, info: logger, warn: logger, error: logger, debug: logger };

  let setupScript = null;
  let solutionScript = null;

  function freshContext() {
    const sandbox = {
      console: consoleStub,
      assert,
      setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask,
      structuredClone, TextEncoder, TextDecoder, URL, URLSearchParams, AbortController,
      performance,
      module: { exports: {} },
    };
    sandbox.exports = sandbox.module.exports;
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    if (setupScript) setupScript.runInContext(context, { timeout: perTestMs });
    solutionScript.runInContext(context, { timeout: perTestMs });
    return context;
  }

  try {
    if (spec.setup) setupScript = new vm.Script(asScript(spec.setup), { filename: "setup.js" });
    solutionScript = new vm.Script(asScript(spec.solution), { filename: "solution.js" });
    freshContext();
  } catch (err) {
    process.stdout.write(RESULT_MARKER + JSON.stringify({ compileError: trim(describe(err)), results: [], stdout: trim(sink.join("\n")) }) + "\n");
    process.exit(0);
  }
  const loadOutput = sink.join("\n");

  const results = [];
  for (const test of spec.tests || []) {
    sink = [];
    const started = performance.now();
    let status = "pass";
    let message = "";
    let timer;
    try {
      const context = freshContext();
      const wrapped = `(async () => {\n${test.code}\n})()`;
      const promise = new vm.Script(wrapped, { filename: `test_${test.id}.js` }).runInContext(context, { timeout: perTestMs });
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`Exceeded ${perTestMs / 1000}s`), { isTimeout: true })), perTestMs);
      });
      await Promise.race([promise, timeout]);
    } catch (err) {
      if (err && (err.isTimeout || err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT")) {
        status = "timeout";
        message = `Exceeded ${perTestMs / 1000}s`;
      } else if (err && (err.code === "ERR_ASSERTION" || err.name === "AssertionError")) {
        status = "fail";
        message = err.message;
      } else {
        status = "error";
        message = describe(err);
      }
    } finally {
      clearTimeout(timer);
    }
    results.push({
      id: test.id,
      status,
      message: trim(message),
      stdout: trim(sink.join("\n")),
      durationMs: Math.round((performance.now() - started) * 10) / 10,
    });
  }

  process.stdout.write(RESULT_MARKER + JSON.stringify({ results, stdout: trim(loadOutput) }) + "\n");
  // Candidate code may have left timers or sockets open.
  process.exit(0);
}

main().catch((err) => {
  process.stdout.write(RESULT_MARKER + JSON.stringify({ compileError: trim(describe(err)), results: [] }) + "\n");
  process.exit(0);
});
