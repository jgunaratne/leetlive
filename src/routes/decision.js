/**
 * POST /api/decision — Generate a hiring decision using Gemini Flash.
 */

import { Router } from "express";
import { getClient } from "../geminiClient.js";
import { FLASH_MODEL } from "../config.js";
import { DECISION_SYSTEM_INSTRUCTION } from "../prompts.js";

export const decisionRouter = Router();

decisionRouter.post("/api/decision", async (req, res) => {
  const { code, transcript, metrics, metricsSummary } = req.body;
  if (!code && !transcript) {
    return res.status(400).json({ error: "No code or transcript provided" });
  }

  const client = getClient();
  if (!client) return res.status(500).json({ error: "No Gemini client configured" });

  try {
    const prompt = [
      "Evaluate this coding interview and provide a hiring decision.\n",
      code ? `## Candidate's Code\n\`\`\`\n${code}\n\`\`\`\n` : "",
      transcript ? `## Interview Transcript\n${transcript}\n` : "",
      // The prose block is what the model reasons over; the raw summary is
      // there so it can check a specific number rather than re-reading prose.
      metrics ? `${metrics}\n` : "",
      metricsSummary
        ? `## Raw Metrics\n\`\`\`json\n${JSON.stringify(metricsSummary, null, 2)}\n\`\`\`\n`
        : "",
    ].join("\n");

    const response = await client.models.generateContent({
      model: FLASH_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction: DECISION_SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            decision: {
              type: "string",
              description: "One of: Hire, Lean Hire, Borderline, Lean No Hire, No Hire",
            },
            level: {
              type: "string",
              description: "Candidate performance level, e.g. L3/Junior, L4/Mid, L5/Senior, L6/Staff",
            },
            summary: {
              type: "string",
              description: "1-2 sentence overall summary of the candidate's performance",
            },
            strengths: {
              type: "array",
              items: { type: "string" },
              description: "List of things the candidate did well",
            },
            weaknesses: {
              type: "array",
              items: { type: "string" },
              description: "List of areas where the candidate fell short",
            },
            improvements: {
              type: "array",
              items: { type: "string" },
              description: "Actionable advice for the candidate to improve and pass future interviews",
            },
            codeQuality: {
              type: "string",
              description: "Assessment of code quality, style, and correctness",
            },
            communication: {
              type: "string",
              description: "Assessment of how well the candidate communicated their thought process",
            },
            problemSolving: {
              type: "string",
              description: "Assessment of the candidate's problem-solving approach and algorithmic thinking",
            },
            independence: {
              type: "string",
              description:
                "How much of this the candidate did unaided. Reference the specific hint levels pulled and the timing metrics, and state plainly whether this session would have converted in a real interview loop — where there is no hint button.",
            },
          },
          required: [
            "decision",
            "level",
            "summary",
            "strengths",
            "weaknesses",
            "improvements",
            "codeQuality",
            "communication",
            "problemSolving",
            "independence",
          ],
        },
      },
    });

    const text = response?.candidates?.[0]?.content?.parts
      ?.filter((p) => p.text)
      .map((p) => p.text)
      .join("");
    const parsed = JSON.parse(text);
    res.json(parsed);
  } catch (err) {
    console.error("[Decision] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
