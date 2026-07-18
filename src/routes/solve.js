/**
 * POST /api/solve — Solve a LeetCode problem with Gemini Flash.
 */

import { Router } from "express";
import { getClient } from "../geminiClient.js";
import { FLASH_MODEL } from "../config.js";
import { SOLVE_SYSTEM_INSTRUCTION } from "../prompts.js";

export const solveRouter = Router();

solveRouter.post("/api/solve", async (req, res) => {
  const { codeStub } = req.body;
  if (!codeStub) return res.status(400).json({ error: "No code stub provided" });

  const client = getClient();
  if (!client) return res.status(500).json({ error: "No Gemini client configured" });

  try {
    const response = await client.models.generateContent({
      model: FLASH_MODEL,
      contents: [{ role: "user", parts: [{ text: `Solve this LeetCode problem:\n\n${codeStub}` }] }],
      config: {
        systemInstruction: SOLVE_SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            problemName: { type: "string" },
            difficulty: { type: "string" },
            category: { type: "string" },
            approach: { type: "string" },
            solution: { type: "string" },
            timeComplexity: { type: "string" },
            spaceComplexity: { type: "string" },
            explanation: { type: "string" },
          },
          required: ["problemName", "solution", "approach", "timeComplexity", "spaceComplexity", "explanation"],
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
    console.error("[Solve] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
