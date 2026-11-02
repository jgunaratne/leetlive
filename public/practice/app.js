/**
 * LeetLive practice — page controller.
 *
 * Six formats share one layout: problem on the left, code or notes in the
 * middle, the voice interviewer and scorecard on the right.
 *
 *   levels        timed multi-level exercise; each level must pass (visible +
 *                 hidden tests) to unlock the next, and every run re-checks
 *                 all earlier levels for regressions
 *   concurrency   the same level mechanics on a concurrency problem, with an
 *                 interviewer who pushes twists
 *   debugging     planted bugs + failing tests; find and fix them aloud
 *   system-design interviewer-driven question sequence with a mid-way twist
 *   design-review critique a design doc with planted flaws
 *   screen        recruiter screen against a pasted job description
 *
 * Work in progress is kept in localStorage per format, so a refresh loses nothing.
 */

import { renderMarkdown } from "../js/markdown.js";
import { escapeHtml } from "../js/util.js";
import { initTheme } from "../js/theme.js";
import { createVoice } from "./voice.js";

// ── Format definitions ──────────────────────────────────────────────────────

const FORMATS = {
  levels: {
    label: "Levels",
    blurb: "One system, four levels, about 90 minutes. Each level unlocks when its visible and hidden tests pass, and every earlier level must keep passing.",
    coding: true, leveled: true, generate: true, work: "Code",
    topicHint: "e.g. key-value store with TTL, file storage service, task scheduler",
  },
  concurrency: {
    label: "Concurrency",
    blurb: "Build a correct single-threaded version, then make it concurrent, bounded and resilient as the interviewer pushes twists.",
    coding: true, leveled: true, generate: true, work: "Code",
    topicHint: "e.g. web crawler, rate-limited API client, parallel job runner",
  },
  debugging: {
    label: "Debugging",
    blurb: "A module with planted bugs. Some tests fail now; hidden tests catch the rest. Find and fix them while thinking aloud.",
    coding: true, leveled: false, generate: true, work: "Code",
    topicHint: "e.g. LRU cache, rate limiter, order book, event scheduler",
  },
  "system-design": {
    label: "System Design",
    blurb: "The interviewer drives: a series of focused 5–15 minute questions, a twist around the midpoint, and questions for them at the end.",
    coding: false, generate: true, work: "Notes",
    topicHint: "e.g. LLM inference API, batch evaluation platform, streaming chat service",
    notesPlaceholder: "Sketch requirements, APIs, data model, components and trade-offs here. The interviewer sees these notes.",
  },
  "design-review": {
    label: "Design Review",
    blurb: "Review the design doc as you would a teammate's: find what's wrong, rank it, propose fixes, and say what's right.",
    coding: false, generate: true, work: "Review notes",
    topicHint: "e.g. job queue, usage metering, feature flags, search index",
    notesPlaceholder: "Concerns, severity, and proposed changes. End with your top three.",
  },
  screen: {
    label: "Screen",
    blurb: "A recruiter screen against a real job description: why this company (two or three layers deep), why you fit, and your pitch.",
    coding: false, generate: false, work: "Prep notes",
    notesPlaceholder: "Your why-this-company answer, fit mapping and elevator pitch. The recruiter sees these notes.",
  },
};

const DEFAULT_BUDGETS = { levels: 90, concurrency: 45, debugging: 45, "system-design": 50, "design-review": 45, screen: 30 };
const STORAGE_PREFIX = "leetlive_practice_";
const CONTEXT_DEBOUNCE_MS = 5000;
const CLOCK_CONTEXT_EVERY_MIN = 5;

// ── DOM ─────────────────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const el = {
  formats: $("#pr-formats"),
  blurb: $("#pr-format-blurb"),
  setup: $("#pr-setup"),
  problem: $("#pr-problem"),
  workTitle: $("#pr-work-title"),
  lang: $("#pr-lang"),
  resetCode: $("#pr-reset-code"),
  run: $("#pr-run"),
  editor: $("#pr-editor"),
  results: $("#pr-results"),
  voiceStatus: $("#pr-voice-status"),
  voiceBtn: $("#pr-voice"),
  finish: $("#pr-finish"),
  transcript: $("#pr-transcript"),
  scorecard: $("#pr-scorecard"),
  clockTime: $("#pr-clock-time"),
  clockToggle: $("#pr-clock-toggle"),
  clock: $("#pr-clock"),
  historyToggle: $("#pr-history-toggle"),
  history: $("#pr-history"),
  historyClose: $("#pr-history-close"),
  historyList: $("#pr-history-list"),
  importDialog: $("#pr-import"),
  importJson: $("#pr-import-json"),
  importError: $("#pr-import-error"),
  importSubmit: $("#pr-import-submit"),
};

// ── State ───────────────────────────────────────────────────────────────────

let format = "levels";
let budgets = { ...DEFAULT_BUDGETS };
let runnerInfo = null;
let s = freshState();
let busy = false;
let contextTimer = null;
let lastSentWork = "";
let lastClockMinuteSent = 0;
// The transcript as it stood when the current voice session started. Null when
// no session belongs to the current attempt, so late events from a session that
// was stopped (e.g. on switching problems) are ignored.
let voiceBase = null;

function freshState(problem = null) {
  return {
    problemId: problem?.id || null,
    problem,
    code: problem?.starter || "",
    notes: "",
    currentLevel: 1,
    levelEvents: [],        // [{ level, unlockedAt (elapsed ms), passedAt }]
    complete: false,
    runs: 0,
    regressionsSeen: 0,
    lastResults: null,
    elapsedMs: 0,
    runningSince: null,
    attemptId: null,
    transcript: [],
    scorecard: null,
  };
}

function storageKey(f = format) { return STORAGE_PREFIX + f; }

function save() {
  const copy = { ...s, runningSince: null, elapsedMs: elapsed() };
  try { localStorage.setItem(storageKey(), JSON.stringify(copy)); } catch {}
}

function load(f) {
  try {
    const raw = localStorage.getItem(storageKey(f));
    if (raw) return { ...freshState(), ...JSON.parse(raw) };
  } catch {}
  return freshState();
}

const def = () => FORMATS[format];

// ── Helpers ─────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

function elapsed() {
  return s.elapsedMs + (s.runningSince ? Date.now() - s.runningSince : 0);
}

function fmtClock(ms) {
  const neg = ms < 0;
  const total = Math.floor(Math.abs(ms) / 1000);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${neg ? "+" : ""}${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

const minutes = (ms) => Math.round((ms / 60000) * 10) / 10;

function toast(message, kind = "info") {
  const t = document.createElement("div");
  t.className = `pr-toast pr-toast-${kind}`;
  t.textContent = message;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 3800);
}

// ── Clock ───────────────────────────────────────────────────────────────────

function startClock() {
  if (s.runningSince) return;
  s.runningSince = Date.now();
  if (def().leveled && s.levelEvents.length === 0 && s.problem) {
    s.levelEvents.push({ level: 1, unlockedAt: 0, passedAt: null });
  }
  renderClock();
  save();
}

function pauseClock() {
  if (!s.runningSince) return;
  s.elapsedMs = elapsed();
  s.runningSince = null;
  renderClock();
  save();
}

function renderClock() {
  const budgetMs = budgets[format] * 60000;
  const remaining = budgetMs - elapsed();
  el.clockTime.textContent = fmtClock(remaining);
  el.clock.classList.toggle("over", remaining < 0);
  el.clock.classList.toggle("low", remaining >= 0 && remaining < 5 * 60000);
  el.clockToggle.textContent = s.runningSince ? "Pause" : elapsed() > 0 ? "Resume" : "Start";

  // Let the interviewer pace itself (the system design persona wraps up at ~45 min).
  const m = Math.floor(elapsed() / 60000);
  if (voice.active && s.runningSince && m >= lastClockMinuteSent + CLOCK_CONTEXT_EVERY_MIN) {
    lastClockMinuteSent = m;
    voice.sendContext(`[CONTEXT] Elapsed: ${m} of ${budgets[format]} minutes.`);
  }
}
setInterval(renderClock, 1000);

// ── Voice ───────────────────────────────────────────────────────────────────

const voice = createVoice({
  onStatus: (status) => {
    el.voiceStatus.textContent = status === "live" ? "Live" : status === "connecting" ? "Connecting…" : "Off";
    el.voiceStatus.classList.toggle("live", status === "live");
    el.voiceBtn.textContent = status === "idle" ? "Start voice" : "Stop voice";
  },
  onTranscript: (turns, partial) => {
    if (voiceBase === null) return;
    s.transcript = voiceBase.concat(turns);
    renderTranscript(s.transcript, partial);
    if (!partial) save();
  },
  onError: (message) => toast(message, "error"),
});

function workSnapshot() {
  if (def().coding) return s.code.trim() ? `Candidate's current code:\n\`\`\`\n${s.code}\n\`\`\`` : "The candidate has not written code yet.";
  return s.notes.trim() ? `Candidate's notes:\n${s.notes}` : "The candidate has no notes yet.";
}

function openingContext() {
  const lines = [
    `[CONTEXT] Practice format: ${def().label}. Time budget: ${budgets[format]} minutes; elapsed ${Math.floor(elapsed() / 60000)}.`,
  ];
  if (def().leveled) lines.push(`The candidate is on level ${s.currentLevel} of ${s.problem?.levels?.length || "?"}.`);
  lines.push(workSnapshot());
  if (s.lastResults) lines.push(resultsSummary(s.lastResults));
  if (s.transcript.length) {
    lines.push("This is a continuation. Earlier conversation:\n" + s.transcript.map((t) => `${t.role === "user" ? "Candidate" : "Interviewer"}: ${t.text}`).join("\n"));
  } else {
    lines.push("Begin the session now, following your instructions for the opening.");
  }
  return lines.join("\n\n");
}

function scheduleWorkContext() {
  clearTimeout(contextTimer);
  contextTimer = setTimeout(() => {
    const snap = workSnapshot();
    if (voice.active && snap !== lastSentWork) {
      lastSentWork = snap;
      voice.sendContext(`[CONTEXT] ${snap}`);
    }
  }, CONTEXT_DEBOUNCE_MS);
}

function resultsSummary(r) {
  if (!r) return "";
  if (r.compileError) return `Latest test run: the code did not load — ${r.compileError.split("\n")[0]}`;
  if (r.levels) {
    const parts = r.levels.map((l) => `level ${l.level}: visible ${l.visible.filter((t) => t.status === "pass").length}/${l.visible.length}, hidden ${l.hidden.passed}/${l.hidden.total}${l.passed ? " (passed)" : ""}`);
    return `Latest test run — ${parts.join("; ")}.${r.regressions?.length ? ` Regressions in level ${r.regressions.join(", ")}.` : ""}`;
  }
  return `Latest test run — visible ${r.visible.filter((t) => t.status === "pass").length}/${r.visible.length}, hidden ${r.hidden.passed}/${r.hidden.total}.`;
}

el.voiceBtn.addEventListener("click", async () => {
  if (voice.active) { voice.stop(); return; }
  if (!s.problemId && format !== "screen") { toast("Load or generate a problem first"); return; }
  startClock();
  lastSentWork = workSnapshot();
  lastClockMinuteSent = Math.floor(elapsed() / 60000);
  voiceBase = s.transcript.slice();
  await voice.start({ mode: format, problemId: s.problemId, opening: openingContext() });
});

function renderTranscript(turns, partial) {
  const rows = turns.map((t) => `<div class="pr-turn pr-turn-${t.role}"><span class="pr-turn-who">${t.role === "user" ? "You" : "Interviewer"}</span>${escapeHtml(t.text)}</div>`);
  if (partial?.user) rows.push(`<div class="pr-turn pr-turn-user pr-turn-partial"><span class="pr-turn-who">You</span>${escapeHtml(partial.user)}</div>`);
  if (partial?.assistant) rows.push(`<div class="pr-turn pr-turn-assistant pr-turn-partial"><span class="pr-turn-who">Interviewer</span>${escapeHtml(partial.assistant)}</div>`);
  el.transcript.innerHTML = rows.length ? rows.join("") : `<div class="pr-empty">${voiceHint()}</div>`;
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

function voiceHint() {
  switch (format) {
    case "levels": return "Voice is optional here. The proctor answers spec questions and runs a short debrief when you say you're done.";
    case "concurrency": return "Start voice and the interviewer presents the problem, then pushes twists once your first version works.";
    case "debugging": return "Start voice and talk through your hypotheses as you hunt for the bugs.";
    case "system-design": return "Start voice — the interviewer opens with the problem and drives the questions.";
    case "design-review": return "Read the doc, then start voice to walk the interviewer through your review.";
    case "screen": return "Paste a job description, add your prep notes, then start voice for the recruiter call.";
    default: return "";
  }
}

// ── Setup panel (generate / pick / import) ──────────────────────────────────

async function renderSetup() {
  const d = def();
  const runnerNote = d.coding && runnerInfo && !Object.values(runnerInfo.languages).some((l) => l.available)
    ? `<div class="pr-error">No code runner is available on the server: ${escapeHtml(Object.values(runnerInfo.languages).map((l) => l.detail).join("; "))}</div>`
    : "";

  let existing = [];
  try { existing = await api(`/api/practice/problems?format=${encodeURIComponent(format)}`); } catch {}
  const options = existing.map((p) => `<option value="${p.id}" ${p.id === s.problemId ? "selected" : ""}>${escapeHtml(p.title)}${p.language ? ` · ${p.language}` : ""}${p.source === "imported" ? " · yours" : ""}</option>`).join("");
  const picker = existing.length
    ? `<label class="pr-field"><span>Saved</span><select id="pr-pick"><option value="">— pick a saved problem —</option>${options}</select></label>`
    : "";

  if (format === "screen") {
    el.setup.innerHTML = `
      ${picker}
      <details class="pr-gen" ${s.problemId ? "" : "open"}>
        <summary>New screen from a job description</summary>
        <label class="pr-field"><span>Role</span><input id="pr-screen-title" placeholder="e.g. Software Engineer, Prototyping"></label>
        <label class="pr-field pr-field-col"><span>Job description</span><textarea id="pr-screen-jd" rows="6" placeholder="Paste the job description"></textarea></label>
        <button id="pr-screen-create" class="pr-btn pr-btn-primary">Use this job description</button>
      </details>`;
    $("#pr-screen-create").addEventListener("click", createScreen);
  } else {
    el.setup.innerHTML = `
      ${runnerNote}
      ${picker}
      <details class="pr-gen" ${s.problemId ? "" : "open"}>
        <summary>Generate a new problem</summary>
        <label class="pr-field"><span>Topic</span><input id="pr-topic" placeholder="${escapeHtml(d.topicHint || "")}"></label>
        <div class="pr-field-row">
          ${d.coding ? `<label class="pr-field"><span>Language</span><select id="pr-language"><option value="python">Python</option><option value="javascript">JavaScript</option></select></label>` : ""}
          <label class="pr-field"><span>Level</span><select id="pr-difficulty"><option value="senior engineer interview">Senior</option><option value="mid-level engineer interview">Mid-level</option><option value="staff engineer interview, demanding">Staff</option></select></label>
        </div>
        <div class="pr-gen-actions">
          <button id="pr-generate" class="pr-btn pr-btn-primary">Generate</button>
          <button id="pr-import-open" class="pr-btn pr-btn-ghost">Import JSON…</button>
        </div>
        <div id="pr-gen-status" class="pr-muted"></div>
      </details>`;
    $("#pr-generate").addEventListener("click", generate);
    $("#pr-import-open").addEventListener("click", () => {
      el.importError.textContent = "";
      el.importDialog.showModal();
    });
    try {
      const lastLang = localStorage.getItem(STORAGE_PREFIX + "language");
      if (lastLang && $("#pr-language")) $("#pr-language").value = lastLang;
    } catch {}
  }

  $("#pr-pick")?.addEventListener("change", (e) => e.target.value && loadProblem(e.target.value));
}

async function generate() {
  if (busy) return;
  busy = true;
  const btn = $("#pr-generate");
  const status = $("#pr-gen-status");
  btn.disabled = true;
  status.textContent = def().coding
    ? "Generating, then running the reference solution to verify every test… this can take a minute."
    : "Generating…";
  const language = $("#pr-language")?.value;
  if (language) { try { localStorage.setItem(STORAGE_PREFIX + "language", language); } catch {} }
  try {
    const { problem, verification } = await api("/api/practice/problems/generate", {
      method: "POST",
      body: { format, language, topic: $("#pr-topic").value, difficulty: $("#pr-difficulty").value },
    });
    if (verification?.dropped?.length) {
      toast(`Dropped ${verification.dropped.length} generated test(s) the reference solution failed`);
    }
    setProblem(problem);
    renderSetup();
  } catch (err) {
    status.textContent = err.message;
    status.classList.add("pr-error");
  } finally {
    btn.disabled = false;
    busy = false;
  }
}

async function createScreen() {
  const jobDescription = $("#pr-screen-jd").value.trim();
  if (!jobDescription) { toast("Paste a job description first"); return; }
  const { problem } = await api("/api/practice/problems/screen", {
    method: "POST",
    body: { title: $("#pr-screen-title").value.trim() || "Screening call", jobDescription },
  });
  setProblem(problem);
  renderSetup();
}

el.importSubmit.addEventListener("click", async (e) => {
  e.preventDefault();
  el.importError.textContent = "";
  let parsed;
  try { parsed = JSON.parse(el.importJson.value); } catch { el.importError.textContent = "That isn't valid JSON."; return; }
  const body = parsed.payload
    ? { format: parsed.format || format, language: parsed.language, payload: parsed.payload }
    : { format, language: parsed.language || $("#pr-language")?.value, payload: parsed };
  try {
    const { problem, verification } = await api("/api/practice/problems/import", { method: "POST", body });
    el.importDialog.close();
    if (verification?.dropped?.length) toast(`Dropped ${verification.dropped.length} test(s) the reference solution failed`);
    if (problem.format !== format) switchFormat(problem.format);
    setProblem(problem);
    renderSetup();
  } catch (err) {
    el.importError.textContent = err.message;
  }
});

async function loadProblem(id) {
  try {
    setProblem(await api(`/api/practice/problems/${id}`));
  } catch (err) {
    toast(err.message, "error");
  }
}

function setProblem(problem) {
  voiceBase = null;
  if (voice.active) voice.stop();
  s = freshState(problem);
  lastSentWork = "";
  save();
  renderAll();
}

// ── Problem panel ───────────────────────────────────────────────────────────

function testList(tests) {
  if (!tests?.length) return "";
  return tests.map((t) => `<div class="pr-test-def"><div class="pr-test-name">${escapeHtml(t.name)}</div><pre><code>${escapeHtml(t.code)}</code></pre></div>`).join("");
}

function renderProblem() {
  const p = s.problem;
  el.blurb.textContent = def().blurb;
  if (!p) {
    el.problem.innerHTML = `<div class="pr-empty">${format === "screen" ? "Paste a job description above to set up the call." : "Generate a problem above, pick a saved one, or import your own."}</div>`;
    return;
  }

  const head = `<h2 class="pr-title">${escapeHtml(p.title)}</h2>${p.summary ? `<p class="pr-muted">${escapeHtml(p.summary)}</p>` : ""}`;
  const helper = p.setup ? `<details class="pr-details"><summary>Helper code (already in scope)</summary><pre><code>${escapeHtml(p.setup)}</code></pre></details>` : "";

  if (def().leveled) {
    const levels = p.levels.map((lv, i) => {
      const n = i + 1;
      const ev = s.levelEvents.find((e) => e.level === n);
      if (n > s.currentLevel) {
        return `<div class="pr-level locked"><div class="pr-level-head"><span>Level ${n}</span><span class="pr-pill">Locked</span></div></div>`;
      }
      const passed = ev?.passedAt != null;
      const took = passed ? ` · ${fmtClock(ev.passedAt - ev.unlockedAt).replace("+", "")}` : "";
      return `
        <div class="pr-level ${passed ? "passed" : n === s.currentLevel ? "current" : ""}">
          <div class="pr-level-head"><span>Level ${n}: ${escapeHtml(lv.title)}</span><span class="pr-pill ${passed ? "pass" : ""}">${passed ? `Passed${took}` : "In progress"}</span></div>
          <div class="pr-md">${renderMarkdown(lv.spec)}</div>
          <details class="pr-details"><summary>Visible tests (${lv.visibleTests.length}) · ${lv.hiddenCount} hidden</summary>${testList(lv.visibleTests)}</details>
        </div>`;
    }).join("");
    el.problem.innerHTML = head + helper + levels + (s.complete ? `<div class="pr-done">All levels passed. Say you're done for the debrief, or End &amp; score.</div>` : "");
    return;
  }

  if (format === "debugging") {
    el.problem.innerHTML = `${head}<div class="pr-md">${renderMarkdown(p.context)}</div>${helper}
      <details class="pr-details"><summary>Visible tests (${p.visibleTests.length}) · ${p.hiddenCount} hidden</summary>${testList(p.visibleTests)}</details>`;
    return;
  }
  if (format === "system-design") {
    el.problem.innerHTML = `${head}<div class="pr-callout"><div class="pr-md">${renderMarkdown(p.prompt)}</div></div>
      <p class="pr-muted">The interviewer holds the question plan and will move you between questions. Answer what's asked first, then go deep.</p>`;
    return;
  }
  if (format === "design-review") {
    el.problem.innerHTML = `${head}<div class="pr-md pr-doc">${renderMarkdown(p.doc)}</div>`;
    return;
  }
  if (format === "screen") {
    el.problem.innerHTML = `${head}<div class="pr-md">${renderMarkdown(p.jobDescription)}</div>`;
  }
}

// ── Work area ───────────────────────────────────────────────────────────────

function renderWork() {
  const d = def();
  el.workTitle.textContent = d.work;
  el.run.classList.toggle("hidden", !d.coding);
  el.resetCode.classList.toggle("hidden", !d.coding || !s.problem);
  el.lang.classList.toggle("hidden", !d.coding || !s.problem?.language);
  el.lang.textContent = s.problem?.language || "";
  el.editor.value = d.coding ? s.code : s.notes;
  el.editor.placeholder = d.coding ? "Load or generate a problem to begin." : d.notesPlaceholder || "";
  el.editor.classList.toggle("pr-notes", !d.coding);
  el.results.classList.toggle("hidden", !d.coding || !s.lastResults);
  if (d.coding && s.lastResults) renderResults(s.lastResults);
}

el.editor.addEventListener("input", () => {
  if (def().coding) s.code = el.editor.value; else s.notes = el.editor.value;
  if (s.problem && !s.runningSince && elapsed() === 0) startClock();
  save();
  scheduleWorkContext();
});

el.editor.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    if (def().coding) runTests();
    return;
  }
  if (e.key !== "Tab") return;
  e.preventDefault();
  const { selectionStart: a, selectionEnd: b, value } = el.editor;
  const lineStart = value.lastIndexOf("\n", a - 1) + 1;
  if (e.shiftKey) {
    const line = value.slice(lineStart);
    const remove = (line.match(/^ {1,4}/) || [""])[0].length;
    if (remove) {
      el.editor.setRangeText("", lineStart, lineStart + remove, "preserve");
      el.editor.selectionStart = el.editor.selectionEnd = Math.max(lineStart, a - remove);
    }
  } else {
    el.editor.setRangeText("    ", a, b, "end");
  }
  el.editor.dispatchEvent(new Event("input"));
});

el.resetCode.addEventListener("click", () => {
  if (!s.problem) return;
  if (!confirm("Replace your code with the starter code?")) return;
  s.code = s.problem.starter || "";
  el.editor.value = s.code;
  save();
});

async function runTests() {
  if (!s.problemId || busy) return;
  busy = true;
  el.run.disabled = true;
  el.run.textContent = "Running…";
  startClock();
  try {
    const r = await api(`/api/practice/problems/${s.problemId}/run`, { method: "POST", body: { code: s.code, level: s.currentLevel } });
    s.runs += 1;
    s.lastResults = r;
    if (r.regressions?.length) {
      s.regressionsSeen += 1;
      toast(`Regression: level ${r.regressions.join(", ")} no longer passes`, "error");
    }
    if (def().leveled && r.levelPassed && !s.complete) advanceLevel();
    renderResults(r);
    el.results.classList.remove("hidden");
    renderProblem();
    save();
    if (voice.active) voice.sendContext(`[CONTEXT] ${resultsSummary(r)}${def().leveled ? ` The candidate is now on level ${s.currentLevel}.` : ""}`);
    autosaveAttempt();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    busy = false;
    el.run.disabled = false;
    el.run.textContent = "Run tests";
  }
}
el.run.addEventListener("click", runTests);

function advanceLevel() {
  const now = elapsed();
  const ev = s.levelEvents.find((e) => e.level === s.currentLevel);
  if (ev && ev.passedAt == null) ev.passedAt = now;
  const total = s.problem.levels.length;
  if (s.currentLevel >= total) {
    s.complete = true;
    toast(`All ${total} levels passed in ${fmtClock(now).replace("+", "")}`, "success");
    return;
  }
  toast(`Level ${s.currentLevel} passed — level ${s.currentLevel + 1} unlocked`, "success");
  s.currentLevel += 1;
  s.levelEvents.push({ level: s.currentLevel, unlockedAt: now, passedAt: null });
}

const STATUS_LABEL = { pass: "Pass", fail: "Fail", error: "Error", timeout: "Timeout", "not-run": "Not run" };

function testRows(tests) {
  return tests.map((t) => `
    <details class="pr-result ${t.status}">
      <summary><span class="pr-status ${t.status}">${STATUS_LABEL[t.status] || t.status}</span><span>${escapeHtml(t.name)}</span></summary>
      ${t.message ? `<pre class="pr-result-msg">${escapeHtml(t.message)}</pre>` : ""}
      ${t.stdout ? `<div class="pr-muted">Output</div><pre>${escapeHtml(t.stdout)}</pre>` : ""}
      <div class="pr-muted">Test</div><pre><code>${escapeHtml(t.code)}</code></pre>
    </details>`).join("");
}

function renderResults(r) {
  const parts = [];
  if (r.compileError) parts.push(`<div class="pr-compile-error"><strong>Your code did not load</strong><pre>${escapeHtml(r.compileError)}</pre></div>`);
  if (r.regressions?.length) parts.push(`<div class="pr-regression">Regression: level ${r.regressions.join(", ")} was passing and now fails. Earlier levels must keep passing.</div>`);
  const groups = r.levels || [{ level: null, title: "", visible: r.visible || [], hidden: r.hidden || { passed: 0, total: 0 }, passed: r.passed }];
  for (const g of groups.slice().reverse()) {
    const visPass = g.visible.filter((t) => t.status === "pass").length;
    parts.push(`
      <div class="pr-result-group ${g.passed ? "passed" : ""}">
        <div class="pr-result-head">
          <span>${g.level ? `Level ${g.level}` : "Tests"}${g.title ? `: ${escapeHtml(g.title)}` : ""}</span>
          <span class="pr-pill ${g.passed ? "pass" : ""}">Visible ${visPass}/${g.visible.length} · Hidden ${g.hidden.passed}/${g.hidden.total}</span>
        </div>
        ${testRows(g.visible)}
      </div>`);
  }
  parts.push(`<div class="pr-muted pr-run-meta">Run ${s.runs} · ${r.durationMs} ms</div>`);
  el.results.innerHTML = parts.join("");
}

// ── Metrics, attempts and the scorecard ─────────────────────────────────────

function metrics() {
  const m = { budgetMinutes: budgets[format], elapsedMinutes: minutes(elapsed()) };
  if (def().leveled && s.problem) {
    m.levelsTotal = s.problem.levels.length;
    m.levelsPassed = s.levelEvents.filter((e) => e.passedAt != null).length;
    m.minutesPerLevel = s.levelEvents.map((e) => ({ level: e.level, minutes: e.passedAt != null ? minutes(e.passedAt - e.unlockedAt) : null, passed: e.passedAt != null }));
    m.runs = s.runs;
    m.regressionsSeen = s.regressionsSeen;
  } else if (format === "debugging" && s.lastResults && !s.lastResults.compileError) {
    m.runs = s.runs;
    m.visiblePassing = `${s.lastResults.visible.filter((t) => t.status === "pass").length}/${s.lastResults.visible.length}`;
    m.hiddenPassing = `${s.lastResults.hidden.passed}/${s.lastResults.hidden.total}`;
  } else if (!def().coding) {
    m.notesWords = s.notes.trim() ? s.notes.trim().split(/\s+/).length : 0;
  }
  m.voiceTurns = s.transcript.length;
  return m;
}

function attemptBody() {
  return {
    id: s.attemptId,
    problemId: s.problemId,
    format,
    title: s.problem?.title || def().label,
    code: def().coding ? s.code : "",
    notes: def().coding ? "" : s.notes,
    transcript: s.transcript,
    results: s.lastResults || {},
    metrics: metrics(),
    scorecard: s.scorecard || {},
  };
}

async function autosaveAttempt() {
  if (!s.problemId) return;
  try {
    const { id } = await api("/api/practice/attempts", { method: "POST", body: attemptBody() });
    s.attemptId = id;
    save();
  } catch {}
}

el.finish.addEventListener("click", async () => {
  if (!s.problemId) { toast("Nothing to score yet"); return; }
  if (busy) return;
  if (voice.active) voice.stop();
  pauseClock();
  busy = true;
  el.finish.disabled = true;
  el.finish.textContent = "Scoring…";
  el.scorecard.classList.remove("hidden");
  el.scorecard.innerHTML = `<div class="pr-muted">Writing your scorecard…</div>`;
  try {
    // Wait a moment so the transcript's last turn is committed after the socket closes.
    await new Promise((r) => setTimeout(r, 400));
    await autosaveAttempt();
    const body = attemptBody();
    s.scorecard = await api("/api/practice/scorecard", {
      method: "POST",
      body: { format, problemId: s.problemId, code: body.code, notes: body.notes, transcript: body.transcript, results: body.results, metrics: body.metrics },
    });
    await autosaveAttempt();
    renderScorecard(s.scorecard, metrics());
    save();
  } catch (err) {
    el.scorecard.innerHTML = `<div class="pr-error">${escapeHtml(err.message)}</div>`;
  } finally {
    busy = false;
    el.finish.disabled = false;
    el.finish.textContent = "End & score";
  }
});

function decisionClass(decision) {
  return "pr-decision-" + String(decision || "").toLowerCase().replace(/[^a-z]+/g, "-");
}

function renderScorecard(sc, m) {
  if (!sc || !sc.decision) { el.scorecard.classList.add("hidden"); return; }
  const list = (title, items) => items?.length ? `<h4>${title}</h4><ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : "";
  const dims = (sc.dimensions || []).map((d) => `
    <div class="pr-dim">
      <div class="pr-dim-head"><span>${escapeHtml(d.name)}</span><span class="pr-dots">${[1, 2, 3, 4].map((i) => `<i class="${i <= d.rating ? "on" : ""}"></i>`).join("")}</span></div>
      <div class="pr-muted">${escapeHtml(d.evidence)}</div>
    </div>`).join("");
  const cov = sc.coverage && (sc.coverage.found?.length || sc.coverage.missed?.length)
    ? `${list("Found", sc.coverage.found)}${list("Missed", sc.coverage.missed)}` : "";
  const facts = m ? `<div class="pr-facts">${Object.entries(m).filter(([, v]) => typeof v !== "object").map(([k, v]) => `<span>${escapeHtml(k.replace(/([A-Z])/g, " $1").toLowerCase())}: <b>${escapeHtml(String(v))}</b></span>`).join("")}</div>` : "";
  el.scorecard.classList.remove("hidden");
  el.scorecard.innerHTML = `
    <div class="pr-decision ${decisionClass(sc.decision)}">${escapeHtml(sc.decision)}</div>
    <p>${escapeHtml(sc.summary)}</p>
    ${facts}
    ${dims}
    ${cov}
    ${list("Strengths", sc.strengths)}
    ${list("Weaknesses", sc.weaknesses)}
    ${list("Practice next", sc.improvements)}
    <button id="pr-new-attempt" class="pr-btn">New attempt on this problem</button>`;
  $("#pr-new-attempt")?.addEventListener("click", () => {
    if (s.problem) setProblem(s.problem);
  });
}

// ── History ─────────────────────────────────────────────────────────────────

async function renderHistory() {
  let attempts = [];
  try { attempts = await api(`/api/practice/attempts?format=${encodeURIComponent(format)}`); } catch {}
  if (!attempts.length) {
    el.historyList.innerHTML = `<div class="pr-empty">No ${escapeHtml(def().label)} attempts yet.</div>`;
    return;
  }
  el.historyList.innerHTML = attempts.map((a) => {
    const m = a.metrics || {};
    const detail = m.levelsTotal ? `${m.levelsPassed}/${m.levelsTotal} levels · ${m.elapsedMinutes} min` : `${m.elapsedMinutes ?? "?"} min`;
    return `<button class="pr-history-item" data-id="${a.id}">
      <span class="pr-history-title">${escapeHtml(a.title)}</span>
      <span class="pr-muted">${new Date(a.updatedAt).toLocaleString()} · ${escapeHtml(detail)}</span>
      ${a.decision ? `<span class="pr-decision-chip ${decisionClass(a.decision)}">${escapeHtml(a.decision)}</span>` : ""}
    </button>`;
  }).join("");
  el.historyList.querySelectorAll(".pr-history-item").forEach((b) => b.addEventListener("click", async () => {
    const a = await api(`/api/practice/attempts/${b.dataset.id}`);
    renderTranscript(a.transcript || [], null);
    renderScorecard(a.scorecard, a.metrics);
    if (!a.scorecard?.decision) {
      el.scorecard.classList.remove("hidden");
      el.scorecard.innerHTML = `<div class="pr-muted">This attempt was not scored.</div>`;
    }
    el.history.classList.add("hidden");
    voiceBase = null;
    if (voice.active) voice.stop();
    toast("Showing a past attempt — your current work is unchanged");
  }));
}

el.historyToggle.addEventListener("click", () => {
  el.history.classList.toggle("hidden");
  if (!el.history.classList.contains("hidden")) renderHistory();
});
el.historyClose.addEventListener("click", () => el.history.classList.add("hidden"));

// ── Format switching ────────────────────────────────────────────────────────

function switchFormat(next) {
  if (next === format) return;
  voiceBase = null;
  if (voice.active) voice.stop();
  pauseClock();
  save();
  format = next;
  s = load(format);
  lastSentWork = "";
  el.formats.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.format === format));
  try { localStorage.setItem(STORAGE_PREFIX + "format", format); } catch {}
  history.replaceState(null, "", `#${format}`);
  renderAll();
}

el.formats.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-format]");
  if (b) switchFormat(b.dataset.format);
});

el.clockToggle.addEventListener("click", () => (s.runningSince ? pauseClock() : startClock()));

function renderAll() {
  renderSetup();
  renderProblem();
  renderWork();
  renderTranscript(s.transcript, null);
  renderScorecard(s.scorecard, s.scorecard ? metrics() : null);
  renderClock();
}

// ── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  initTheme();
  const fromHash = location.hash.slice(1);
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_PREFIX + "format"); } catch {}
  format = FORMATS[fromHash] ? fromHash : FORMATS[saved] ? saved : "levels";
  el.formats.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.format === format));
  s = load(format);
  try {
    const status = await api("/api/practice/status");
    budgets = { ...DEFAULT_BUDGETS, ...(status.budgets || {}) };
    runnerInfo = status.runner;
  } catch {}
  renderAll();
}

window.addEventListener("beforeunload", save);
boot();
