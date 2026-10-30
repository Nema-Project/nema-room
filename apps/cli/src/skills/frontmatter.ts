import { isSkillName } from "@nema/shared";

// Lenient SKILL.md front matter, following the agentskills.io client implementation guide: problems a client
// can live with become diagnostics, and only a missing name or description stops the Skill from loading.
// No YAML library ships at runtime, so this reads the subset Skills use: scalars, folded and literal blocks,
// one level of `metadata:` mappings and `paths:` lists.

export type SkillMeta = {
  name: string;
  description: string;
  whenToUse: string | null;
  license: string | null;
  compatibility: string | null;
  metadata: Record<string, string>;
  allowedTools: string | null;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  context: string | null;
  agent: string | null;
  hooks: boolean;
  paths: string[] | null;
  model: string | null;
  effort: string | null;
};

export type SkillDiagnostic =
  | "name-format"
  | "name-folder-mismatch"
  | "reserved-word"
  | "description-too-long"
  | "xml-tags"
  | "compatibility-too-long";

export type ParsedSkill =
  | { ok: true; meta: SkillMeta; body: string; diagnostics: SkillDiagnostic[] }
  | { ok: false; reason: "no-frontmatter" | "no-description" | "unparseable" };

type Value = { kind: "scalar"; text: string } | { kind: "map"; entries: Record<string, string> } | { kind: "list"; items: string[] } | { kind: "nested" };

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function scalar(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.lastIndexOf(quote);
    if (end > 0) return trimmed.slice(1, end);
  }
  // A YAML comment starts at `#` after whitespace; `a#b` stays one word.
  return trimmed.replace(/(^|\s+)#.*$/, "").trim();
}

function indented(line: string): boolean {
  return /^\s+\S/.test(line);
}

function readValues(lines: string[]): Map<string, Value> {
  const values = new Map<string, Value>();
  for (let i = 0; i < lines.length; i++) {
    const top = /^([A-Za-z_][\w-]*):(?:\s+(.*)|\s*)$/.exec(lines[i]!);
    if (!top) continue;
    const key = top[1]!;
    const rest = (top[2] ?? "").trim();
    if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && indented(lines[i + 1]!)) block.push(lines[++i]!.trim());
      values.set(key, { kind: "scalar", text: block.join(rest.startsWith(">") ? " " : "\n") });
      continue;
    }
    if (rest !== "") {
      values.set(key, { kind: "scalar", text: scalar(rest) });
      continue;
    }
    const block: string[] = [];
    while (i + 1 < lines.length && (indented(lines[i + 1]!) || lines[i + 1]!.trim() === "")) block.push(lines[++i]!);
    const content = block.filter((line) => line.trim() !== "");
    if (content.length === 0) {
      values.set(key, { kind: "scalar", text: "" });
    } else if (content.every((line) => /^\s+-\s+/.test(line))) {
      values.set(key, { kind: "list", items: content.map((line) => scalar(line.replace(/^\s+-\s+/, ""))) });
    } else {
      const depth = Math.min(...content.map((line) => line.length - line.trimStart().length));
      const entries: Record<string, string> = {};
      let flat = true;
      for (const line of content) {
        if (line.length - line.trimStart().length !== depth) {
          flat = false;
          continue;
        }
        const pair = /^\s+([^:\s][^:]*):\s+(.+)$/.exec(line);
        if (pair) entries[pair[1]!.trim()] = scalar(pair[2]!);
        else flat = false;
      }
      values.set(key, flat ? { kind: "map", entries } : { kind: "nested" });
    }
  }
  return values;
}

function text(values: Map<string, Value>, key: string): string | null {
  const value = values.get(key);
  if (value?.kind !== "scalar") return null;
  const trimmed = value.text.trim();
  return trimmed === "" ? null : trimmed;
}

function flag(values: Map<string, Value>, key: string, fallback: boolean): boolean {
  const value = text(values, key)?.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

const XML_TAG = /<\/?[A-Za-z][^<>]*>/;

/** Parses one SKILL.md. `folderName` is the Skill's directory name, which the spec says `name` should match. */
export function parseSkillFile(file: string, folderName: string): ParsedSkill {
  const match = FRONT.exec(file);
  if (!match) return { ok: false, reason: "no-frontmatter" };
  const values = readValues(match[1]!.split(/\r?\n/));
  const name = text(values, "name");
  if (name === null) return { ok: false, reason: "unparseable" };
  const description = text(values, "description");
  if (description === null) return { ok: false, reason: "no-description" };

  const metadataValue = values.get("metadata");
  const pathsValue = values.get("paths");
  const pathsText = text(values, "paths");
  const hooksValue = values.get("hooks");
  const meta: SkillMeta = {
    name,
    description,
    whenToUse: text(values, "when_to_use"),
    license: text(values, "license"),
    compatibility: text(values, "compatibility"),
    metadata: metadataValue?.kind === "map" ? metadataValue.entries : {},
    allowedTools: text(values, "allowed-tools"),
    disableModelInvocation: flag(values, "disable-model-invocation", false),
    userInvocable: flag(values, "user-invocable", true),
    context: text(values, "context"),
    agent: text(values, "agent"),
    hooks: hooksValue !== undefined && !(hooksValue.kind === "scalar" && hooksValue.text.trim() === ""),
    paths: pathsValue?.kind === "list" ? pathsValue.items : pathsText !== null ? [pathsText] : null,
    model: text(values, "model"),
    effort: text(values, "effort"),
  };

  const diagnostics: SkillDiagnostic[] = [];
  if (!isSkillName(name)) diagnostics.push("name-format");
  if (name !== folderName) diagnostics.push("name-folder-mismatch");
  if (/anthropic|claude/i.test(name)) diagnostics.push("reserved-word");
  if (description.length > 1024) diagnostics.push("description-too-long");
  if (XML_TAG.test(name) || XML_TAG.test(description)) diagnostics.push("xml-tags");
  if (meta.compatibility !== null && meta.compatibility.length > 500) diagnostics.push("compatibility-too-long");
  return { ok: true, meta, body: file.slice(match[0].length), diagnostics };
}
