/**
 * LeetLive — Audio I/O
 *
 * Playback of Gemini's PCM audio (24kHz) and microphone capture (16kHz PCM),
 * both over Web Audio.
 */

import { btnMic, statusText } from "./dom.js";

const GEMINI_SAMPLE_RATE = 24000;
const MIC_SAMPLE_RATE = 16000;

// Mic frames per callback. 2048 @ 16kHz = 128ms per chunk — small enough that
// the start of an utterance reaches Gemini quickly, large enough to avoid
// flooding the socket.
const MIC_BUFFER_SIZE = 2048;

// How far ahead of the clock the first chunk of a reply is scheduled. Gemini
// streams audio faster than real time, so this only costs latency once per
// turn, and it absorbs network jitter that would otherwise gap the speech.
const PLAYBACK_LEAD = 0.12;

let audioContext = null;
let micStream = null;
let micProcessor = null;
let isRecording = false;
let nextPlayTime = 0;
// Sources still scheduled to play, so an interruption can cut them off.
let activeSources = new Set();

// ── Playback ────────────────────────────────────────────────────────────────

function ensureAudioContext() {
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext({ sampleRate: GEMINI_SAMPLE_RATE });
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  return audioContext;
}

export function resetPlayback() {
  nextPlayTime = 0;
  activeSources.clear();
  if (audioContext && audioContext.state !== "closed") {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

/**
 * Stop anything still queued without tearing down the context. Called when the
 * candidate talks over the interviewer: Gemini streams a whole turn's audio in
 * a few seconds, so without this the buffered speech keeps playing for a long
 * time after the model has already been interrupted.
 */
export function flushPlayback() {
  for (const source of activeSources) {
    try { source.stop(); } catch {}
    source.disconnect();
  }
  activeSources.clear();
  nextPlayTime = 0;
}

export function playAudio(base64Data, mimeType) {
  const ctx = ensureAudioContext();

  // Decode base64 to raw bytes
  const binaryStr = atob(base64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  // Parse sample rate from mimeType (e.g. "audio/pcm;rate=24000")
  const rateMatch = (mimeType || "").match(/rate=(\d+)/);
  const sampleRate = rateMatch ? parseInt(rateMatch[1]) : GEMINI_SAMPLE_RATE;

  // Convert PCM16 to Float32
  const int16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 32768;
  }

  const buffer = ctx.createBuffer(1, float32.length, sampleRate);
  buffer.copyToChannel(float32, 0);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);

  const now = ctx.currentTime;
  // If the stream stalled long enough that our cursor fell behind the clock,
  // resync instead of dumping the backlog at once.
  const startTime = nextPlayTime > now ? nextPlayTime : now + PLAYBACK_LEAD;

  activeSources.add(source);
  source.onended = () => {
    activeSources.delete(source);
    source.disconnect();
  };

  source.start(startTime);
  nextPlayTime = startTime + buffer.duration;
}

// ── Microphone ──────────────────────────────────────────────────────────────

export function micActive() {
  return isRecording;
}

export async function startMic(onChunk) {
  if (isRecording) return;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: MIC_SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const micCtx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
    const source = micCtx.createMediaStreamSource(micStream);

    // Use ScriptProcessor for compatibility (AudioWorklet preferred but needs HTTPS)
    const processor = micCtx.createScriptProcessor(MIC_BUFFER_SIZE, 1, 1);
    processor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0);

      // Convert Float32 to PCM16 base64
      const int16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      const bytes = new Uint8Array(int16.buffer);
      const base64 = btoa(String.fromCharCode(...bytes));
      onChunk(base64);
    };

    source.connect(processor);
    processor.connect(micCtx.destination);

    micProcessor = { processor, source, context: micCtx };
    isRecording = true;
    btnMic.classList.add("recording");
  } catch (err) {
    console.error("[Mic] Failed to start:", err);
    // getUserMedia is only available in a secure context (HTTPS or localhost).
    // On plain HTTP over a LAN hostname, navigator.mediaDevices is undefined.
    if (!window.isSecureContext || !navigator.mediaDevices) {
      statusText.textContent = "Mic needs HTTPS (open this page over https://)";
    } else if (err.name === "NotAllowedError") {
      statusText.textContent = "Microphone blocked — allow it in site settings";
    } else if (err.name === "NotFoundError") {
      statusText.textContent = "No microphone found";
    } else {
      statusText.textContent = `Microphone error: ${err.name}`;
    }
  }
}

export function stopMic() {
  if (micProcessor) {
    try {
      micProcessor.processor.disconnect();
      micProcessor.source.disconnect();
      micProcessor.context.close();
    } catch {}
    micProcessor = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  isRecording = false;
  btnMic.classList.remove("recording");
}
