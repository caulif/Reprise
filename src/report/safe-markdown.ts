const SAFE_RELATIVE = /^(?:\.\.?\/)[A-Za-z0-9._~/-]+$/;

export function reportLang(text: string): "zh" | "en" {
  return /[\u4e00-\u9fff]/.test(text) ? "zh" : "en";
}

export function renderSafeMarkdown(
  markdown: string,
  artifactHref: (id: string) => string | undefined = () => undefined,
): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const html: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (/^```/.test(line)) {
      const fence: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? "")) {
        fence.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      html.push(`<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      html.push(`<h${level}>${inline(heading[2] ?? "", artifactHref)}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^\|/.test(line) && /^\|/.test(lines[index + 1] ?? "")) {
      const table: string[] = [];
      while (index < lines.length && /^\|/.test(lines[index] ?? "")) {
        table.push(lines[index] ?? "");
        index += 1;
      }
      html.push(renderTable(table, artifactHref));
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      html.push(`<ul>${items.map((item) => `<li>${inline(item, artifactHref)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(/^\s*\d+\.\s+/, ""));
        index += 1;
      }
      html.push(`<ol>${items.map((item) => `<li>${inline(item, artifactHref)}</li>`).join("")}</ol>`);
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !/^(#{1,3}\s+|```|\||\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    html.push(`<p>${inline(paragraph.join(" "), artifactHref)}</p>`);
  }
  return html.join("");
}

function renderTable(rows: readonly string[], artifactHref: (id: string) => string | undefined): string {
  const parsed = rows
    .map((row) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^:?-+:?$/.test(cell)));
  if (parsed.length < 1) return `<p>${inline(rows.join(" "), artifactHref)}</p>`;
  const header = parsed[0] ?? [];
  const body = parsed.slice(1);
  return `<table><thead><tr>${header.map((cell) => `<th>${inline(cell, artifactHref)}</th>`).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell, artifactHref)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function inline(value: string, artifactHref: (id: string) => string | undefined): string {
  const escaped = escapeHtml(value);
  return escaped
    .replaceAll(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
      const resolved = resolveHref(decodeBasic(href), artifactHref);
      return resolved ? `<a href="${escapeHtml(resolved)}">${label}</a>` : label;
    })
    .replaceAll(/`([^`]+)`/g, "<code>$1</code>")
    .replaceAll(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replaceAll(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
}

function resolveHref(href: string, artifactHref: (id: string) => string | undefined): string | undefined {
  const artifact = /^artifact:([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(href);
  if (artifact?.[1]) return artifactHref(artifact[1]);
  if (href === "comparison.md" || SAFE_RELATIVE.test(href)) return href;
  return undefined;
}

function decodeBasic(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}
