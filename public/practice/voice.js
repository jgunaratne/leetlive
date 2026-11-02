/**
 * LeetLive practice — voice client.
 *
 * A self-contained version of the main app's live session for the practice
 * page: same WebSocket protocol (/ws/gemini-live), same audio formats, but no
 * dependency on the main page's DOM. The server picks the persona from `mode`
 * and adds the private brief for `problem`.
 *
 *   const voice = createVoice({ onStatus, onTranscript, onError })
 *   voice.start({ mode, problemId, opening })   // opening = first [CONTEXT] message
 *   voice.sendContext(text)                      // silent update; never forces a reply
 *   voice.stop()
 *   voice.transcript                             // [{ role: "user" | "assistant", text }]
 */

const PLAYBACK_RATE = 24000;
const MIC_RATE = 16000;
const MIC_BUFFER = 2048;
const PLAYBACK_LEAD = 0.12;
// After the candidate stops talking, how long to wait for the model before
// closing a turn that a silent context update may have left open.
const TURN_WATCHDOG_MS = 1600;

export function createVoice({ onStatus = () => {}, onTranscript = () => {}, onError = () => {} } = {}) {
  let ws = null;
  let ready = false;
  let playCtx = null;
  let nextPlay = 0;
  const sources = new Set();
  let mic = null;
  let modelSpeaking = false;
  let turnLeftOpen = false;
  let watchdog = null;
  let queuedContext = null;
  const transcript = [];
  let pendingUser = "";
  let pendingAssistant = "";

  // ── Playback ──────────────────────────────────────────────────────────────
  function ctx() {
    if (!playCtx || playCtx.state === "closed") playCtx = new AudioContext({ sampleRate: PLAYBACK_RATE });
    if (playCtx.state === "suspended") playCtx.resume();
    return playCtx;
  }

  function play(base64, mimeType) {
    const c = ctx();
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const rate = Number((mimeType || "").match(/rate=(\d+)/)?.[1]) || PLAYBACK_RATE;
    const pcm = new Int16Array(bytes.buffer);
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
    const buf = c.createBuffer(1, f32.length, rate);
    buf.copyToChannel(f32, 0);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    const start = nextPlay > c.currentTime ? nextPlay : c.currentTime + PLAYBACK_LEAD;
    sources.add(src);
    src.onended = () => { sources.delete(src); src.disconnect(); };
    src.start(start);
    nextPlay = start + buf.duration;
  }

  function flush() {
    for (const s of sources) { try { s.stop(); } catch {} s.disconnect(); }
    sources.clear();
    nextPlay = 0;
  }

  // ── Microphone ────────────────────────────────────────────────────────────
  async function startMic() {
    if (!window.isSecureContext || !navigator.mediaDevices) {
      throw new Error("Microphone needs HTTPS (or localhost)");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: MIC_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const micCtx = new AudioContext({ sampleRate: MIC_RATE });
    const source = micCtx.createMediaStreamSource(stream);
    const proc = micCtx.createScriptProcessor(MIC_BUFFER, 1, 1);
    proc.onaudioprocess = (e) => {
      if (!ready) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const b = new Uint8Array(pcm.buffer);
      let str = "";
      for (let i = 0; i < b.length; i++) str += String.fromCharCode(b[i]);
      send({ type: "audio", data: btoa(str) });
    };
    source.connect(proc);
    proc.connect(micCtx.destination);
    mic = { stream, micCtx, source, proc };
  }

  function stopMic() {
    if (!mic) return;
    try { mic.proc.disconnect(); mic.source.disconnect(); mic.micCtx.close(); } catch {}
    mic.stream.getTracks().forEach((t) => t.stop());
    mic = null;
  }

  // ── Transcript ────────────────────────────────────────────────────────────
  function commit(role) {
    const text = (role === "user" ? pendingUser : pendingAssistant).trim();
    if (role === "user") pendingUser = ""; else pendingAssistant = "";
    if (!text) return;
    const last = transcript[transcript.length - 1];
    if (last && last.role === role) last.text += " " + text;
    else transcript.push({ role, text });
    onTranscript(transcript.slice(), null);
  }

  function live() {
    onTranscript(transcript.slice(), { user: pendingUser.trim(), assistant: pendingAssistant.trim() });
  }

  // ── Socket ────────────────────────────────────────────────────────────────
  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function armWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (turnLeftOpen && !modelSpeaking) {
        send({ type: "closeTurn" });
        turnLeftOpen = false;
      }
    }, TURN_WATCHDOG_MS);
  }

  function handle(msg) {
    switch (msg.type) {
      case "status":
        if (msg.status === "connected") {
          ready = true;
          onStatus("live");
        } else if (msg.status === "idle") {
          onStatus("idle");
        }
        break;
      case "audio":
        if (!modelSpeaking) commit("user");
        modelSpeaking = true;
        turnLeftOpen = false;
        clearTimeout(watchdog);
        play(msg.data, msg.mimeType);
        break;
      case "inputTranscription":
        pendingUser += msg.text;
        live();
        armWatchdog();
        break;
      case "outputTranscription":
        pendingAssistant += msg.text;
        live();
        break;
      case "interrupted":
        flush();
        commit("assistant");
        modelSpeaking = false;
        break;
      case "turnComplete":
        commit("user");
        commit("assistant");
        modelSpeaking = false;
        if (queuedContext) {
          const text = queuedContext;
          queuedContext = null;
          pushContext(text);
        }
        break;
      case "error":
        onError(msg.error || "Voice session error");
        break;
      default:
        break;
    }
  }

  function pushContext(text) {
    send({ type: "context", text, turnComplete: false });
    turnLeftOpen = true;
  }

  return {
    get transcript() { return transcript.slice(); },
    get active() { return Boolean(ws); },

    async start({ mode, problemId, opening }) {
      if (ws) return;
      // Each session reports only its own turns; the page owns the full history.
      transcript.length = 0;
      pendingUser = "";
      pendingAssistant = "";
      onStatus("connecting");
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const params = new URLSearchParams({ mode });
      if (problemId) params.set("problem", problemId);
      ws = new WebSocket(`${protocol}//${location.host}/ws/gemini-live?${params}`);
      ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch {} };
      ws.onclose = () => {
        ready = false;
        ws = null;
        stopMic();
        flush();
        commit("user");
        commit("assistant");
        onStatus("idle");
      };
      ws.onerror = () => onError("Could not reach the voice server");
      ws.onopen = () => {
        // The opening context completes the turn so the interviewer speaks first.
        send({ type: "context", text: opening || "[CONTEXT] The session is starting.", turnComplete: true });
      };
      try {
        ctx();
        await startMic();
      } catch (err) {
        onError(err.message || String(err));
      }
    },

    sendContext(text) {
      if (!ws || !ready) return;
      if (modelSpeaking) { queuedContext = text; return; }
      pushContext(text);
    },

    stop() {
      if (!ws) return;
      send({ type: "disconnect" });
      try { ws.close(); } catch {}
    },
  };
}
