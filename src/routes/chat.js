/**
 * POST /api/chat — Streaming text chat with the professor.
 *
 * The browser owns the conversation: it posts the full message history plus a
 * freshly-built snapshot of the workspace (code, reference solution,
 * visualization, voice transcript) on every turn. Replies stream back as SSE so
 * the sidebar can render tokens as they arrive instead of waiting for the whole
 * answer.
 *
 * GET /api/chat/models — The models the sidebar can pick from: Gemini, plus
 * whatever LM Studio has loaded if it happens to be running.
 */

import { Router } from "express";
import { getClient } from "../geminiClient.js";
import { listLocalModels, streamLocalChat } from "../lmStudioClient.js";
import { CHAT_MODEL, CHAT_MODEL_LABEL } from "../config.js";
import { PROFESSOR_CHAT_SYSTEM_INSTRUCTION } from "../prompts.js";

export const chatRouter = Router();

// Long tutoring sessions are fine, but there is no value in replaying an
// unbounded history — the workspace snapshot carries the state that matters.
const MAX_HISTORY_MESSAGES = 40;

chatRouter.get("/api/chat/models", async (_req, res) => {
  const models = [];
  if (getClient()) {
    models.push({ id: CHAT_MODEL, label: CHAT_MODEL_LABEL, provider: "gemini" });
  }
  for (const id of await listLocalModels()) {
    models.push({ id, label: id, provider: "local" });
  }
  res.json({ models, default: CHAT_MODEL });
});

chatRouter.post("/api/chat", async (req, res) => {
  const { messages, context, model } = req.body || {};

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

  // Anything other than the Gemini model is assumed to be an LM Studio id —
  // those are whatever the user has loaded locally, so there is no fixed list
  // to validate against; LM Studio itself rejects ids it doesn't know.
  const useLocal = typeof model === "string" && model.trim() && model !== CHAT_MODEL;
  const client = useLocal ? null : getClient();
  if (!useLocal && !client) return res.status(500).json({ error: "No Gemini client configured" });

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
  // chunks into a dead socket rather than letting the loop run to completion —
  // and for a local model, cancel the request so the GPU stops too.
  let aborted = false;
  const abort = new AbortController();
  res.on("close", () => { aborted = true; abort.abort(); });

  try {
    const deltas = useLocal
      ? streamLocalChat({
          model: model.trim(),
          systemInstruction,
          history: contents.map((c) => ({ role: c.role, text: c.parts[0].text })),
          signal: abort.signal,
        })
      : geminiDeltas(client, contents, systemInstruction);

    for await (const text of deltas) {
      if (aborted) break;
      if (text) sse(res, { type: "delta", text });
    }

    if (!aborted) sse(res, { type: "done" });
  } catch (err) {
    // A user-initiated Stop surfaces here as an AbortError; that's not a fault.
    if (aborted) return res.end();
    console.error("[Chat] Error:", err.message);
    sse(res, { type: "error", error: err.message });
  } finally {
    res.end();
  }
});

async function* geminiDeltas(client, contents, systemInstruction) {
  const stream = await client.models.generateContentStream({
    model: CHAT_MODEL,
    contents,
    config: { systemInstruction },
  });
  for await (const chunk of stream) {
    yield (chunk?.candidates?.[0]?.content?.parts || [])
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("");
  }
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
