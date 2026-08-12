/**
 * POST /api/chat — Streaming text chat with the professor.
 *
 * The browser owns the conversation: it posts the full message history plus a
 * freshly-built snapshot of the workspace (code, reference solution,
 * visualization, voice transcript) on every turn. Replies stream back as SSE so
 * the sidebar can render tokens as they arrive instead of waiting for the whole
 * answer.
 */

import { Router } from "express";
import { getClient } from "../geminiClient.js";
import { CHAT_MODEL } from "../config.js";
import { PROFESSOR_CHAT_SYSTEM_INSTRUCTION } from "../prompts.js";

export const chatRouter = Router();

// Long tutoring sessions are fine, but there is no value in replaying an
// unbounded history — the workspace snapshot carries the state that matters.
const MAX_HISTORY_MESSAGES = 40;

chatRouter.post("/api/chat", async (req, res) => {
  const { messages, context } = req.body || {};

  const contents = (Array.isArray(messages) ? messages : [])
    .filter((m) => typeof m?.text === "string" && m.text.trim())
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.text }],
    }));

  if (contents.length === 0) {
    return res.status(400).json({ error: "No messages provided" });
  }

  const client = getClient();
  if (!client) return res.status(500).json({ error: "No Gemini client configured" });

  // The workspace snapshot rides on the system instruction rather than the
  // message history: it is rebuilt from scratch every turn, so the professor
  // always sees the *current* code instead of a stale copy buried in history.
  const workspace = typeof context === "string" ? context.trim() : "";
  const systemInstruction = workspace
    ? `${PROFESSOR_CHAT_SYSTEM_INSTRUCTION}\n\n# Current Workspace\n${workspace}`
    : PROFESSOR_CHAT_SYSTEM_INSTRUCTION;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // The user can abort mid-answer (Stop button, closing the tab). Stop pumping
  // chunks into a dead socket rather than letting the loop run to completion.
  let aborted = false;
  res.on("close", () => { aborted = true; });

  try {
    const stream = await client.models.generateContentStream({
      model: CHAT_MODEL,
      contents,
      config: { systemInstruction },
    });

    for await (const chunk of stream) {
      if (aborted) break;
      const text = (chunk?.candidates?.[0]?.content?.parts || [])
        .filter((p) => p.text && !p.thought)
        .map((p) => p.text)
        .join("");
      if (text) sse(res, { type: "delta", text });
    }

    if (!aborted) sse(res, { type: "done" });
  } catch (err) {
    console.error("[Chat] Error:", err.message);
    if (!aborted) sse(res, { type: "error", error: err.message });
  } finally {
    res.end();
  }
});

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
