/**
 * LeetLive — Professor chat sidebar
 *
 * A text conversation with the same instructive-professor persona as the voice
 * tutor, docked to the right of the coding pad. Every message carries a freshly
 * built workspace snapshot (code, reference solution, visualization, voice
 * transcript), so the professor is always looking at what the user sees right
 * now — the text equivalent of how Gemini Live watches the pad.
 *
 * Replies stream in over SSE and are rendered as markdown as they arrive.
 */

import { codePad } from "./dom.js";
import { state, saveState } from "./state.js";
import { buildWorkspaceContext } from "./workspace.js";
import { renderMarkdown } from "./markdown.js";
import { escapeHtml } from "./util.js";

/* ── DOM references ─────────────────────────────────────────────────── */
const chatSidebar = document.querySelector("#chat-sidebar");
const chatMessages = document.querySelector("#chat-messages");
const chatInput = document.querySelector("#chat-input");
const chatResizer = document.querySelector("#chat-resizer");
const btnChatToggle = document.querySelector("#btn-chat-toggle");
const btnChatClose = document.querySelector("#btn-chat-close");
const btnChatClear = document.querySelector("#btn-chat-clear");
const btnChatSend = document.querySelector("#btn-chat-send");

/* ── State ──────────────────────────────────────────────────────────── */
let streaming = false;
let abortController = null;
let onChanged = null;

const MIN_WIDTH = 300;
const MAX_WIDTH = 720;
const WIDTH_KEY = "leetlive_chat_width";

const SUGGESTIONS = [
  { label: "Explain this problem", prompt: "Explain this problem to me in plain language, then tell me what pattern it fits." },
  { label: "Review my code", prompt: "Review the code in my pad. What's wrong or missing, and what would you improve?" },
  { label: "Give me a hint", prompt: "I'm stuck. Give me one small hint that nudges me forward — don't give away the solution." },
  { label: "Walk me through the intuition", prompt: "Walk me through the intuition behind the optimal approach, before any code." },
  { label: "What's the complexity?", prompt: "What's the time and space complexity of my current code, and can it be improved?" },
];

/* ── Rendering ──────────────────────────────────────────────────────── */

function renderEmptyState() {
  chatMessages.innerHTML = `
    <div class="chat-empty">
      <div class="chat-empty-icon">
        <svg width="22" height="22" viewBox="0 0 16 16" fill="none"><path d="M8 1L1 5l7 4 7-4-7-4z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M3 7v4c0 1.7 2.2 3 5 3s5-1.3 5-3V7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><line x1="14" y1="5" x2="14" y2="12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
      </div>
      <p class="chat-empty-title">Office hours are open</p>
      <p class="chat-empty-text">I can see your coding pad, the reference solution, and anything you've discussed out loud. Ask me anything.</p>
      <div class="chat-chips"></div>
    </div>`;

  // Prompts go through dataset rather than an interpolated attribute so quotes
  // in the suggestion text can never break out of the markup.
  const chips = chatMessages.querySelector(".chat-chips");
  for (const s of SUGGESTIONS) {
    const chip = document.createElement("button");
    chip.className = "chat-chip";
    chip.type = "button";
    chip.textContent = s.label;
    chip.dataset.prompt = s.prompt;
    chips.appendChild(chip);
  }
}

/** Attach a copy button to every code block in a rendered reply. */
function decorateCodeBlocks(container) {
  container.querySelectorAll("pre.md-pre").forEach((pre) => {
    if (pre.querySelector(".chat-code-copy")) return;
    const btn = document.createElement("button");
    btn.className = "chat-code-copy";
    btn.type = "button";
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.querySelector("code").textContent);
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = "Copy"; }, 1500);
      } catch {
        btn.textContent = "Failed";
        setTimeout(() => { btn.textContent = "Copy"; }, 1500);
      }
    });
    pre.appendChild(btn);
  });
}

function createMessageEl({ role, text, time }) {
  const el = document.createElement("div");
  el.className = `chat-msg chat-msg-${role}`;
  el.innerHTML = `
    <div class="chat-msg-meta">
      <span class="chat-msg-label">${role === "user" ? "You" : "Professor"}</span>
      <span class="chat-msg-time">${escapeHtml(time || "")}</span>
    </div>
    <div class="chat-msg-body"></div>`;

  const body = el.querySelector(".chat-msg-body");
  if (role === "user") {
    body.textContent = text;
  } else {
    body.innerHTML = renderMarkdown(text);
    decorateCodeBlocks(body);
  }
  chatMessages.appendChild(el);
  return el;
}

export function renderChat() {
  if (!chatMessages) return;
  if (!state.chatHistory.length) {
    renderEmptyState();
    return;
  }
  chatMessages.innerHTML = "";
  state.chatHistory.forEach(createMessageEl);
  scrollToBottom(true);
}

/** Only follow the stream if the user hasn't scrolled up to read something. */
function nearBottom() {
  return chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 120;
}

function scrollToBottom(force = false) {
  if (force || nearBottom()) {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

/* ── Sending ────────────────────────────────────────────────────────── */

function setStreaming(on) {
  streaming = on;
  btnChatSend.classList.toggle("is-streaming", on);
  btnChatSend.title = on ? "Stop generating" : "Send (Enter)";
}

function now() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function sendMessage(text) {
  const trimmed = text.trim();
  if (!trimmed || streaming) return;

  if (!state.chatHistory.length) chatMessages.innerHTML = "";

  const userMsg = { role: "user", text: trimmed, time: now() };
  state.chatHistory.push(userMsg);
  createMessageEl(userMsg);

  chatInput.value = "";
  autoGrow();
  scrollToBottom(true);

  // The reply is pushed into history up front and mutated as chunks land, so a
  // reload mid-answer keeps whatever the professor already said.
  const replyMsg = { role: "assistant", text: "", time: now() };
  state.chatHistory.push(replyMsg);
  const replyEl = createMessageEl(replyMsg);
  const replyBody = replyEl.querySelector(".chat-msg-body");
  replyBody.innerHTML = '<span class="chat-typing"><i></i><i></i><i></i></span>';
  scrollToBottom(true);

  setStreaming(true);
  abortController = new AbortController();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortController.signal,
      body: JSON.stringify({
        // Exclude the empty placeholder we just pushed.
        messages: state.chatHistory.slice(0, -1).map(({ role, text }) => ({ role, text })),
        context: buildWorkspaceContext(),
      }),
    });

    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let failure = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const evt of events) {
        const line = evt.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;

        let msg;
        try { msg = JSON.parse(line.slice(5).trim()); } catch { continue; }

        if (msg.type === "delta") {
          replyMsg.text += msg.text;
          replyBody.innerHTML = renderMarkdown(replyMsg.text);
          scrollToBottom();
        } else if (msg.type === "error") {
          failure = msg.error;
        }
      }
    }

    if (failure) throw new Error(failure);
    if (!replyMsg.text.trim()) throw new Error("The professor had nothing to say. Try again.");

    replyBody.innerHTML = renderMarkdown(replyMsg.text);
    decorateCodeBlocks(replyBody);
  } catch (err) {
    if (err.name === "AbortError") {
      // Keep the partial answer — it's still useful — and mark it as cut short.
      if (replyMsg.text.trim()) {
        replyMsg.text += "\n\n_(stopped)_";
        replyBody.innerHTML = renderMarkdown(replyMsg.text);
        decorateCodeBlocks(replyBody);
      } else {
        state.chatHistory.pop();
        replyEl.remove();
      }
    } else {
      state.chatHistory.pop();
      replyEl.remove();
      const errEl = document.createElement("div");
      errEl.className = "chat-error";
      errEl.textContent = `Couldn't reach the professor: ${err.message}`;
      chatMessages.appendChild(errEl);
      scrollToBottom(true);
    }
  } finally {
    setStreaming(false);
    abortController = null;
    saveState();
    if (onChanged) onChanged();
  }
}

function stopStreaming() {
  if (abortController) abortController.abort();
}

/* ── Composer ───────────────────────────────────────────────────────── */

function autoGrow() {
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 160)}px`;
}

/* ── Open / close / resize ──────────────────────────────────────────── */

export function openChat() {
  document.body.classList.add("chat-open");
  setTimeout(() => chatInput?.focus(), 200);
}

export function closeChat() {
  document.body.classList.remove("chat-open");
}

function toggleChat() {
  if (document.body.classList.contains("chat-open")) closeChat();
  else openChat();
}

function applyWidth(px) {
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px)));
  document.documentElement.style.setProperty("--chat-width", `${width}px`);
  return width;
}

function initResizer() {
  if (!chatResizer) return;

  const stored = Number(localStorage.getItem(WIDTH_KEY));
  if (stored) applyWidth(stored);

  chatResizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    chatResizer.setPointerCapture(e.pointerId);
    document.body.classList.add("chat-resizing");

    const onMove = (ev) => applyWidth(window.innerWidth - ev.clientX);
    const onUp = (ev) => {
      chatResizer.releasePointerCapture(ev.pointerId);
      document.body.classList.remove("chat-resizing");
      chatResizer.removeEventListener("pointermove", onMove);
      chatResizer.removeEventListener("pointerup", onUp);
      const width = parseInt(
        getComputedStyle(document.documentElement).getPropertyValue("--chat-width"),
        10
      );
      if (width) localStorage.setItem(WIDTH_KEY, String(width));
    };

    chatResizer.addEventListener("pointermove", onMove);
    chatResizer.addEventListener("pointerup", onUp);
  });
}

/* ── Public API ─────────────────────────────────────────────────────── */

export function clearChat() {
  stopStreaming();
  state.chatHistory = [];
  renderChat();
  saveState();
}

/** Replace the conversation wholesale — used when loading a saved session. */
export function setChatHistory(history) {
  state.chatHistory = Array.isArray(history) ? history : [];
  renderChat();
}

export function initChat(opts = {}) {
  if (!chatSidebar) return;
  onChanged = opts.onChanged || null;

  renderChat();
  initResizer();
  autoGrow();

  btnChatToggle?.addEventListener("click", toggleChat);
  btnChatClose?.addEventListener("click", closeChat);
  btnChatClear?.addEventListener("click", () => {
    if (state.chatHistory.length && !confirm("Clear this chat with the professor?")) return;
    clearChat();
    if (onChanged) onChanged();
  });

  btnChatSend.addEventListener("click", () => {
    if (streaming) stopStreaming();
    else sendMessage(chatInput.value);
  });

  chatInput.addEventListener("input", autoGrow);
  chatInput.addEventListener("keydown", (e) => {
    // Enter sends; Shift+Enter is a newline, like every other chat box.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage(chatInput.value);
    }
  });

  // Suggestion chips live inside the (re-rendered) empty state, so delegate.
  chatMessages.addEventListener("click", (e) => {
    const chip = e.target.closest(".chat-chip");
    if (chip) sendMessage(chip.dataset.prompt);
  });

  // Cmd/Ctrl+Shift+P jumps straight into office hours from the editor.
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      openChat();
    }
  });

  // Selecting code and hitting the chat button asks about that selection.
  codePad.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "/") {
      e.preventDefault();
      const sel = codePad.value.slice(codePad.selectionStart, codePad.selectionEnd).trim();
      openChat();
      chatInput.value = sel
        ? `Explain this part of my code:\n\`\`\`\n${sel}\n\`\`\`\n`
        : chatInput.value;
      autoGrow();
    }
  });
}
