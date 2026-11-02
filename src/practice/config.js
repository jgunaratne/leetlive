/**
 * LeetLive practice formats — configuration.
 *
 * Kept separate from src/config.js so the practice features can change without
 * touching the settings the original app depends on.
 */

// Where candidate code runs.
//   "none"   — a local subprocess with a timeout (default; fine for your own code
//              on your own machine).
//   "docker" — a throwaway container with no network, capped memory and CPU.
//              Recommended if you run generated tests you haven't read, or expose
//              the app beyond your own network.
export const RUNNER_SANDBOX = (process.env.RUNNER_SANDBOX || "none").toLowerCase();

export const RUNNER_PYTHON = process.env.RUNNER_PYTHON || "python3";
export const RUNNER_NODE = process.env.RUNNER_NODE || process.execPath;

export const RUNNER_DOCKER_PYTHON_IMAGE = process.env.RUNNER_DOCKER_PYTHON_IMAGE || "python:3.12-slim";
export const RUNNER_DOCKER_NODE_IMAGE = process.env.RUNNER_DOCKER_NODE_IMAGE || "node:22-slim";
export const RUNNER_DOCKER_MEMORY = process.env.RUNNER_DOCKER_MEMORY || "512m";
export const RUNNER_DOCKER_CPUS = process.env.RUNNER_DOCKER_CPUS || "1";

// Per-test time limit. Concurrency problems sleep on purpose, so this is generous.
export const RUNNER_PER_TEST_TIMEOUT_MS = Number(process.env.RUNNER_PER_TEST_TIMEOUT_MS || 6000);

// Hard ceiling for one whole run, whatever the test count.
export const RUNNER_MAX_RUN_MS = Number(process.env.RUNNER_MAX_RUN_MS || 90000);

export const SUPPORTED_LANGUAGES = ["python", "javascript"];

// Default time budgets per format, in minutes. The UI shows these as the clock.
export const FORMAT_BUDGET_MINUTES = {
  levels: 90,
  concurrency: 45,
  debugging: 45,
  "system-design": 50,
  "design-review": 45,
  screen: 30,
};
