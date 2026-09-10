import { Router } from "express";
import { getAllSessions, getSession, upsertSession, deleteSession, deleteAllSessions, getTrends } from "../db.js";

export const sessionsRouter = Router();

/**
 * GET /api/trends — how independence is moving across interview attempts.
 *
 * A single interview tells you how one session went. The thing worth knowing is
 * whether you are needing fewer hints than you used to, which only shows up
 * across sessions. JSON only for now; nothing renders this yet.
 */
sessionsRouter.get("/api/trends", (_req, res) => {
  const sessions = getTrends();

  const hintsFor = (s) => s.metrics?.hintCount ?? (s.metrics?.hints?.length || 0);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const round = (n) => (n === null ? null : Math.round(n * 100) / 100);

  const hintCounts = sessions.map(hintsFor);

  // Split the series in half and compare. Earlier gets the smaller half on an
  // odd count, so the recent number — the one being judged — is never a single
  // unlucky session.
  const mid = Math.floor(sessions.length / 2);
  const earlier = hintCounts.slice(0, mid);
  const recent = hintCounts.slice(mid);

  // Worst-first, so a category you are consistently weak in surfaces instead of
  // disappearing into the overall mean.
  const byCategory = new Map();
  for (const s of sessions) {
    const key = s.category || "Uncategorized";
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(s);
  }

  const categories = [...byCategory.entries()]
    .map(([category, rows]) => {
      const counts = rows.map(hintsFor);
      return {
        category,
        sessions: rows.length,
        avgHints: round(mean(counts)),
        unassistedRate: round(counts.filter((c) => c === 0).length / rows.length),
        maxHintLevel: rows.reduce((m, r) => Math.max(m, r.metrics?.highestHintLevel || 0), 0),
      };
    })
    .sort((a, b) => b.avgHints - a.avgHints || a.unassistedRate - b.unassistedRate);

  res.json({
    sessionCount: sessions.length,
    unassistedRate: sessions.length
      ? round(hintCounts.filter((c) => c === 0).length / sessions.length)
      : null,
    avgHintsEarlier: round(mean(earlier)),
    avgHintsRecent: round(mean(recent)),
    categories,
    sessions: sessions.map((s) => ({
      id: s.id,
      problemName: s.problemName,
      difficulty: s.difficulty,
      category: s.category,
      createdAt: s.createdAt,
      decision: s.decision,
      hintCount: hintsFor(s),
      highestHintLevel: s.metrics?.highestHintLevel ?? 0,
      unassisted: hintsFor(s) === 0,
      timeToFirstCodeMs: s.metrics?.timeToFirstCodeMs ?? null,
      timeToApproachMs: s.metrics?.timeToApproachMs ?? null,
    })),
  });
});

sessionsRouter.get("/api/sessions", (_req, res) => {
  const sessions = getAllSessions();
  res.json(sessions);
});

sessionsRouter.get("/api/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  res.json(session);
});

sessionsRouter.put("/api/sessions/:id", (req, res) => {
  const session = { ...req.body, id: req.params.id };
  const saved = upsertSession(session);
  res.json(saved);
});

sessionsRouter.delete("/api/sessions/:id", (req, res) => {
  deleteSession(req.params.id);
  res.json({ ok: true });
});

sessionsRouter.delete("/api/sessions", (_req, res) => {
  deleteAllSessions();
  res.json({ ok: true });
});
