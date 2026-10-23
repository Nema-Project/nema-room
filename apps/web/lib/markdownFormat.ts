export type FormatKind = "bold" | "italic" | "code" | "list" | "link";
export type FormatResult = { text: string; selStart: number; selEnd: number };

const WRAP: Record<"bold" | "italic" | "code", string> = { bold: "**", italic: "*", code: "`" };

/** Pure Markdown toolbar logic: returns the new text and selection for the textarea. */
export function applyFormat(text: string, selStart: number, selEnd: number, kind: FormatKind): FormatResult {
  const start = Math.min(selStart, selEnd);
  const end = Math.max(selStart, selEnd);

  if (kind === "list") {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const nl = text.indexOf("\n", end);
    const lineEnd = nl === -1 ? text.length : nl;
    const lines = text.slice(lineStart, lineEnd).split("\n");
    const prefixed = lines.map((l) => `- ${l}`).join("\n");
    return {
      text: text.slice(0, lineStart) + prefixed + text.slice(lineEnd),
      selStart: start + 2,
      selEnd: end + 2 * lines.length,
    };
  }

  const selected = text.slice(start, end);
  if (kind === "link") {
    const url = "https://";
    const before = `${text.slice(0, start)}[${selected}](`;
    return { text: `${before}${url})${text.slice(end)}`, selStart: before.length, selEnd: before.length + url.length };
  }

  const m = WRAP[kind];
  return {
    text: `${text.slice(0, start)}${m}${selected}${m}${text.slice(end)}`,
    selStart: start + m.length,
    selEnd: end + m.length,
  };
}
