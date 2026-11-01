# LeetLive

Practice coding interviews by voice. A live AI interviewer runs a phased mock interview while you code, a tutor mode explains concepts, and each session ends with a written hiring-committee scorecard.

<!-- ![Editor, live interviewer and scorecard](docs/screenshot.png) -->
<!-- TODO: 30 s clip: think aloud → interviewer pushes back → scorecard -->

## How it works

```
Browser (editor + mic, AudioWorklet PCM) ──WS──► Node proxy ──► Gemini Live (voice interviewer / tutor)
        │                                           │
        └── REST ──► /api/solve      reference solution + complexity (structured JSON)
                     /api/visualize  self-contained HTML step-through of the algorithm
                     /api/chat       tutor chat sidebar (Gemini or a local LM Studio model)
                     /api/decision   hiring decision from code + transcript + metrics
                                           │
                                     SQLite (sessions, transcripts)
```

- **Interviewer:** a voice agent that tracks five interview phases (clarify → approach → code → test → follow-up). It gives hints that point at what the problem is asking without giving the answer.
- **Tutor mode:** a separate persona that teaches step by step and waits for you at each stage. It can run on a local model through LM Studio.
- **Turn-taking:** silence threshold, end-of-turn sensitivity and prefix padding are configurable, so you can think aloud without being cut off.
- **Scorecard:** the code, transcript and timing metrics are combined into a structured hire/no-hire write-up.

## Stack

Node.js · Express · WebSockets · Gemini Live API (`@google/genai`) · better-sqlite3 · vanilla JS frontend

## Run it

```bash
npm install
cp .env.example .env      # set GEMINI_API_KEY, or GOOGLE_CLOUD_PROJECT for Vertex AI
npm start                 # http://localhost:3000
```

For microphone access on any host other than `localhost`, put `cert.pem` and `key.pem` in `certs/` to serve over HTTPS (see `src/config.js`).
