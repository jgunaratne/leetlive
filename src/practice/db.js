/**
 * LeetLive practice formats — storage.
 *
 * A separate SQLite file (data/practice.db) so the original sessions database
 * is never touched by the practice features.
 *
 *   problems — generated or imported practice problems, including the parts the
 *              candidate must not see (hidden tests, reference solution, planted
 *              bugs and flaws, the interviewer's question plan)
 *   attempts — one row per practice run: code or notes, test results, timing,
 *              transcript and the scorecard
 */

import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "..", "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "practice.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS problems (
    id TEXT PRIMARY KEY,
    format TEXT NOT NULL,
    title TEXT NOT NULL,
    language TEXT DEFAULT '',
    difficulty TEXT DEFAULT '',
    topic TEXT DEFAULT '',
    source TEXT DEFAULT 'generated',
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    problem_id TEXT,
    format TEXT NOT NULL,
    title TEXT DEFAULT '',
    code TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    transcript TEXT DEFAULT '[]',
    results TEXT DEFAULT '{}',
    metrics TEXT DEFAULT '{}',
    scorecard TEXT DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS attempts_format ON attempts(format, updated_at);
`);

const parse = (s, fallback) => {
  try { return JSON.parse(s); } catch { return fallback; }
};

export function newId() {
  return crypto.randomUUID();
}

// ── Problems ────────────────────────────────────────────────────────────────

export function saveProblem({ id = newId(), format, title, language = "", difficulty = "", topic = "", source = "generated", payload }) {
  db.prepare(`
    INSERT OR REPLACE INTO problems (id, format, title, language, difficulty, topic, source, payload, created_at)
    VALUES (@id, @format, @title, @language, @difficulty, @topic, @source, @payload, @created_at)
  `).run({ id, format, title, language, difficulty, topic, source, payload: JSON.stringify(payload), created_at: new Date().toISOString() });
  return id;
}

export function listProblems(format) {
  const rows = format
    ? db.prepare(`SELECT id, format, title, language, difficulty, topic, source, created_at FROM problems WHERE format = ? ORDER BY created_at DESC`).all(format)
    : db.prepare(`SELECT id, format, title, language, difficulty, topic, source, created_at FROM problems ORDER BY created_at DESC`).all();
  return rows;
}

export function getProblem(id) {
  const row = db.prepare(`SELECT * FROM problems WHERE id = ?`).get(id);
  if (!row) return null;
  return { ...row, payload: parse(row.payload, {}) };
}

export function deleteProblem(id) {
  db.prepare(`DELETE FROM problems WHERE id = ?`).run(id);
}

// ── Attempts ────────────────────────────────────────────────────────────────

export function saveAttempt(a) {
  const now = new Date().toISOString();
  const existing = a.id ? db.prepare(`SELECT created_at FROM attempts WHERE id = ?`).get(a.id) : null;
  const row = {
    id: a.id || newId(),
    problem_id: a.problemId || null,
    format: a.format,
    title: a.title || "",
    code: a.code || "",
    notes: a.notes || "",
    transcript: JSON.stringify(a.transcript || []),
    results: JSON.stringify(a.results || {}),
    metrics: JSON.stringify(a.metrics || {}),
    scorecard: JSON.stringify(a.scorecard || {}),
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  db.prepare(`
    INSERT OR REPLACE INTO attempts (id, problem_id, format, title, code, notes, transcript, results, metrics, scorecard, created_at, updated_at)
    VALUES (@id, @problem_id, @format, @title, @code, @notes, @transcript, @results, @metrics, @scorecard, @created_at, @updated_at)
  `).run(row);
  return row.id;
}

function hydrateAttempt(row) {
  return {
    id: row.id,
    problemId: row.problem_id,
    format: row.format,
    title: row.title,
    code: row.code,
    notes: row.notes,
    transcript: parse(row.transcript, []),
    results: parse(row.results, {}),
    metrics: parse(row.metrics, {}),
    scorecard: parse(row.scorecard, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAttempts(format) {
  const rows = format
    ? db.prepare(`SELECT * FROM attempts WHERE format = ? ORDER BY updated_at DESC LIMIT 200`).all(format)
    : db.prepare(`SELECT * FROM attempts ORDER BY updated_at DESC LIMIT 200`).all();
  // The list view only needs headline numbers, not whole transcripts.
  return rows.map((r) => {
    const a = hydrateAttempt(r);
    return {
      id: a.id,
      problemId: a.problemId,
      format: a.format,
      title: a.title,
      metrics: a.metrics,
      decision: a.scorecard?.decision || "",
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    };
  });
}

export function getAttempt(id) {
  const row = db.prepare(`SELECT * FROM attempts WHERE id = ?`).get(id);
  return row ? hydrateAttempt(row) : null;
}

export function deleteAttempt(id) {
  db.prepare(`DELETE FROM attempts WHERE id = ?`).run(id);
}
