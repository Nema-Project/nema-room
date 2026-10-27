import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import matter from "gray-matter";
import {
  EntryFrontmatter,
  KIND_DIR,
  KIND_PREFIX,
  UpsertEntryInput,
  idNumber,
  kindFromId,
  type DiagramMeta,
  type Entry,
  type EntryKind,
  type EntrySummary,
  type Quote,
  type WorkPackageMeta,
  type WpTask,
} from "@nema/shared";
import { formatCommitMessage } from "./commitMessage.js";
import { git, withRepoLock } from "./git.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";

export type CommitMeta = { author: "agent" | "user" | "system"; taskId?: string; now?: Date };

export type CreateWorkPackageInput = {
  title: string;
  requirements: string[];
  repos: string[];
  reason: string;
  sourceMessages: string[];
};

export type WorkPackageDocUpdate = { tasks?: WpTask[]; status?: "draft"; blockedOn?: string | null };

export type WorkPackageMetaPatch = Partial<Pick<WorkPackageMeta, "approvedAt" | "approvedCommit" | "blockedOn" | "tasks">> & { status?: Entry["status"] };

export type WriteDiagramInput = {
  /** An existing diagram to update; omit to add a new one. */
  id?: string;
  title: string;
  body: string;
  diagram: DiagramMeta;
  /** The archify JSON, stored next to the entry as `diagrams/<id>.json`. */
  spec: unknown;
  reason: string;
  sourceMessages: string[];
};

const KINDS = Object.keys(KIND_DIR) as EntryKind[];
const DEFAULT_STATUS: Record<EntryKind, "active" | "open" | "draft"> = {
  requirement: "active",
  decision: "active",
  tradeoff: "active",
  question: "open",
  source: "active",
  diagram: "active",
  workpackage: "draft",
};

function mergeQuotes(existing: Quote[], incoming: Quote[]): Quote[] {
  const seen = new Set(existing.map((q) => JSON.stringify([q.messageId, q.text])));
  const out = [...existing];
  for (const q of incoming) {
    const key = JSON.stringify([q.messageId, q.text]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

function toFile(e: Entry): string {
  const data: Record<string, unknown> = {
    id: e.id,
    kind: e.kind,
    title: e.title,
    status: e.status,
    business_date: e.businessDate,
    related: e.related,
    source_messages: e.sourceMessages,
  };
  if (e.url !== undefined) data.url = e.url;
  if (e.priority !== undefined) data.priority = e.priority;
  if (e.diagram !== undefined) {
    data.diagram = {
      repo_id: e.diagram.repoId,
      type: e.diagram.type,
      source_commits: e.diagram.sourceCommits,
      node_paths: e.diagram.nodePaths,
    };
  }
  if (e.workpackage !== undefined) {
    const w = e.workpackage;
    data.workpackage = {
      requirements: w.requirements,
      repos: w.repos,
      approved_at: w.approvedAt,
      approved_commit: w.approvedCommit,
      blocked_on: w.blockedOn,
      tasks: w.tasks.map((t) => ({
        n: t.n,
        title: t.title,
        satisfies: t.satisfies,
        files: t.files,
        status: t.status,
        inferred: t.inferred,
        report_message_id: t.reportMessageId,
        confirmed_by: t.confirmedBy,
      })),
    };
  }
  if (e.implementation !== undefined) {
    const ev = e.implementation.evidence;
    data.implementation = {
      status: e.implementation.status,
      evidence: {
        report_message_id: ev.reportMessageId,
        commits: ev.commits,
        inferred: ev.inferred,
        note: ev.note,
        confirmed_by: ev.confirmedBy,
      },
    };
  }
  // Omit nulls and empty quotes so an untouched legacy file stays byte-identical.
  if (e.basis !== null) data.basis = e.basis;
  if (e.ingestedAt !== null) data.ingested_at = e.ingestedAt;
  if (e.confirmedAt !== null) data.confirmed_at = e.confirmedAt;
  if (e.quotes.length > 0) data.quotes = e.quotes.map((q) => ({ message_id: q.messageId, text: q.text }));
  // Frontmatter block only; body is appended verbatim so it round-trips exactly.
  return matter.stringify("", data) + e.body;
}

export function fromFile(raw: string): Entry {
  const { data, content } = matter(raw);
  const fm = EntryFrontmatter.parse({
    id: data.id,
    kind: data.kind,
    title: data.title,
    status: data.status,
    businessDate: data.business_date ?? null,
    related: data.related ?? [],
    sourceMessages: data.source_messages ?? [],
    url: data.url ?? undefined,
    priority: data.priority ?? undefined,
    diagram: diagramFromData(data.diagram),
    implementation: implementationFromData(data.implementation),
    workpackage: workPackageFromData(data.workpackage),
    basis: data.basis ?? null,
    ingestedAt: data.ingested_at ?? null,
    confirmedAt: data.confirmed_at ?? null,
    quotes: Array.isArray(data.quotes)
      ? data.quotes.map((q: { message_id: string; text: string }) => ({ messageId: q.message_id, text: q.text }))
      : [],
  });
  // gray-matter keeps the newline that terminates the closing delimiter.
  return { ...fm, body: content.startsWith("\n") ? content.slice(1) : content };
}

function diagramFromData(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return raw; // let the schema reject it
  const d = raw as Record<string, unknown>;
  return { repoId: d.repo_id, type: d.type, sourceCommits: d.source_commits ?? {}, nodePaths: d.node_paths ?? {} };
}

function workPackageFromData(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return raw; // let the schema reject it
  const d = raw as Record<string, unknown>;
  return {
    requirements: d.requirements ?? [],
    repos: d.repos ?? [],
    approvedAt: d.approved_at ?? null,
    approvedCommit: d.approved_commit ?? null,
    blockedOn: d.blocked_on ?? null,
    tasks: Array.isArray(d.tasks)
      ? d.tasks.map((t: unknown) => {
          if (typeof t !== "object" || t === null || Array.isArray(t)) return t;
          const x = t as Record<string, unknown>;
          return {
            n: x.n,
            title: x.title,
            satisfies: x.satisfies ?? [],
            files: x.files ?? [],
            status: x.status,
            inferred: x.inferred ?? false,
            reportMessageId: x.report_message_id ?? null,
            confirmedBy: x.confirmed_by ?? null,
          };
        })
      : d.tasks,
  };
}

function implementationFromData(raw: unknown): unknown {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return raw; // let the schema reject it
  const d = raw as Record<string, unknown>;
  const ev = d.evidence;
  if (typeof ev !== "object" || ev === null || Array.isArray(ev)) return { status: d.status, evidence: ev };
  const e = ev as Record<string, unknown>;
  return {
    status: d.status,
    evidence: {
      reportMessageId: e.report_message_id ?? null,
      commits: e.commits ?? [],
      inferred: e.inferred ?? false,
      note: e.note ?? null,
      confirmedBy: e.confirmed_by ?? null,
    },
  };
}

function summarize(e: Entry): EntrySummary {
  const s: EntrySummary = {
    id: e.id,
    kind: e.kind,
    title: e.title,
    status: e.status,
    businessDate: e.businessDate,
    related: e.related,
    basis: e.basis,
    confirmedAt: e.confirmedAt,
  };
  if (e.priority !== undefined) s.priority = e.priority;
  if (e.url !== undefined) s.url = e.url;
  if (e.implementation !== undefined) s.implementation = e.implementation;
  if (e.diagram !== undefined) s.diagram = { repoId: e.diagram.repoId, type: e.diagram.type };
  if (e.workpackage !== undefined) s.workpackage = { blockedOn: e.workpackage.blockedOn, taskCount: e.workpackage.tasks.length };
  return s;
}

const RECOVER_REASON = "hub 启动时发现的未提交改动（崩溃后恢复）";

function recoverMessage(entry: Entry): string {
  return formatCommitMessage({
    op: "recover",
    id: entry.id,
    title: entry.title,
    reason: RECOVER_REASON,
    sourceMessages: [],
    author: "system",
  });
}

type PorcelainChange = { xy: string; paths: string[] };

/** porcelain v1 -z records are NUL-separated. A rename or copy has a second path and no score. */
function porcelainV1Z(raw: string): PorcelainChange[] {
  const parts = raw.split("\0");
  const out: PorcelainChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i] ?? "";
    if (rec === "") continue;
    const xy = rec.slice(0, 2);
    const dst = rec.slice(3);
    if (xy.includes("R") || xy.includes("C")) {
      const src = parts[++i] ?? "";
      out.push({ xy, paths: src === "" ? [dst] : [dst, src] });
    } else {
      out.push({ xy, paths: [dst] });
    }
  }
  return out;
}

function isRecoverableStatus(xy: string): boolean {
  if (xy.includes("D")) return false;
  const x = xy[0];
  const y = xy[1];
  return x === "?" || x === "A" || x === "M" || y === "M";
}

/** `<kind dir>/<ID>.md` whose id prefix is that kind. */
function isEntryRel(rel: string): boolean {
  const slash = rel.indexOf("/");
  if (slash <= 0 || slash !== rel.lastIndexOf("/")) return false;
  const base = rel.slice(slash + 1);
  if (!base.endsWith(".md")) return false;
  const kind = kindFromId(base.slice(0, -3));
  return kind !== null && KIND_DIR[kind] === rel.slice(0, slash);
}

/** `diagrams/G-n.json` (archify spec) or `workpackages/W-n.spec.md` / `W-n.plan.md`: the entry `.md` a sibling file belongs to. */
function siblingMdRel(rel: string): string | null {
  let md: string | null = null;
  let kind: EntryKind = "diagram";
  if (rel.endsWith(".json")) md = `${rel.slice(0, -5)}.md`;
  else {
    const m = /^(.*)\.(?:spec|plan)\.md$/.exec(rel);
    if (m) {
      md = `${m[1]}.md`;
      kind = "workpackage";
    }
  }
  return md !== null && isEntryRel(md) && kindFromId(path.basename(md, ".md")) === kind ? md : null;
}

const WP_DOC_FILE = /\.(?:spec|plan)\.md$/;

/** Readers must see a complete old or new file, including while a failed commit rolls back. */
async function replaceFile(file: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await writeFile(temporary, content, { flag: "wx", mode });
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class KnowledgeStore {
  constructor(private readonly repoDir: string, private readonly ownedHelpers?: OwnedHelperScope) {}

  private git(args: string[]): Promise<string> {
    return git(this.repoDir, args, this.ownedHelpers);
  }

  private filePath(id: string, kind: EntryKind): string {
    return path.join(this.repoDir, KIND_DIR[kind], `${id}.md`);
  }

  private specPath(id: string): string {
    return path.join(this.repoDir, KIND_DIR.diagram, `${id}.json`);
  }

  async init(): Promise<void> {
    await withRepoLock(this.repoDir, async () => {
      await mkdir(this.repoDir, { recursive: true });
      await this.git(["init", "-b", "main"]);
      await this.git(["config", "user.name", "Nema Room"]);
      await this.git(["config", "user.email", "nema@localhost"]);
      for (const kind of KINDS) {
        const d = path.join(this.repoDir, KIND_DIR[kind]);
        await mkdir(d, { recursive: true });
        await writeFile(path.join(d, ".gitkeep"), "");
      }
      await this.git(["add", "-A"]);
      await this.git(["commit", "-m", "init"]);
    });
  }

  private async readAll(): Promise<Entry[]> {
    const out: Entry[] = [];
    for (const kind of KINDS) {
      let names: string[];
      try {
        names = await readdir(path.join(this.repoDir, KIND_DIR[kind]));
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith(".md") || WP_DOC_FILE.test(n)) continue;
        const file = path.join(this.repoDir, KIND_DIR[kind], n);
        try {
          out.push(fromFile(await readFile(file, "utf8")));
        } catch (err) {
          // One unreadable/corrupt entry must not hide every other entry.
          console.warn(`[knowledge] skipping unparseable entry file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return out;
  }

  /** Highest numeric id used by a kind, from file names (so a corrupt file still reserves its id). */
  private async maxIdNumber(kind: EntryKind): Promise<number> {
    let names: string[];
    try {
      names = await readdir(path.join(this.repoDir, KIND_DIR[kind]));
    } catch {
      return 0;
    }
    const re = new RegExp(`^${KIND_PREFIX[kind]}-(\\d+)\\.md$`);
    return names.reduce((m, n) => {
      const hit = re.exec(n);
      return hit ? Math.max(m, Number(hit[1])) : m;
    }, 0);
  }

  async list(): Promise<EntrySummary[]> {
    const all = await this.readAll();
    const order = (k: EntryKind) => KINDS.indexOf(k);
    all.sort((a, b) => order(a.kind) - order(b.kind) || idNumber(a.id) - idNumber(b.id));
    return all.map(summarize);
  }

  /** Entries whose source messages include `messageId`, in the same order as `list`. */
  async entriesCiting(messageId: string): Promise<EntrySummary[]> {
    const all = await this.readAll();
    const order = (k: EntryKind) => KINDS.indexOf(k);
    return all
      .filter((e) => e.sourceMessages.includes(messageId))
      .sort((a, b) => order(a.kind) - order(b.kind) || idNumber(a.id) - idNumber(b.id))
      .map(summarize);
  }

  async get(id: string): Promise<Entry | null> {
    const kind = kindFromId(id);
    if (!kind) return null;
    try {
      return fromFile(await readFile(this.filePath(id, kind), "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /** Mark an entry as withdrawn while retaining its provenance and confirmation time. */
  async withdraw(id: string, meta: CommitMeta): Promise<{ entry: Entry; commit: string }> {
    return withRepoLock(this.repoDir, async () => {
      const existing = await this.get(id);
      if (!existing) throw new Error(`entry ${id} not found`);
      const entry: Entry = { ...existing, status: "dropped" };
      const commit = await this.writeAndCommit(entry, "update", "用户撤回", [], meta);
      return { entry, commit };
    });
  }

  async upsert(rawInput: UpsertEntryInput, meta: CommitMeta): Promise<{ entry: Entry; commit: string; op: "add" | "update" }> {
    const input = UpsertEntryInput.parse(rawInput);
    return withRepoLock(this.repoDir, async () => {
      let op: "add" | "update";
      let id: string;
      let existing: Entry | null = null;
      if (input.id !== undefined) {
        existing = await this.get(input.id);
        if (!existing) throw new Error(`entry ${input.id} not found`);
        op = "update";
        id = input.id;
      } else {
        const max = await this.maxIdNumber(input.kind);
        op = "add";
        id = `${KIND_PREFIX[input.kind]}-${max + 1}`;
      }

      const now = (meta.now ?? new Date()).toISOString();
      const entry: Entry = {
        ...EntryFrontmatter.parse({
          id,
          kind: input.kind,
          title: input.title,
          status: input.status ?? existing?.status ?? DEFAULT_STATUS[input.kind],
          businessDate: input.businessDate !== undefined ? input.businessDate : (existing?.businessDate ?? null),
          related: input.related ?? existing?.related ?? [],
          // Provenance accumulates across updates.
          sourceMessages: [...new Set([...(existing?.sourceMessages ?? []), ...input.sourceMessages])],
          url: input.url ?? existing?.url,
          priority: input.priority ?? existing?.priority,
          // Callers decide who may set it: the Room API checks it against reports, the UI never passes it.
          implementation: input.implementation ?? existing?.implementation,
          basis: input.basis ?? existing?.basis ?? null,
          quotes: mergeQuotes(existing?.quotes ?? [], input.quotes ?? []),
          ingestedAt: existing ? existing.ingestedAt : now,
          confirmedAt: !existing || input.confirmed === true ? now : existing.confirmedAt,
        }),
        body: input.body,
      };
      const commit = await this.writeAndCommit(entry, op, input.reason, input.sourceMessages, meta);
      return { entry, commit, op };
    });
  }

  /** Add or update a diagram entry: `diagrams/G-n.md` and its archify spec `diagrams/G-n.json` in one commit. */
  async writeDiagram(input: WriteDiagramInput, meta: CommitMeta): Promise<{ entry: Entry; commit: string; op: "add" | "update" }> {
    return withRepoLock(this.repoDir, async () => {
      let op: "add" | "update";
      let id: string;
      let existing: Entry | null = null;
      if (input.id !== undefined) {
        existing = kindFromId(input.id) === "diagram" ? await this.get(input.id) : null;
        if (!existing) throw new Error(`diagram ${input.id} not found`);
        op = "update";
        id = input.id;
      } else {
        op = "add";
        id = `${KIND_PREFIX.diagram}-${(await this.maxIdNumber("diagram")) + 1}`;
      }
      const now = (meta.now ?? new Date()).toISOString();
      const entry: Entry = {
        ...EntryFrontmatter.parse({
          id,
          kind: "diagram",
          title: input.title,
          status: existing?.status ?? DEFAULT_STATUS.diagram,
          businessDate: existing?.businessDate ?? null,
          related: existing?.related ?? [],
          sourceMessages: [...new Set([...(existing?.sourceMessages ?? []), ...input.sourceMessages])],
          diagram: input.diagram,
          basis: existing?.basis ?? null,
          quotes: existing?.quotes ?? [],
          ingestedAt: existing ? existing.ingestedAt : now,
          // Drawing or redrawing is a fresh look at the code.
          confirmedAt: now,
        }),
        body: input.body,
      };
      const spec = JSON.stringify(input.spec, null, 2);
      if (spec === undefined) throw new Error("diagram spec must be JSON");
      const commit = await this.writeAndCommit(entry, op, input.reason, input.sourceMessages, meta, [{ file: this.specPath(id), content: spec }]);
      return { entry, commit, op };
    });
  }

  /** The archify JSON of a diagram entry, or null when the id is not a diagram or has no spec file. */
  async readDiagramSpec(id: string): Promise<unknown | null> {
    if (kindFromId(id) !== "diagram") return null;
    let raw: string;
    try {
      raw = await readFile(this.specPath(id), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return JSON.parse(raw) as unknown;
  }

  /** A new `draft` work package `workpackages/W-n.md`: no tasks, empty body. The spec and plan are written later. */
  async createWorkPackage(input: CreateWorkPackageInput, meta: CommitMeta): Promise<Entry> {
    return withRepoLock(this.repoDir, async () => {
      const id = `${KIND_PREFIX.workpackage}-${(await this.maxIdNumber("workpackage")) + 1}`;
      const now = (meta.now ?? new Date()).toISOString();
      const entry: Entry = {
        ...EntryFrontmatter.parse({
          id,
          kind: "workpackage",
          title: input.title,
          status: DEFAULT_STATUS.workpackage,
          businessDate: null,
          related: [],
          sourceMessages: [...new Set(input.sourceMessages)],
          workpackage: { requirements: input.requirements, repos: input.repos, approvedAt: null, approvedCommit: null, blockedOn: null, tasks: [] },
          basis: null,
          quotes: [],
          ingestedAt: now,
          confirmedAt: now,
        }),
        body: "",
      };
      await this.writeAndCommit(entry, "add", input.reason, input.sourceMessages, meta);
      return entry;
    });
  }

  /** Write `W-n.spec.md` or `W-n.plan.md`. Any save sets the package back to `draft` and clears its approval. */
  async writeWorkPackageDoc(
    id: string,
    which: "spec" | "plan",
    markdown: string,
    update: WorkPackageDocUpdate,
    reason: string,
    sourceMessages: string[],
    meta: CommitMeta,
  ): Promise<Entry> {
    return withRepoLock(this.repoDir, async () => {
      const existing = await this.getWorkPackage(id);
      const wp = existing.workpackage!;
      const entry: Entry = {
        ...existing,
        status: "draft",
        sourceMessages: [...new Set([...existing.sourceMessages, ...sourceMessages])],
        workpackage: {
          ...wp,
          approvedAt: null,
          approvedCommit: null,
          blockedOn: update.blockedOn !== undefined ? update.blockedOn : wp.blockedOn,
          tasks: update.tasks ?? wp.tasks,
        },
      };
      const file = path.join(this.repoDir, KIND_DIR.workpackage, `${id}.${which}.md`);
      await this.writeAndCommit(entry, "update", reason, sourceMessages, meta, [{ file, content: markdown }]);
      return entry;
    });
  }

  async readWorkPackage(id: string): Promise<{ entry: Entry; spec: string | null; plan: string | null } | null> {
    if (kindFromId(id) !== "workpackage") return null;
    // The entry (with tasks) and its spec/plan files are written under the repo lock; reading them under it too
    // keeps a reader from pairing a just-written plan with the entry it read before that write.
    return withRepoLock(this.repoDir, async () => {
      const entry = await this.get(id);
      if (!entry) return null;
      const read = async (which: "spec" | "plan"): Promise<string | null> => {
        try {
          return await readFile(path.join(this.repoDir, KIND_DIR.workpackage, `${id}.${which}.md`), "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw err;
        }
      };
      return { entry, spec: await read("spec"), plan: await read("plan") };
    });
  }

  /** Hub-only: approval, status and task progress. Never exposed to the Agent. */
  async setWorkPackageMeta(id: string, patch: WorkPackageMetaPatch, reason: string, meta: CommitMeta): Promise<Entry> {
    return withRepoLock(this.repoDir, async () => {
      const existing = await this.getWorkPackage(id);
      const { status, ...rest } = patch;
      const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      const entry: Entry = {
        ...existing,
        status: status ?? existing.status,
        workpackage: { ...existing.workpackage!, ...defined },
      };
      EntryFrontmatter.parse(entry);
      await this.writeAndCommit(entry, "update", reason, [], meta);
      return entry;
    });
  }

  private async getWorkPackage(id: string): Promise<Entry> {
    const existing = kindFromId(id) === "workpackage" ? await this.get(id) : null;
    if (!existing?.workpackage) throw new Error(`work package ${id} not found`);
    return existing;
  }

  async confirm(id: string, meta: CommitMeta): Promise<{ entry: Entry; commit: string }> {
    return withRepoLock(this.repoDir, async () => {
      const existing = await this.get(id);
      if (!existing) throw new Error(`entry ${id} not found`);
      const now = (meta.now ?? new Date()).toISOString();
      const basis = existing.basis === null || existing.basis === "inferred" ? (existing.kind === "decision" ? "decided" : "stated") : existing.basis;
      const entry: Entry = { ...existing, basis, confirmedAt: now };
      const commit = await this.writeAndCommit(entry, "update", "用户确认仍然有效", [], meta);
      return { entry, commit };
    });
  }

  /**
   * The user's confirm that a requirement is implemented: `verified`, confirmed by the user, evidence kept.
   * Only a `reported` or `mismatch` implementation can be confirmed.
   */
  async confirmImplementation(id: string, meta: CommitMeta): Promise<{ entry: Entry; commit: string }> {
    return withRepoLock(this.repoDir, async () => {
      const existing = await this.get(id);
      if (!existing) throw new Error(`entry ${id} not found`);
      const impl = existing.implementation;
      if (!impl || (impl.status !== "reported" && impl.status !== "mismatch")) {
        throw new Error(`entry ${id} has no reported or mismatched implementation`);
      }
      const entry: Entry = {
        ...existing,
        implementation: { status: "verified", evidence: { ...impl.evidence, confirmedBy: "user" } },
      };
      const commit = await this.writeAndCommit(entry, "update", "用户确认已实现", [], meta);
      return { entry, commit };
    });
  }

  /**
   * Commit entry files left dirty by a crash. Each parseable entry is its own `recover` commit by `system`.
   * Deletions and non-entry paths are listed in `skipped` and left as they are.
   */
  async recoverUncommitted(now?: Date): Promise<{ recovered: Entry[]; skipped: string[] }> {
    // ponytail: `now` is ignored; git's clock dates the commit. Thread it into GIT_AUTHOR_DATE if a caller needs a fixed timestamp.
    void now;
    return withRepoLock(this.repoDir, async () => {
      const recovered: Entry[] = [];
      const skipped: string[] = [];
      const status = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      const changes = porcelainV1Z(status);
      const isPlain = (c: PorcelainChange) => !c.xy.includes("R") && !c.xy.includes("C") && isRecoverableStatus(c.xy);
      // A diagram's spec or a work package's spec/plan is recovered together with its .md, in the .md's commit.
      const dirtySiblings = new Set(changes.filter((c) => isPlain(c) && siblingMdRel(c.paths[0] ?? "") !== null).map((c) => c.paths[0]!));
      const dirtyMds = new Set(changes.filter(isPlain).map((c) => c.paths[0] ?? ""));
      for (const change of changes) {
        // A rename/copy is not a crash write. Skip both paths and do not commit it.
        if (change.xy.includes("R") || change.xy.includes("C") || !isRecoverableStatus(change.xy)) {
          skipped.push(...change.paths);
          continue;
        }
        const rel = change.paths[0] ?? "";
        const siblingOf = siblingMdRel(rel);
        if (siblingOf !== null && dirtyMds.has(siblingOf)) continue;
        if (!isEntryRel(rel)) {
          skipped.push(rel);
          continue;
        }
        const base = rel.slice(0, -3);
        const rels = [rel, ...[`${base}.json`, `${base}.spec.md`, `${base}.plan.md`].filter((f) => dirtySiblings.has(f))];
        const entry = await this.readRecoverable(rel);
        if (!entry) {
          skipped.push(...rels);
          continue;
        }
        // A file whose frontmatter names another id or kind would commit under the wrong path.
        if (path.relative(this.repoDir, this.filePath(entry.id, entry.kind)).split(path.sep).join("/") !== rel) {
          console.warn(`[knowledge] skipping ${rel}: frontmatter says ${entry.kind} ${entry.id}`);
          skipped.push(...rels);
          continue;
        }
        try {
          await this.git(["add", "--", ...rels]);
          await this.git(["commit", "-m", recoverMessage(entry), "--", ...rels]);
        } catch (err) {
          // The files stay on disk. A later startup sees them still dirty.
          console.warn(`[knowledge] could not commit recovered entry ${rel}: ${err instanceof Error ? err.message : String(err)}`);
          skipped.push(...rels);
          continue;
        }
        recovered.push(entry);
      }
      return { recovered, skipped };
    });
  }

  /**
   * Locked callers share this write, commit, and rollback. Does not take the repo lock.
   * `extra` files (a diagram's spec) are written and committed together with the entry.
   */
  private async writeAndCommit(
    entry: Entry,
    op: "add" | "update",
    reason: string,
    sourceMessages: string[],
    meta: CommitMeta,
    extra: { file: string; content: string }[] = [],
  ): Promise<string> {
    // `system` commits come from the hub itself (work package progress from report checks).
    const writes = [{ file: this.filePath(entry.id, entry.kind), content: toFile(entry) }, ...extra];
    const rels = writes.map((w) => path.relative(this.repoDir, w.file));
    const previous: (string | null)[] = [];
    for (const w of writes) {
      await mkdir(path.dirname(w.file), { recursive: true });
      try {
        previous.push(await readFile(w.file, "utf8"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        previous.push(null);
      }
    }
    try {
      for (const w of writes) await replaceFile(w.file, w.content);
      await this.git(["add", "--", ...rels]);
      const staged = (await this.git(["diff", "--cached", "--name-only", "--", ...rels])).trim();
      if (staged === "") return (await this.git(["rev-parse", "HEAD"])).trim();
      const message = formatCommitMessage({
        op,
        id: entry.id,
        title: entry.title,
        reason,
        sourceMessages,
        author: meta.author,
        ...(meta.taskId !== undefined ? { taskId: meta.taskId } : {}),
      });
      await this.git(["commit", "-m", message, "--", ...rels]);
    } catch (err) {
      for (let i = 0; i < writes.length; i++) await this.rollback(writes[i]!.file, rels[i]!, previous[i] ?? null);
      throw err;
    }
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  /** Parse an on-disk entry. Unparseable files are warned about and left byte-for-byte. */
  private async readRecoverable(rel: string): Promise<Entry | null> {
    const file = path.join(this.repoDir, rel);
    try {
      return fromFile(await readFile(file, "utf8"));
    } catch (err) {
      console.warn(`[knowledge] skipping unparseable entry file ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Undo an uncommitted write: unstage it and put the previous content back (or remove the new file). */
  private async rollback(file: string, rel: string, previous: string | null): Promise<void> {
    try {
      await this.git(["reset", "-q", "--", rel]);
    } catch (e) {
      console.warn(`[knowledge] could not unstage ${rel} after a failed write`, e);
    }
    try {
      if (previous === null) await rm(file, { force: true });
      else await replaceFile(file, previous);
    } catch (e) {
      console.warn(`[knowledge] could not restore ${file} after a failed write`, e);
    }
  }
}
