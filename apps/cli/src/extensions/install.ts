import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseSkillSource, type ExtensionRecord, type SkillSource } from "@nema/shared";
import { RAW, commitTree, encodePath, pinnedSkillRecord, resolveSkillSource, type SourceFetch, type TreeEntry } from "./source.js";
import type { openExtensionStore } from "./store.js";

type Store = ReturnType<typeof openExtensionStore>;

export type InstallState = "running" | "installed" | "failed" | "cancelled";

/** What the page polls while a skill installs, and what it reads afterwards. */
export type InstallJob = {
  id: string;
  state: InstallState;
  /** Files written to staging so far, out of `total`. */
  done: number;
  total: number;
  error: string | null;
  commit: string | null;
  path: string | null;
};

export type InstallRequest = { source: string; commit: string; path: string };

const COMMIT = /^[0-9a-f]{40}$/;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** Hub waits 60 s for the start call; resolving the pinned commit has to finish before that. */
const RESOLVE_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
export const INTERRUPTED = "interrupted: the daemon stopped before the install finished";
/** A name that is unsafe on any platform the daemon runs on: separators, drive colons, reserved characters, controls. */
const UNSAFE_NAME = /[\\:*?"<>|\u0000-\u001f]/;

function safeSegments(relative: string): boolean {
  return relative.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !UNSAFE_NAME.test(part) && part.length <= 255);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * The files of one skill folder at one commit, checked before any byte is downloaded: regular files
 * only, names safe on every platform, no two names that collide on a case-insensitive disk, and
 * inside the count and size limits.
 */
export function skillFiles(entries: TreeEntry[], folder: string): Array<TreeEntry & { relative: string }> {
  const prefix = folder === "." ? "" : `${folder}/`;
  const inside = entries.filter((entry) => entry.path.startsWith(prefix) && entry.path !== folder);
  const files: Array<TreeEntry & { relative: string }> = [];
  for (const entry of inside) {
    if (entry.type === "commit" || entry.mode === "160000") throw new Error(`${entry.path} is a submodule`);
    if (entry.type !== "blob") continue;
    if (entry.mode === "120000") throw new Error(`${entry.path} is a symbolic link`);
    const relative = entry.path.slice(prefix.length);
    if (!safeSegments(relative)) throw new Error(`unsafe file name in ${entry.path}`);
    files.push({ ...entry, relative });
  }
  if (files.length > MAX_FILES) throw new Error(`${folder} has more than ${MAX_FILES} files`);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const folded = file.relative.toLowerCase();
    if (seen.has(folded)) throw new Error(`${file.path} differs from another file only in case`);
    seen.add(folded);
    if (file.size !== null && file.size > MAX_FILE_BYTES) throw new Error(`${file.path} is larger than 5 MiB`);
    total += file.size ?? 0;
  }
  if (total > MAX_TOTAL_BYTES) throw new Error(`${folder} is larger than 20 MiB in total`);
  return files;
}

type Job = InstallJob & { controller: AbortController; promise: Promise<void> };

/**
 * Installs one skill folder from a pinned commit into Nema's managed directory.
 *
 * The record goes in first as `installing`, carrying the commit and folder, so a crash leaves enough
 * behind for `recover()` to mark it failed and for `retry()` to start again from the same commit.
 * Files are downloaded into `<root>/staging/<id>-*`, each checked against its Git blob hash, and only
 * a complete, verified folder is handed to `installManaged`, which swaps it in.
 */
export class SkillInstaller {
  private readonly jobs = new Map<string, Job>();
  private readonly staging: string;

  constructor(private readonly o: { root: string; store: Store; fetch: SourceFetch; downloadTimeoutMs?: number }) {
    this.staging = path.join(o.root, "staging");
  }

  /** Called once at daemon start: no install can be running yet, so every `installing` record is left over. */
  recover(): string[] {
    rmSync(this.staging, { recursive: true, force: true });
    mkdirSync(this.staging, { recursive: true });
    const interrupted = this.o.store.list().filter((row) => row.provision === "managed" && row.installState === "installing").map((row) => row.id);
    for (const id of interrupted) this.o.store.failInstall(id, INTERRUPTED);
    return interrupted;
  }

  running(id: string): boolean {
    return this.jobs.get(id)?.state === "running";
  }

  async start(request: InstallRequest): Promise<InstallJob> {
    const { source, commit, path: folder } = request;
    if (typeof source !== "string") throw new Error("install needs a string source");
    if (typeof commit !== "string" || !COMMIT.test(commit)) throw new Error("install needs a 40-character commit");
    if (typeof folder !== "string" || (folder !== "." && !safeSegments(folder))) throw new Error("invalid skill path");
    const parsed = parseSkillSource(source);
    const pinned: SkillSource = {
      via: "github",
      owner: parsed.owner,
      repo: parsed.repo,
      ref: commit,
      path: folder === "." ? null : folder,
      skill: null,
      refPath: null,
      exact: true,
    };
    const resolution = await resolveSkillSource(pinned, { fetch: this.o.fetch, signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS) });
    if (resolution.commit !== commit) throw new Error(`${commit} resolved to a different commit`);
    const record = pinnedSkillRecord(resolution, resolution.skills[0]!);
    this.claim(record.id);
    this.o.store.putManaged(record);
    return this.launch(record, resolution.owner, resolution.repo, commit, folder);
  }

  /** Start again from the commit and folder on the record, for a failed, cancelled or interrupted install. */
  async retry(id: string): Promise<InstallJob> {
    const record = this.o.store.list().find((row) => row.id === id);
    if (!record || record.provision !== "managed" || !record.provenance) throw new Error(`${id} has no install to retry`);
    this.claim(id);
    return this.start({ source: record.provenance.repository, commit: record.provenance.commit, path: record.provenance.path });
  }

  cancel(id: string): InstallJob {
    const job = this.jobs.get(id);
    if (!job || job.state !== "running") throw new Error(`${id} is not installing`);
    job.controller.abort(new Error("cancelled"));
    job.state = "cancelled";
    return this.snapshot(job);
  }

  status(id: string): InstallJob {
    const job = this.jobs.get(id);
    if (job) return this.snapshot(job);
    const record = this.o.store.list().find((row) => row.id === id);
    if (!record || record.provision !== "managed") throw new Error(`${id} has no install`);
    const state: InstallState =
      record.installState === "installed" ? "installed" : record.installState === "failed" ? "failed" : record.installState === "absent" ? "cancelled" : "running";
    return { id, state, done: 0, total: 0, error: record.error, commit: record.provenance?.commit ?? null, path: record.provenance?.path ?? null };
  }

  /** Resolves once the current install of `id` has stopped, whichever way. For tests and shutdown. */
  async settled(id: string): Promise<void> {
    await this.jobs.get(id)?.promise;
  }

  /** One install per id at a time; an installed copy is not replaced (updating is its own operation). */
  private claim(id: string): void {
    if (this.running(id)) throw new Error(`${id} is already being installed`);
    const current = this.o.store.list().find((row) => row.id === id);
    if (!current) return;
    if (current.provision !== "managed") throw new Error(`${id} is taken by another extension`);
    if (current.installState === "installed") throw new Error(`${id} is already installed`);
    if (current.installState === "installing") throw new Error(`${id} is already being installed`);
  }

  private snapshot(job: Job): InstallJob {
    return { id: job.id, state: job.state, done: job.done, total: job.total, error: job.error, commit: job.commit, path: job.path };
  }

  private launch(record: ExtensionRecord, owner: string, repo: string, commit: string, folder: string): InstallJob {
    const controller = new AbortController();
    const job: Job = { id: record.id, state: "running", done: 0, total: 0, error: null, commit, path: folder, controller, promise: Promise.resolve() };
    this.jobs.set(record.id, job);
    job.promise = this.run(job, record, owner, repo, commit, folder);
    return this.snapshot(job);
  }

  private async run(job: Job, record: ExtensionRecord, owner: string, repo: string, commit: string, folder: string): Promise<void> {
    const timeout = this.o.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(timeout)]);
    mkdirSync(this.staging, { recursive: true });
    const stage = mkdtempSync(path.join(this.staging, `${record.id}-`));
    try {
      const { entries, truncated } = await commitTree(owner, repo, commit, { fetch: this.o.fetch, signal });
      if (truncated) throw new Error(`GitHub cut the file list of ${owner}/${repo} short; it is too large to install from`);
      const files = skillFiles(entries, folder);
      job.total = files.length;
      for (const file of files) {
        const response = await this.o.fetch(`${RAW}/${owner}/${repo}/${commit}/${encodePath(file.path)}`, {
          headers: { "User-Agent": "nema-extension-installer" },
          signal,
        });
        if (!response.ok) throw new Error(`could not download ${file.path} (${response.status})`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_FILE_BYTES) throw new Error(`${file.path} is larger than 5 MiB`);
        if (gitBlobSha(bytes) !== file.sha) throw new Error(`${file.path} does not match its Git blob hash`);
        const target = path.resolve(stage, ...file.relative.split("/"));
        if (!target.startsWith(stage + path.sep)) throw new Error(`unsafe file name in ${file.path}`);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, bytes, { flag: "wx" });
        job.done += 1;
      }
      signal.throwIfAborted();
      this.o.store.installManaged({ ...record, installState: "installed", error: null }, stage);
      job.state = "installed";
    } catch (error) {
      if (job.controller.signal.aborted) {
        job.state = "cancelled";
        this.o.store.cancelInstall(record.id);
      } else {
        const reason = error instanceof Error && error.name === "TimeoutError" ? `download did not finish within ${Math.round(timeout / 60_000)} min` : message(error);
        job.state = "failed";
        job.error = reason;
        this.o.store.failInstall(record.id, reason);
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
}
