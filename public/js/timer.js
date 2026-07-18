/**
 * LeetLive — Coding timer
 *
 * Tracks elapsed time spent on the coding pad. The timer starts
 * automatically on the first keystroke, can be paused / resumed by
 * clicking the timer display, and resets together with the problem.
 * Elapsed seconds are persisted in localStorage so the timer survives
 * page reloads.
 */

const TIMER_STORAGE_KEY = "leetlive_timer";

const timerDisplay = document.getElementById("coding-timer");
const timerTime = document.getElementById("timer-time");
const timerBtn = document.getElementById("timer-toggle");

let elapsedSeconds = 0;
let intervalId = null;
let running = false;
let started = false; // true once the timer has started at least once

// ── Formatting ──────────────────────────────────────────────────────────────

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function render() {
  timerTime.textContent = formatTime(elapsedSeconds);
}

// ── Core ─────────────────────────────────────────────────────────────────────

function tick() {
  elapsedSeconds++;
  render();
  persist();
}

function startTimer() {
  if (running) return;
  running = true;
  started = true;
  timerDisplay.classList.add("timer-running");
  timerDisplay.classList.remove("timer-paused");
  timerBtn.title = "Pause timer";
  timerBtn.querySelector(".timer-icon-pause").style.display = "";
  timerBtn.querySelector(".timer-icon-play").style.display = "none";
  intervalId = setInterval(tick, 1000);
  persist();
}

function pauseTimer() {
  if (!running) return;
  running = false;
  clearInterval(intervalId);
  intervalId = null;
  timerDisplay.classList.remove("timer-running");
  timerDisplay.classList.add("timer-paused");
  timerBtn.title = "Resume timer";
  timerBtn.querySelector(".timer-icon-pause").style.display = "none";
  timerBtn.querySelector(".timer-icon-play").style.display = "";
  persist();
}

export function resetTimer() {
  pauseTimer();
  elapsedSeconds = 0;
  started = false;
  timerDisplay.classList.remove("timer-paused");
  render();
  persist();
}

export function ensureTimerRunning() {
  if (!running) startTimer();
}

// ── Persistence ──────────────────────────────────────────────────────────────

function persist() {
  try {
    localStorage.setItem(
      TIMER_STORAGE_KEY,
      JSON.stringify({ elapsed: elapsedSeconds, running, started })
    );
  } catch {}
}

function restore() {
  try {
    const raw = localStorage.getItem(TIMER_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    elapsedSeconds = data.elapsed || 0;
    started = data.started || false;
    render();
    if (data.running) {
      startTimer();
    } else if (started) {
      // Show paused state
      timerDisplay.classList.add("timer-paused");
      timerBtn.querySelector(".timer-icon-pause").style.display = "none";
      timerBtn.querySelector(".timer-icon-play").style.display = "";
    }
  } catch {}
}

// ── Init ─────────────────────────────────────────────────────────────────────

export function initTimer() {
  // Toggle pause / resume on click
  timerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (running) {
      pauseTimer();
    } else {
      startTimer();
    }
  });

  // Reset timer on click
  const timerResetBtn = document.getElementById("timer-reset");
  if (timerResetBtn) {
    timerResetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      resetTimer();
    });
  }

  restore();
  render();
}
