/**
 * POST /api/visualize — Generate an interactive HTML visualization.
 */

import { Router } from "express";
import { getClient } from "../geminiClient.js";
import { FLASH_MODEL } from "../config.js";
import { VISUALIZE_SYSTEM_INSTRUCTION } from "../prompts.js";

export const visualizeRouter = Router();

/**
 * Strip markdown code fences and unescape HTML entities that Gemini
 * sometimes injects into raw-HTML responses.
 */
function sanitizeHtml(raw) {
  if (!raw) return "";

  let html = raw.trim();

  // Strip leading/trailing markdown code fences: ```html ... ``` or ``` ... ```
  html = html.replace(/^```(?:html|HTML)?\s*\n?/, "").replace(/\n?```\s*$/, "");

  // Unescape common HTML entities that appear when Gemini double-escapes
  html = html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");

  // If the result still doesn't look like HTML (no tags at all), it's probably
  // fully escaped — try one more decode pass
  if (!/<[a-zA-Z]/.test(html)) {
    html = html
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  return html;
}

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

    const raw = response?.candidates?.[0]?.content?.parts
      ?.filter((p) => p.text)
      .map((p) => p.text)
      .join("");
    const html = sanitizeHtml(raw);
    res.json({ html });
  } catch (err) {
    console.error("[Visualize] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});
