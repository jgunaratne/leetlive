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
    chat_history TEXT DEFAULT '[]',
    mode TEXT DEFAULT '',
    metrics TEXT DEFAULT '{}',
    decision TEXT DEFAULT '{}',
    timer_seconds INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
// every column added after a database was first created has to be patched in by
// hand. Existing databases are in the field with real interview history in them
// — dropping and recreating would take that with it.
const ADDED_COLUMNS = [
  // Added with the professor chat.
  ["chat_history", `TEXT DEFAULT '[]'`],
  // Added with cross-session trends: which mode the attempt ran in, the
  // independence metrics for it, and the hiring decision it produced.
  ["mode", `TEXT DEFAULT ''`],
  ["metrics", `TEXT DEFAULT '{}'`],
  ["decision", `TEXT DEFAULT '{}'`],
];

const columns = db.prepare(`PRAGMA table_info(sessions)`).all().map((c) => c.name);
for (const [name, type] of ADDED_COLUMNS) {
  if (!columns.includes(name)) {
    db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
  }
}

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
    (id, problem_name, difficulty, category, code, solve_data, viz_html, transcript_history, chat_history, mode, metrics, decision, timer_seconds, created_at, updated_at)
  VALUES
    (@id, @problem_name, @difficulty, @category, @code, @solve_data, @viz_html, @transcript_history, @chat_history, @mode, @metrics, @decision, @timer_seconds, @created_at, @updated_at)
`);

// Interview attempts that actually recorded metrics, oldest first — the order
// a trend is read in. Professor sessions are excluded on purpose: that mode is
// teaching, so counting its hints against independence would punish the user
// for using the feature as intended.
const stmtGetTrends = db.prepare(`
  SELECT id, problem_name, difficulty, category, mode, metrics, decision, created_at, updated_at
  FROM sessions
  WHERE mode = 'interview' AND metrics IS NOT NULL AND metrics != '' AND metrics != '{}'
  ORDER BY created_at ASC
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
    chat_history: session.chat_history ?? "[]",
    mode: session.mode ?? "",
    metrics: session.metrics ?? "{}",
    decision: session.decision ?? "{}",
    timer_seconds: session.timer_seconds ?? 0,
    created_at: session.created_at || now,
    updated_at: now,
  };
  stmtUpsert.run(row);
  return row;
}

/**
 * Interview attempts with metrics, oldest first. Each row's metrics and
 * decision are parsed here so callers never have to think about the fact that
 * they are stored as JSON text; a row whose JSON is unreadable is dropped
 * rather than allowed to poison an aggregate.
 */
export function getTrends() {
  return stmtGetTrends
    .all()
    .map((row) => {
      let metrics;
      try {
        metrics = JSON.parse(row.metrics || "{}");
      } catch {
        return null;
      }
      if (!metrics || typeof metrics !== "object") return null;

      let decision = null;
      try {
        const parsed = JSON.parse(row.decision || "{}");
        if (parsed && parsed.decision) decision = parsed;
      } catch {}

      return {
        id: row.id,
        problemName: row.problem_name || "",
        difficulty: row.difficulty || "",
        category: row.category || "Uncategorized",
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        metrics,
        decision: decision ? decision.decision : null,
      };
    })
    .filter(Boolean);
}

export function deleteSession(id) {
  stmtDelete.run(id);
}

export function deleteAllSessions() {
  stmtDeleteAll.run();
}
