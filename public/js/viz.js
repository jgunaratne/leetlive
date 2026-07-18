/**
 * LeetLive — Visualization panel
 *
 * Calls /api/visualize, renders the generated HTML into the iframe, and
 * summarizes the visualization for the Live interviewer's context.
 */

import { codePad, btnVisualize, vizPlaceholder, vizLoading, vizFrame } from "./dom.js";
import { state, saveState } from "./state.js";
import { escapeHtml } from "./util.js";

export function renderViz(html) {
  vizPlaceholder.classList.add("hidden");
  vizLoading.classList.add("hidden");
  vizFrame.classList.remove("hidden");
  vizFrame.srcdoc = html;
}

export function resetViz() {
  vizFrame.classList.add("hidden");
  vizLoading.classList.add("hidden");
  vizFrame.removeAttribute("srcdoc");
  vizPlaceholder.classList.remove("hidden");
  vizPlaceholder.innerHTML = `
    <p>Click <strong>Generate</strong> to create an interactive walkthrough</p>
  `;
}

export function initVisualize({ onGenerated } = {}) {
  btnVisualize.addEventListener("click", async () => {
    vizPlaceholder.classList.add("hidden");
    vizFrame.classList.add("hidden");
    vizLoading.classList.remove("hidden");
    btnVisualize.disabled = true;

    try {
      const res = await fetch("/api/visualize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          codeStub: codePad.value.trim(),
          solution: state.currentSolution,
          problemName: state.currentProblemName,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to generate visualization");
      }

      const data = await res.json();
      renderViz(data.html);
      state.currentVizHtml = data.html;
      saveState();
      onGenerated?.();
    } catch (err) {
      vizLoading.classList.add("hidden");
      vizPlaceholder.classList.remove("hidden");
      vizPlaceholder.innerHTML = `
        <p style="color: var(--color-error)">${escapeHtml(err.message)}</p>
      `;
    } finally {
      btnVisualize.disabled = false;
    }
  });
}

// Extracts text descriptions, labels, and structure from the viz HTML so the
// interviewer knows what the candidate is seeing.
export function extractVizDescription(html) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    const descriptions = [];

    const headers = doc.querySelectorAll("h1, h2, h3");
    if (headers.length) {
      descriptions.push("Sections: " + [...headers].map((h) => h.textContent.trim()).join(", "));
    }

    const buttons = doc.querySelectorAll("button");
    if (buttons.length) {
      descriptions.push("Controls: " + [...buttons].map((b) => b.textContent.trim()).filter(Boolean).join(", "));
    }

    const labels = doc.querySelectorAll("label, .label, .description, .info, .hint");
    if (labels.length) {
      descriptions.push("Labels: " + [...labels].slice(0, 10).map((l) => l.textContent.trim()).filter(Boolean).join("; "));
    }

    const presets = doc.querySelectorAll(".preset, .example, [data-example]");
    if (presets.length) {
      descriptions.push("Preset examples: " + [...presets].map((p) => p.textContent.trim()).filter(Boolean).join(", "));
    }

    const bodyText = doc.body?.textContent?.replace(/\s+/g, " ").trim() || "";
    if (bodyText.length > 100) {
      descriptions.push("Visualization content summary: " + bodyText.slice(0, 1500));
    }

    return descriptions.join("\n") || "An interactive algorithm visualization is displayed.";
  } catch {
    return "An interactive algorithm visualization is displayed with play/pause controls, step-by-step execution, and variable state tracking.";
  }
}
