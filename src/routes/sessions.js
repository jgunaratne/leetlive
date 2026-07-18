import { Router } from "express";
import { getAllSessions, getSession, upsertSession, deleteSession, deleteAllSessions } from "../db.js";

export const sessionsRouter = Router();

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
