/**
 * POST /api/decision — Generate a hiring decision using Gemini Flash.
 */

import { Router } from "express";
import { getClient } from "../geminiClient.js";
import { FLASH_MODEL } from "../config.js";
import { DECISION_SYSTEM_INSTRUCTION } from "../prompts.js";

export const decisionRouter = Router();

decisionRouter.post("/api/decision", async (req, res) => {
  const { code, transcript } = req.body;
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
