/**
 * LeetLive — Code pad editor
 *
 * Line-number gutter plus code-editor keyboard behavior:
 *   - Enter keeps the previous line's indentation, one level deeper after a
 *     block opener (`:`, `{`, `[`, `(`)
 *   - Enter between a bracket pair puts the closer on its own line with the
 *     cursor indented between them
 *   - A closing bracket typed on a blank line aligns to its matching opener
 *   - Auto-close and type-over for (), {}, []
 *   - Tab / Shift+Tab indent and unindent, Backspace eats indent and pairs
 */

import { codePad, lineNumbers, btnSolve } from "./dom.js";
import { saveState } from "./state.js";

const INDENT = "    ";
const OPEN_TO_CLOSE = { "(": ")", "{": "}", "[": "]" };
const CLOSE_TO_OPEN = { ")": "(", "}": "{", "]": "[" };
const BACKSPACE_PAIRS = { "(": ")", "{": "}", "[": "]", '"': '"', "'": "'", "`": "`" };

let onChange = () => {};

export function updateLineNumbers() {
  const lineCount = (codePad.value.match(/\n/g) || []).length + 1;
  let html = "";
  for (let i = 1; i <= lineCount; i++) {
    html += `<span>${i}</span>`;
  }
  lineNumbers.innerHTML = html;
}

function afterEdit() {
  updateLineNumbers();
  saveState();
  onChange();
}

// All programmatic edits go through setRangeText, which preserves the
// textarea's scroll position — reassigning .value makes the viewport jump
// and loses track of the cursor.
function editPad(start, end, text, cursorPos) {
  codePad.setRangeText(text, start, end, "end");
  codePad.selectionStart = codePad.selectionEnd = cursorPos;
  afterEdit();
}

function lineStartAt(val, pos) {
  return val.lastIndexOf("\n", pos - 1) + 1;
}

function leadingIndent(text) {
  return (text.match(/^[ \t]*/) || [""])[0];
}

// Indentation of the line containing the opener that matches a closing
// bracket typed at `pos`. Returns null when the brackets are unbalanced.
function matchingOpenerIndent(val, pos, closeChar) {
  const openChar = CLOSE_TO_OPEN[closeChar];
  let depth = 1;
  for (let i = pos - 1; i >= 0; i--) {
    const c = val[i];
    if (c === closeChar) depth++;
    else if (c === openChar && --depth === 0) {
      const lineStart = lineStartAt(val, i);
      return leadingIndent(val.substring(lineStart, i));
    }
  }
  return null;
}

function handleEnter(val, start, end) {
  const lineStart = lineStartAt(val, start);
  const currentLine = val.substring(lineStart, start);
  const indent = leadingIndent(currentLine);
  const trimmed = currentLine.trimEnd();

  // Enter with the cursor between a bracket pair, e.g. {|}: move the closer
  // to its own line at the opener's indentation, cursor indented between
  if (start === end && OPEN_TO_CLOSE[val[start - 1]] && OPEN_TO_CLOSE[val[start - 1]] === val[start]) {
    const inner = indent + INDENT;
    editPad(start, end, "\n" + inner + "\n" + indent, start + 1 + inner.length);
    return;
  }

  // Keep the previous line's indentation; go one level deeper after an opener
  const newIndent = /[:\{\[\(]$/.test(trimmed) ? indent + INDENT : indent;
  editPad(start, end, "\n" + newIndent, start + 1 + newIndent.length);
}

function handleTab(e, val, start, end) {
  const lineStart = lineStartAt(val, start);

  if (e.shiftKey) {
    // Unindent every selected line by up to one tab stop
    const selectedText = val.substring(lineStart, end);
    const lines = selectedText.split("\n");
    const unindented = lines.map((line) => line.replace(/^( {1,4}|\t)/, ""));
    const newText = unindented.join("\n");

    codePad.setRangeText(newText, lineStart, end, "end");
    const firstLineDiff = lines[0].length - unindented[0].length;
    const totalDiff = selectedText.length - newText.length;
    codePad.selectionStart = Math.max(lineStart, start - firstLineDiff);
    codePad.selectionEnd = Math.max(lineStart, end - totalDiff);
    afterEdit();
    return;
  }

  if (start !== end && val.substring(start, end).includes("\n")) {
    // Indent every selected line
    const selectedText = val.substring(lineStart, end);
    const lines = selectedText.split("\n");
    const newText = lines.map((line) => INDENT + line).join("\n");

    codePad.setRangeText(newText, lineStart, end, "end");
    codePad.selectionStart = start + INDENT.length;
    codePad.selectionEnd = end + lines.length * INDENT.length;
    afterEdit();
    return;
  }

  editPad(start, end, INDENT, start + INDENT.length);
}

// Returns true if it handled the key
function handleBackspace(val, start, end) {
  if (start !== end || start === 0) return false;

  const lineStart = lineStartAt(val, start);
  const beforeCursor = val.substring(lineStart, start);

  // Line is only whitespace before the cursor: delete back to the previous tab stop
  if (/^[ \t]+$/.test(beforeCursor)) {
    const len = beforeCursor.length;
    const deleteCount = len % INDENT.length === 0 ? INDENT.length : len % INDENT.length;
    editPad(start - deleteCount, start, "", start - deleteCount);
    return true;
  }

  // Delete both halves of an empty pair: () {} [] "" '' ``
  const charBefore = val[start - 1];
  if (BACKSPACE_PAIRS[charBefore] && BACKSPACE_PAIRS[charBefore] === val[start]) {
    editPad(start - 1, start + 1, "", start - 1);
    return true;
  }

  return false;
}

// Returns true if it handled the key
function handleClosingBracket(key, val, start, end) {
  if (start !== end) return false;

  const lineStart = lineStartAt(val, start);
  const beforeCursor = val.substring(lineStart, start);

  // Typed on a line that is blank so far: align with the matching opener's line
  if (/^[ \t]*$/.test(beforeCursor)) {
    const openerIndent = matchingOpenerIndent(val, start, key);
    if (openerIndent !== null) {
      editPad(lineStart, start, openerIndent + key, lineStart + openerIndent.length + 1);
      return true;
    }
  }

  // Type-over: the auto-closed bracket is already right of the cursor
  if (val[start] === key) {
    codePad.selectionStart = codePad.selectionEnd = start + 1;
    return true;
  }

  return false;
}

function handleOpeningBracket(key, val, start, end) {
  const closeChar = OPEN_TO_CLOSE[key];

  if (start !== end) {
    // Wrap the selection in the pair, keeping it selected
    const selected = val.substring(start, end);
    codePad.setRangeText(key + selected + closeChar, start, end, "end");
    codePad.selectionStart = start + 1;
    codePad.selectionEnd = end + 1;
    afterEdit();
    return;
  }

  editPad(start, end, key + closeChar, start + 1);
}

function handleKeydown(e) {
  // Ctrl/Cmd + Enter to solve
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    btnSolve.click();
    return;
  }

  const val = codePad.value;
  const start = codePad.selectionStart;
  const end = codePad.selectionEnd;

  if (e.key === "Enter") {
    e.preventDefault();
    handleEnter(val, start, end);
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();
    handleTab(e, val, start, end);
    return;
  }

  if (e.key === "Backspace") {
    if (handleBackspace(val, start, end)) e.preventDefault();
    return;
  }

  if (CLOSE_TO_OPEN[e.key]) {
    if (handleClosingBracket(e.key, val, start, end)) e.preventDefault();
    return;
  }

  if (OPEN_TO_CLOSE[e.key]) {
    e.preventDefault();
    handleOpeningBracket(e.key, val, start, end);
  }
}

export function initEditor(opts = {}) {
  onChange = opts.onChange || (() => {});

  codePad.addEventListener("keydown", handleKeydown);
  codePad.addEventListener("input", () => {
    saveState();
    updateLineNumbers();
    onChange();
  });
  codePad.addEventListener("scroll", () => {
    lineNumbers.scrollTop = codePad.scrollTop;
  });

  updateLineNumbers();
}
