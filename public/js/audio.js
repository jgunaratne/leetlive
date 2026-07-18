/**
 * LeetLive — Audio I/O
 *
 * Playback of Gemini's PCM audio (24kHz) and microphone capture (16kHz PCM),
 * both over Web Audio.
 */

import { btnMic, statusText } from "./dom.js";

const GEMINI_SAMPLE_RATE = 24000;
const MIC_SAMPLE_RATE = 16000;

let audioContext = null;
let micStream = null;
let micProcessor = null;
let isRecording = false;
let nextPlayTime = 0;

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
  const startTime = Math.max(now + 0.04, nextPlayTime);
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
    const processor = micCtx.createScriptProcessor(4096, 1, 1);
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
    statusText.textContent = "Microphone access denied";
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
