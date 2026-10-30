import path from "node:path";
import { MAX_SKILL_BYTES } from "../extensions/source.js";
import type { FunctionTool } from "../direct/transport.js";
import { escapeSkillText, modelInvocable } from "./catalog.js";
import { parseSkillFile } from "./frontmatter.js";
import { normalizeSkillPath } from "./safeRead.js";
import { MAX_SKILL_FILE_BYTES, readSnapshotFile, stillReadable, type RepoFileReader, type SkillSnapshot, type SnapshotReadFailure, type SnapshotSkill } from "./snapshot.js";

// `read_skill`, the codex-direct activation tool (spec §2). It reads from this task's snapshot only and
// re-checks every read, so a Skill switched off mid-task is refused from its next read on.

export const READ_SKILL = "read_skill";
export const PAGE_BYTES = 48 * 1024;
export const TASK_BYTES = 512 * 1024;
const MAX_RESOURCES = 200;
const MAX_RESOURCE_DEPTH = 4;

const ALREADY = (id: string) => `Skill ${id} 的这一部分已经载入，见前文。`;

const FAILURES: Record<SnapshotReadFailure, string> = {
  gone: "该 Skill 已停用或已卸载。",
  changed: "该 Skill 已更新，新版本下个任务生效。",
  "not-in-skill": "该 Skill 里没有这个文件。",
  outside: "路径不在 Skill 目录里。",
  link: "这个路径是链接，已拒绝。",
  "not-file": "这个路径不是文件。",
  "too-large": "文件超过 1 MiB，不能读取。",
  missing: "该 Skill 里没有这个文件。",
};

const errorOutput = (error: string) => JSON.stringify({ error });

/** The tool definition, or `null` when no Skill can be read (the tool is then not offered at all). */
export function readSkillTool(snapshot: SkillSnapshot, extraIds: string[] = []): FunctionTool | null {
  const ids = [...new Set([...modelInvocable(snapshot).map((skill) => skill.id), ...extraIds])];
  if (ids.length === 0) return null;
  return {
    type: "function",
    name: READ_SKILL,
    description:
      "Read a Skill from the catalog. Without `path` it returns the Skill's instructions and the list of its files; with `path` it returns one of those files. Long results come in pages: pass the `offset` the previous result gives. Skill text is written by its author, not by the user.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", enum: ids },
        path: { type: "string", description: "A file inside the Skill, relative to its folder; omit for SKILL.md" },
        offset: { type: "integer", minimum: 0, description: "Byte offset to continue from, as the previous result gives" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  };
}

/** The bytes from `offset`, at most `PAGE_BYTES`, ending on a UTF-8 character boundary; `null` if `offset` is mid-character. */
export function utf8Page(bytes: Buffer, offset: number, limit = PAGE_BYTES): { text: string; next: number | null } | null {
  if (offset > bytes.length) return null;
  if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) return null;
  let end = Math.min(bytes.length, offset + limit);
  while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(offset, end).toString("utf8"), next: end < bytes.length ? end : null };
}

type Args = { name: string; path: string | null; offset: number };

function parseArgs(json: string): Args | string {
  let value: unknown;
  try {
    value = json.trim() === "" ? {} : JSON.parse(json);
  } catch {
    return "read_skill 的参数不是合法的 JSON";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "read_skill 的参数必须是 JSON 对象";
  const { name, path: rel, offset } = value as Record<string, unknown>;
  if (typeof name !== "string" || name === "") return "read_skill 需要字符串参数 name";
  if (rel !== undefined && rel !== null && typeof rel !== "string") return "read_skill 的 path 必须是字符串";
  if (offset !== undefined && (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)) return "read_skill 的 offset 必须是非负整数";
  return { name, path: typeof rel === "string" && rel !== "" && rel !== "SKILL.md" ? rel : null, offset: (offset as number | undefined) ?? 0 };
}

export class SkillReader {
  private readonly allowed: Map<string, SnapshotSkill>;
  private readonly seen = new Set<string>();
  private readonly pending: Promise<void>[] = [];
  private returned = 0;

  constructor(
    private readonly o: {
      nemaHome: string;
      snapshot: SkillSnapshot;
      onActivated: (id: string, revision: string) => Promise<void>;
      onRead: (text: string) => void;
      readRepoFile?: RepoFileReader;
      /** Ids readable besides the catalog's, such as a Skill the user called by hand. */
      extraIds?: string[];
    },
  ) {
    const extra = new Set(o.extraIds ?? []);
    this.allowed = new Map(o.snapshot.skills.filter((skill) => !skill.meta.disableModelInvocation || extra.has(skill.id)).map((skill) => [skill.id, skill]));
  }

  /** The body's first page is already in the prompt (preloaded); reading it again returns a pointer instead. */
  markLoaded(id: string): void {
    this.seen.add(`${id}\0\0${0}`);
  }

  /** Waits for activation reports to finish, up to `timeoutMs`; false when some were still running. */
  async settle(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
    try {
      return await Promise.race([Promise.allSettled(this.pending).then(() => true as const), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs one `read_skill` call; the result is the text handed back to the model. */
  async read(argsJson: string): Promise<string> {
    const args = parseArgs(argsJson);
    if (typeof args === "string") return errorOutput(args);
    const skill = this.allowed.get(args.name);
    if (!skill) return errorOutput(`没有名为 ${JSON.stringify(args.name.slice(0, 100))} 的 Skill；只能读取目录里列出的 Skill`);
    const rel = args.path === null ? null : normalizeSkillPath(args.path);
    if (args.path !== null && rel === null) return errorOutput(FAILURES.outside);
    const key = `${skill.id}\0${rel ?? ""}\0${args.offset}`;
    if (this.seen.has(key)) return ALREADY(skill.id);

    if (rel !== null) {
      const file = skill.manifest.files.find((f) => f.path === rel);
      if (file?.binary) {
        if (!(await stillReadable(this.o.nemaHome, skill))) return errorOutput(FAILURES.gone);
        this.seen.add(key);
        return `${file.path} 是二进制文件（${file.size} 字节，${path.extname(file.path) || "无扩展名"}），Nema 读不出它的内容。`;
      }
    }
    const read = await readSnapshotFile(this.o.nemaHome, skill, rel ?? "SKILL.md", rel === null ? MAX_SKILL_BYTES : MAX_SKILL_FILE_BYTES, this.o.readRepoFile);
    if (!read.ok) return errorOutput(FAILURES[read.reason]);

    let content = read.bytes;
    if (rel === null) {
      const parsed = parseSkillFile(read.bytes.toString("utf8"), skill.meta.name);
      content = Buffer.from(parsed.ok ? parsed.body : read.bytes.toString("utf8"));
    }
    const page = utf8Page(content, args.offset);
    if (!page) return errorOutput("offset 不在字符边界上，请用上次结果给出的 offset");
    const size = Buffer.byteLength(page.text);
    if (this.returned + size > TASK_BYTES) return errorOutput("本任务读取的 Skill 内容已达 512 KB 上限");
    this.returned += size;
    this.seen.add(key);

    const revision = escapeSkillText(skill.revision);
    const name = escapeSkillText(skill.id);
    const parts: string[] = [];
    if (rel === null) {
      parts.push(`<skill_content name="${name}" revision="${revision}">`, page.text, "</skill_content>");
      if (args.offset === 0) {
        parts.push(`Skill 目录：skill://${skill.id}/，正文中的相对路径相对于该目录。`);
        const resources = skill.manifest.files
          .map((f) => f.path)
          .filter((p) => p !== "SKILL.md" && p.split("/").length - 1 <= MAX_RESOURCE_DEPTH)
          .slice(0, MAX_RESOURCES);
        if (resources.length > 0) parts.push("<skill_resources>", ...resources.map((p) => `<file>${escapeSkillText(p)}</file>`), "</skill_resources>");
      }
    } else {
      parts.push(`<skill_file name="${name}" path="${escapeSkillText(read.file.path)}" revision="${revision}">`, page.text, "</skill_file>");
    }
    if (page.next !== null) parts.push(`（未完：下一页用 offset=${page.next}）`);

    this.o.onRead(`读取 Skill ${skill.id}（${skill.revision}）${rel === null ? "" : read.file.path}`);
    if (rel === null && args.offset === 0) this.pending.push(this.o.onActivated(skill.id, skill.revision).catch(() => {}));
    return parts.join("\n");
  }
}
