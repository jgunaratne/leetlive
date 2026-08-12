/**
 * LeetLive — Minimal markdown renderer
 *
 * Just enough GitHub-flavoured markdown for the professor's chat replies:
 * fenced code, headings, lists, blockquotes, rules, and inline emphasis.
 * Everything is HTML-escaped before any markup is added, so model output can
 * never inject tags into the page.
 */

import { escapeHtml } from "./util.js";

function inline(text) {
  return escapeHtml(text)
    // Inline code first: its contents should not be re-parsed as emphasis.
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(_])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

export function renderMarkdown(src) {
  const lines = String(src || "").split("\n");
  const out = [];

  // Open list/paragraph runs are flushed whenever a different block starts.
  let listType = null;
  let paragraph = [];

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
      paragraph = [];
    }
  };
  const closeAll = () => {
    closeParagraph();
    closeList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```+\s*([\w+-]*)\s*$/);

    if (fence) {
      closeAll();
      const lang = fence[1] || "";
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      out.push(
        `<pre class="md-pre"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code>${escapeHtml(
          body.join("\n")
        )}</code></pre>`
      );
      continue;
    }

    if (!line.trim()) {
      // A blank line ends a paragraph but not a list: markdown "loose" lists put
      // blank lines between items, and closing here would restart the numbering
      // of an ordered list at 1 on every item. Any non-list block that follows
      // closes the list itself.
      closeParagraph();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeAll();
      // Chat bubbles are narrow — cap heading weight so h1/h2 don't shout.
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      closeAll();
      out.push("<hr>");
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      closeAll();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const type = bullet ? "ul" : "ol";
      closeParagraph();
      if (listType !== type) {
        closeList();
        // A paragraph between items splits one logical list into several <ol>s.
        // Starting each at the number the model actually wrote keeps 1, 2, 3
        // reading as 1, 2, 3 instead of 1, 1, 1.
        out.push(type === "ol" ? `<ol start="${Number(numbered[1]) || 1}">` : "<ul>");
        listType = type;
      }
      out.push(`<li>${inline(bullet ? bullet[1] : numbered[2])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  closeAll();
  return out.join("");
}
