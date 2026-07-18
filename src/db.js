import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const dataDir = path.join(projectRoot, "data");

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "leetlive.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    problem_name TEXT DEFAULT '',
    difficulty TEXT DEFAULT '',
    category TEXT DEFAULT '',
    code TEXT DEFAULT '',
    solve_data TEXT DEFAULT '{}',
    viz_html TEXT DEFAULT '',
    transcript_history TEXT DEFAULT '[]',
    timer_seconds INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const stmtGetAll = db.prepare(`
  SELECT id, problem_name, difficulty, category, created_at, updated_at
  FROM sessions
  ORDER BY updated_at DESC
`);

const stmtGetById = db.prepare(`
  SELECT * FROM sessions WHERE id = ?
`);

const stmtUpsert = db.prepare(`
  INSERT OR REPLACE INTO sessions
    (id, problem_name, difficulty, category, code, solve_data, viz_html, transcript_history, timer_seconds, created_at, updated_at)
  VALUES
    (@id, @problem_name, @difficulty, @category, @code, @solve_data, @viz_html, @transcript_history, @timer_seconds, @created_at, @updated_at)
`);

const stmtDelete = db.prepare(`DELETE FROM sessions WHERE id = ?`);

const stmtDeleteAll = db.prepare(`DELETE FROM sessions`);

export function getAllSessions() {
  return stmtGetAll.all();
}

export function getSession(id) {
  return stmtGetById.get(id);
}

export function upsertSession(session) {
  const now = new Date().toISOString();
  const row = {
    id: session.id,
    problem_name: session.problem_name ?? "",
    difficulty: session.difficulty ?? "",
    category: session.category ?? "",
    code: session.code ?? "",
    solve_data: session.solve_data ?? "{}",
    viz_html: session.viz_html ?? "",
    transcript_history: session.transcript_history ?? "[]",
    timer_seconds: session.timer_seconds ?? 0,
    created_at: session.created_at || now,
    updated_at: now,
  };
  stmtUpsert.run(row);
  return row;
}

export function deleteSession(id) {
  stmtDelete.run(id);
}

export function deleteAllSessions() {
  stmtDeleteAll.run();
}
