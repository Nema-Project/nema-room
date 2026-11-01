import { DIAGRAM_TYPES } from "@nema/shared";

/**
 * One row in the `/` menu. Diagram types are their own rows, `diagram:architecture`. A Skill row has
 * `skill`; its `id` is `skill:<id>` so it never shares a row id with a built-in command.
 */
export type SlashItem = {
  id: string;
  hint: string;
  insert: string;
  type?: string;
  skill?: {
    id: string;
    description: string;
    command: string;
    runtimes?: ReadonlyArray<{ adapter: string; missing?: readonly string[] }>;
    diagnostics?: readonly string[];
  };
};

/** A Skill the composer can offer (`GET /api/workspaces/:id/skills`). Older daemons omit the last two fields. */
export type SkillRow = {
  id: string;
  description: string;
  command: string;
  runtimes?: ReadonlyArray<{ adapter: string; missing?: readonly string[] }>;
  diagnostics?: readonly string[];
};

export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: "thread", hint: "cmd.thread", insert: "cmd.thread.insert" },
  { id: "progress", hint: "cmd.progress", insert: "cmd.progress.insert" },
  ...DIAGRAM_TYPES.map((type) => ({
    id: `diagram:${type}`,
    hint: `cmd.diagram.${type}`,
    insert: "cmd.diagram.insert",
    type,
  })),
  { id: "update", hint: "cmd.update", insert: "cmd.update.insert" },
];

export type SlashToken = { query: string; start: number; end: number };

/** The `/name` token on the current line, while the caret is still inside the name. */
export function slashToken(value: string, cursor: number): SlashToken | null {
  const lineStart = value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const lineBreak = value.indexOf("\n", cursor);
  const lineEnd = lineBreak === -1 ? value.length : lineBreak;
  const line = value.slice(lineStart, lineEnd);
  const match = /^\/(\S*)\s*$/.exec(line);
  if (!match) return null;
  const end = lineStart + 1 + match[1].length;
  if (cursor < lineStart + 1 || cursor > end) return null;
  return { query: match[1], start: lineStart, end };
}

/** Prefix filter on the whole command, so `/diagram:w` keeps workflow and waterfall. */
export function matchingCommands(query: string): SlashItem[] {
  const q = query.toLowerCase();
  return SLASH_ITEMS.filter((item) => item.id.startsWith(q));
}

/**
 * Built-in commands first, then Skills. Skills come only when the `/` starts the whole message, and match
 * on their command or id prefix, or anywhere in the description.
 */
export function matchingItems(query: string, o: { atMessageStart: boolean; skills: readonly SkillRow[]; threadMode: boolean }): SlashItem[] {
  const commands = matchingCommands(query).filter((item) => !o.threadMode || item.id !== "thread");
  if (!o.atMessageStart) return commands;
  const q = query.toLowerCase();
  const skills = o.skills
    .filter((s) => s.command.slice(1).startsWith(q) || s.id.startsWith(q) || s.description.toLowerCase().includes(q))
    .map((s) => ({
      id: `skill:${s.id}`,
      hint: s.description,
      insert: `${s.command} `,
      skill: { id: s.id, description: s.description, command: s.command, runtimes: s.runtimes, diagnostics: s.diagnostics },
    }));
  return [...commands, ...skills];
}

/** Replace the slash token with the command's prompt. */
export function applySlash(value: string, token: SlashToken, insert: string): { text: string; cursor: number } {
  return { text: value.slice(0, token.start) + insert + value.slice(token.end), cursor: token.start + insert.length };
}
