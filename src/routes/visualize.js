/**
 * POST /api/visualize — Generate an interactive HTML visualization.
 */

import { Router } from "express";
import { getClient } from "../geminiClient.js";
import { FLASH_MODEL } from "../config.js";
import { VISUALIZE_SYSTEM_INSTRUCTION } from "../prompts.js";

export const visualizeRouter = Router();

visualizeRouter.post("/api/visualize", async (req, res) => {
  const { codeStub, solution, problemName } = req.body;
  if (!codeStub) return res.status(400).json({ error: "No code stub provided" });

  const client = getClient();
  if (!client) return res.status(500).json({ error: "No Gemini client configured" });

  try {
    const prompt = solution
      ? `Create an interactive visualization for this LeetCode problem:\n\nProblem: ${problemName || "Unknown"}\n\nCode Stub:\n${codeStub}\n\nSolution:\n${solution}`
      : `Create an interactive visualization for this LeetCode problem:\n\nCode Stub:\n${codeStub}`;

    const response = await client.models.generateContent({
      model: FLASH_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { systemInstruction: VISUALIZE_SYSTEM_INSTRUCTION },
    });

    const html = response?.candidates?.[0]?.content?.parts
      ?.filter((p) => p.text)
      .map((p) => p.text)
      .join("");
    res.json({ html });
  } catch (err) {
    console.error("[Visualize] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
