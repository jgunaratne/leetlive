/**
 * LeetLive — LM Studio client
 *
 * Talks to LM Studio's local server through its OpenAI-compatible REST API.
 * There is deliberately no SDK here: two endpoints and a fetch are all it takes,
 * and it keeps the dependency list Gemini-only.
 */

import { LM_STUDIO_URL } from "./config.js";

// LM Studio answers /v1/models instantly when it's up; when it's down the
// connection is refused just as fast. The timeout only matters for the odd
// half-alive state (e.g. the app is open but the server tab is loading).
const PROBE_TIMEOUT_MS = 1500;

/**
 * List the chat-capable models LM Studio currently has available. Resolves to
 * an empty array — never throws — when LM Studio isn't running, so the caller
 * can treat "no local models" and "LM Studio off" the same way.
 */
export async function listLocalModels() {
  try {
    const res = await fetch(`${LM_STUDIO_URL}/v1/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const body = await res.json();
    return (Array.isArray(body?.data) ? body.data : [])
      .map((m) => m?.id)
      .filter((id) => typeof id === "string" && id && !isEmbeddingModel(id));
  } catch {
    return [];
  }
}

// /v1/models lists everything LM Studio has downloaded, embedding models
// included. They can't chat, so keep them out of the dropdown.
function isEmbeddingModel(id) {
  return /embed/i.test(id);
}

/**
 * Stream a chat completion from LM Studio, yielding visible text deltas.
 *
 * @param {object} opts
 * @param {string} opts.model            LM Studio model id
 * @param {string} opts.systemInstruction
 * @param {{role: "user"|"model", text: string}[]} opts.history
 * @param {AbortSignal} [opts.signal]    Aborting stops generation on the GPU, too.
 */
export async function* streamLocalChat({ model, systemInstruction, history, signal }) {
  let res;
  try {
    res = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: "system", content: systemInstruction },
          ...history.map((m) => ({
            role: m.role === "model" ? "assistant" : "user",
            content: m.text,
          })),
        ],
      }),
    });
  } catch (err) {
    if (err.name === "AbortError") return;
    throw new Error(`LM Studio isn't reachable at ${LM_STUDIO_URL} — is its local server running?`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LM Studio returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  const strip = thinkFilter();
  for await (const data of sseData(res.body)) {
    if (data === "[DONE]") break;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    if (chunk.error) throw new Error(chunk.error.message || String(chunk.error));
    const text = chunk?.choices?.[0]?.delta?.content;
    if (typeof text === "string" && text) {
      const visible = strip.push(text);
      if (visible) yield visible;
    }
  }
  const tail = strip.flush();
  if (tail) yield tail;
}

/** Yield the payload of each `data:` line from an SSE byte stream. */
async function* sseData(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  if (buffer.startsWith("data:")) yield buffer.slice(5).trim();
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

/**
 * Drop `<think>…</think>` blocks from a token stream. Reasoning models such as
 * Qwen 3 emit their scratchpad inline, and LM Studio only moves it out of the
 * content field on some versions — the professor's answer should never start
 * with "Okay, the user is asking about…". Tags can straddle chunk boundaries,
 * so any trailing text that could be the start of a tag is held back until
 * the next chunk settles it.
 */
function thinkFilter() {
  let pending = "";
  let thinking = false;

  function drain() {
    let out = "";
    while (pending) {
      const tag = thinking ? THINK_CLOSE : THINK_OPEN;
      const at = pending.indexOf(tag);
      if (at !== -1) {
        if (!thinking) out += pending.slice(0, at);
        pending = pending.slice(at + tag.length);
        thinking = !thinking;
        continue;
      }
      // No full tag: keep back any suffix that is a prefix of the tag we're
      // looking for, emit (or discard, while thinking) everything before it.
      const keep = partialTagSuffix(pending, tag);
      if (!thinking) out += pending.slice(0, pending.length - keep);
      pending = pending.slice(pending.length - keep);
      break;
    }
    return out;
  }

  return {
    push(text) {
      pending += text;
      return drain();
    },
    flush() {
      // Whatever is left can't be a tag any more. Unclosed thinking is
      // discarded — it was never meant for the user.
      const out = thinking ? "" : pending;
      pending = "";
      return out;
    },
  };
}

function partialTagSuffix(text, tag) {
  const max = Math.min(text.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}
