import { KIND_DIR, kindFromId, type Entry } from "@nema/shared";
import { parseCommitMessage } from "./commitMessage.js";
import { git } from "./git.js";
import { fromFile } from "./store.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";

export type HistoryItem = {
  version: number;
  commit: string;
  committedAt: string;
  op: "add" | "update" | "recover";
  reason: string;
  sourceMessages: string[];
  author: "agent" | "user" | "system";
  taskId?: string;
};

export type ParagraphBlame = { text: string; version: number; commit: string; reason: string; author: "agent" | "user" | "system" };

function entryPath(id: string): string | null {
  const kind = kindFromId(id);
  return kind ? `${KIND_DIR[kind]}/${id}.md` : null;
}

/** The entry file plus, for a work package, its spec and plan. */
function entryPaths(id: string): string[] {
  const p = entryPath(id);
  if (!p) return [];
  return kindFromId(id) === "workpackage" ? [p, `${KIND_DIR.workpackage}/${id}.spec.md`, `${KIND_DIR.workpackage}/${id}.plan.md`] : [p];
}

/** Entry versions, newest first; the oldest commit is version 1. */
export async function history(repoDir: string, id: string, ownedHelpers?: OwnedHelperScope): Promise<HistoryItem[]> {
  const paths = entryPaths(id);
  if (paths.length === 0) return [];
  const out = await git(repoDir, ["log", "--format=%H%x00%cI%x00%B%x1e", "--", ...paths], ownedHelpers);
  const items: HistoryItem[] = [];
  for (const rec of out.split("\x1e")) {
    if (rec.trim() === "") continue;
    const [commit, committedAt, ...rest] = rec.replace(/^\n+/, "").split("\0");
    const info = parseCommitMessage(rest.join("\0"));
    const item: HistoryItem = {
      version: 0,
      commit,
      committedAt,
      op: info.op,
      reason: info.reason,
      sourceMessages: info.sourceMessages,
      author: info.author,
    };
    if (info.taskId !== undefined) item.taskId = info.taskId;
    items.push(item);
  }
  const n = items.length;
  items.forEach((it, i) => (it.version = n - i));
  return items;
}

export async function versionAt(repoDir: string, id: string, commit: string, ownedHelpers?: OwnedHelperScope): Promise<Entry> {
  const p = entryPath(id);
  if (!p) throw new Error(`invalid entry id ${id}`);
  return fromFile(await git(repoDir, ["show", `${commit}:${p}`], ownedHelpers));
}

type Line = { text: string; commit: string };

function splitBlocks(lines: Line[]): Line[][] {
  const blocks: Line[][] = [];
  let cur: Line[] = [];
  for (const l of lines) {
    if (l.text.trim() === "") {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else cur.push(l);
  }
  if (cur.length) blocks.push(cur);
  // A heading-only block merges with the block that follows it.
  const merged: Line[][] = [];
  for (let i = 0; i < blocks.length; i++) {
    let b = blocks[i];
    while (b.every((l) => l.text.startsWith("#")) && i + 1 < blocks.length) b = [...b, ...blocks[++i]];
    merged.push(b);
  }
  return merged;
}

export async function blameParagraphs(repoDir: string, id: string, ownedHelpers?: OwnedHelperScope): Promise<ParagraphBlame[]> {
  const p = entryPath(id);
  if (!p) return [];
  const hist = await history(repoDir, id, ownedHelpers);
  if (hist.length === 0) return [];
  const byCommit = new Map(hist.map((h) => [h.commit, h]));

  const raw = await git(repoDir, ["blame", "--porcelain", "HEAD", "--", p], ownedHelpers);
  const all: Line[] = [];
  let sha = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("\t")) all.push({ text: line.slice(1), commit: sha });
    else {
      const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
      if (m) sha = m[1];
    }
  }

  // Skip frontmatter: the opening "---" through the closing "---".
  let start = 0;
  if (all[0]?.text === "---") {
    const close = all.findIndex((l, i) => i > 0 && l.text === "---");
    start = close === -1 ? 0 : close + 1;
  }

  const out: ParagraphBlame[] = [];
  for (const block of splitBlocks(all.slice(start))) {
    const best = block
      .map((l) => byCommit.get(l.commit))
      .filter((h): h is HistoryItem => h !== undefined)
      .reduce<HistoryItem | undefined>((a, h) => (!a || h.version > a.version ? h : a), undefined);
    if (!best) continue;
    out.push({ text: block.map((l) => l.text).join("\n"), version: best.version, commit: best.commit, reason: best.reason, author: best.author });
  }
  return out;
}
