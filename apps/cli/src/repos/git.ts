// Read-only git operations for a bound repository.
// Every command is execFile (no shell): `git -C <repoPath> …` with only PATH, HOME, LANG, SSH_AUTH_SOCK,
// GIT_TERMINAL_PROMPT=0 and a BatchMode ssh, so the caller cannot point git at another directory via the environment.
import { isBranchName } from "@nema/shared";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { windowsRuntimeEnv } from "../platform.js";

const MAX_LINES = 400;
const MAX_BYTES = 65_536;
const SHA_RE = /^[0-9a-f]{7,40}$/;
// ponytail: git archive and cat-file are buffered up to 256MB so symlink entries can be
// dropped before tar runs. Upgrade path: stream the tar and stop cat-file after the line cap
// while still counting totalLines.
const MAX_BUFFER = 256 * 1024 * 1024;

export type RepoInspect = {
  root: string;
  gitCommonDir: string;
  defaultBranch: string;
  hasOrigin: boolean;
  remoteUrl: string | null;
};

export type FileAtRef = {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
  truncated: boolean;
};

export type ChangedFile = { status: string; path: string };

export function commandEnv(): NodeJS.ProcessEnv {
  return {
    ...windowsRuntimeEnv(process.env),
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
  };
}

/** Drops `user:secret@` from `scheme://…` URLs. scp-style `git@host:path` has no secret and is left as is. */
function stripUserinfo(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
}

function execBuf(cmd: string, args: string[], opts?: { timeout?: number }): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        env: commandEnv(),
        shell: false,
        timeout: opts?.timeout ?? 30_000,
        maxBuffer: MAX_BUFFER,
        encoding: "buffer",
      },
      (err, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
        const errOut = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");
        if (err) {
          reject(Object.assign(err, { stdout: out, stderr: errOut }));
          return;
        }
        resolve({ stdout: out, stderr: errOut });
      },
    );
  });
}

function errorText(e: unknown): string {
  if (e && typeof e === "object" && "stderr" in e) {
    const stderr = (e as { stderr?: Buffer | string }).stderr;
    const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
    const trimmed = text.trim();
    if (trimmed) return trimmed;
  }
  return e instanceof Error ? e.message.trim() : String(e);
}

export async function gitRaw(repoPath: string, args: string[], timeout?: number): Promise<Buffer> {
  const { stdout } = await execBuf("git", ["-C", repoPath, ...args], { timeout });
  return stdout;
}

export async function gitText(repoPath: string, args: string[], timeout?: number): Promise<string> {
  const text = (await gitRaw(repoPath, args, timeout)).toString("utf8");
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function originHeadBranch(repoPath: string): Promise<string> {
  try {
    const ref = await gitText(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (ref.startsWith("origin/")) return ref.slice("origin/".length) || "main";
    return ref || "main";
  } catch {
    return "main";
  }
}

/** Reject absolute, empty, and any path that still contains a `..` segment after normalization. */
function normalizeRepoPath(relPath: string): string {
  if (relPath === "" || path.isAbsolute(relPath)) throw new Error("路径必须是仓库内的相对路径");
  const normalized = path.posix.normalize(relPath);
  if (normalized.split("/").includes("..")) throw new Error("路径必须是仓库内的相对路径");
  return normalized;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (text.endsWith("\n")) parts.pop();
  return parts;
}

function cutUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let i = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > maxBytes) break;
    bytes += n;
    i += ch.length;
  }
  return text.slice(0, i);
}

type LsEntry = { mode: string; type: string; sha: string; path: string };

function parseLsTree(buf: Buffer): LsEntry[] {
  const rows: LsEntry[] = [];
  for (const entry of buf.toString("utf8").split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, sha] = entry.slice(0, tab).split(" ");
    rows.push({ mode: mode ?? "", type: type ?? "", sha: sha ?? "", path: entry.slice(tab + 1) });
  }
  return rows;
}

function parseNameStatus(buf: Buffer): ChangedFile[] {
  const parts = buf.toString("utf8").split("\0");
  if (parts.at(-1) === "") parts.pop();
  const rows: ChangedFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (!status) break;
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const from = parts[i++] ?? "";
      // A rename removes its source; a copy keeps it.
      if (kind === "R") rows.push({ status: "D", path: from });
      rows.push({ status, path: parts[i++] ?? "" });
    } else {
      rows.push({ status, path: parts[i++] ?? "" });
    }
  }
  return rows;
}

const TAR_BLOCK = 512;

function tarSize(header: Buffer): number {
  const raw = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
  if (!raw) return 0;
  const size = Number.parseInt(raw, 8);
  return Number.isFinite(size) ? size : 0;
}

function tarSpan(buf: Buffer, offset: number): { type: string; next: number } | null {
  if (offset + TAR_BLOCK > buf.length) return null;
  const header = buf.subarray(offset, offset + TAR_BLOCK);
  if (header.every((b) => b === 0)) return { type: "\0", next: buf.length };
  const size = tarSize(header);
  const data = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  return { type: String.fromCharCode(header[156] ?? 0), next: offset + TAR_BLOCK + data };
}

/** Drop git symlink blobs (tar typeflag 2) and the pax header that names their target. */
function stripSymlinkEntries(buf: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const pending: Buffer[] = [];
  let i = 0;
  while (i + TAR_BLOCK <= buf.length) {
    const span = tarSpan(buf, i);
    if (!span) break;
    if (span.type === "\0") {
      chunks.push(buf.subarray(i));
      break;
    }
    const entry = buf.subarray(i, span.next);
    if (span.type === "x" || span.type === "L" || span.type === "K") {
      pending.push(entry);
      i = span.next;
      continue;
    }
    if (span.type === "2") {
      pending.length = 0;
      i = span.next;
      continue;
    }
    chunks.push(...pending, entry);
    pending.length = 0;
    i = span.next;
  }
  chunks.push(...pending);
  return Buffer.concat(chunks);
}

async function emptyDir(destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const st = await lstat(destDir);
  if (st.isSymbolicLink()) throw new Error("destDir is a symlink");
  if (!st.isDirectory()) throw new Error("destDir is not a directory");
  for (const name of await readdir(destDir)) {
    await rm(path.join(destDir, name), { recursive: true, force: true });
  }
}

/** `nemaHome` is the directory that must not contain `repoPath`, usually `~/.nema`. */
export async function inspectRepo(repoPath: string, nemaHome: string): Promise<RepoInspect> {
  const real = await canonical(repoPath);
  const home = await canonical(nemaHome);
  if (isUnder(real, home)) throw new Error("不能绑定 ~/.nema 之下的目录");
  if (isUnder(home, real)) throw new Error("不能绑定包含 ~/.nema 的目录");

  let toplevel: string;
  try {
    toplevel = await gitText(repoPath, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error("不是 git 仓库的根目录");
  }
  const root = await canonical(toplevel);
  if (root !== real) throw new Error("不是 git 仓库的根目录");

  const commonRaw = await gitText(repoPath, ["rev-parse", "--git-common-dir"]);
  const commonAbs = path.isAbsolute(commonRaw) ? commonRaw : path.resolve(root, commonRaw);
  const gitCommonDir = await canonical(commonAbs);
  const rawUrl = await gitText(repoPath, ["remote", "get-url", "origin"]).catch(() => null);
  const remoteUrl = rawUrl === null ? null : stripUserinfo(rawUrl);
  return {
    root,
    gitCommonDir,
    defaultBranch: await originHeadBranch(repoPath),
    hasOrigin: remoteUrl !== null,
    remoteUrl,
  };
}

export async function mainRef(repoPath: string, mainBranch: string): Promise<string> {
  try {
    await gitText(repoPath, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${mainBranch}`]);
    return `origin/${mainBranch}`;
  } catch {
    return mainBranch;
  }
}

export async function fetchMain(repoPath: string, mainBranch: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isBranchName(mainBranch)) return { ok: false, error: "主分支名称无效" };
  try {
    const remotes = await gitText(repoPath, ["remote"]);
    if (!remotes.split("\n").filter(Boolean).includes("origin")) return { ok: false, error: "没有 origin" };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
  try {
    // No leading `+`, and the destination is only the remote-tracking ref, never a local branch.
    await gitText(
      repoPath,
      ["fetch", "--no-tags", "origin", "--", `refs/heads/${mainBranch}:refs/remotes/origin/${mainBranch}`],
      60_000,
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

export async function revParse(repoPath: string, ref: string): Promise<string> {
  return gitText(repoPath, ["rev-parse", "--verify", ref]);
}

export async function readFileAtRef(
  repoPath: string,
  ref: string,
  relPath: string,
  range?: { startLine?: number; endLine?: number },
): Promise<FileAtRef> {
  const rel = normalizeRepoPath(relPath);
  // --literal-pathspecs is a git global option, so it has to precede ls-tree.
  // A single row is not enough: `ls-tree <ref> -- .` lists the tree, and one root blob
  // would otherwise be returned as if the caller had asked for that file.
  const rows = parseLsTree(await gitRaw(repoPath, ["--literal-pathspecs", "ls-tree", "-z", ref, "--", rel]));
  const row = rows.length === 1 && rows[0].path === rel ? rows[0] : undefined;
  if (!row) throw new Error(`${rel} 不存在于 ${ref}`);
  if (row.mode === "120000") throw new Error(`${rel} 是符号链接，已拒绝`);
  if (row.type !== "blob") throw new Error(`${rel} 不存在于 ${ref}`);

  const lines = splitLines((await gitRaw(repoPath, ["cat-file", "blob", row.sha])).toString("utf8"));
  const startLine = range?.startLine ?? 1;
  const requestedEnd = range?.endLine ?? lines.length;
  let selected = startLine > lines.length ? [] : lines.slice(startLine - 1, requestedEnd);
  let truncated = false;
  if (selected.length > MAX_LINES) {
    selected = selected.slice(0, MAX_LINES);
    truncated = true;
  }
  let text = selected.join("\n");
  if (Buffer.byteLength(text) > MAX_BYTES) {
    text = cutUtf8(text, MAX_BYTES);
    truncated = true;
  }
  const shown = splitLines(text);
  const endLine = shown.length === 0 ? startLine : startLine + shown.length - 1;
  return { path: rel, startLine, endLine, totalLines: lines.length, text, truncated };
}

/** The paths (normalized) that are not in the tree of `ref`. A path that is absolute or has `..` throws. */
export async function missingAtRef(repoPath: string, ref: string, paths: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const p of paths) {
    const rel = normalizeRepoPath(p);
    try {
      await gitRaw(repoPath, ["--literal-pathspecs", "cat-file", "-e", `${ref}:${rel}`]);
    } catch {
      missing.push(p);
    }
  }
  return missing;
}

async function isOnMain(repoPath: string, sha: string, ref: string): Promise<boolean> {
  try {
    await gitText(repoPath, ["merge-base", "--is-ancestor", sha, ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * What changed between two commits of the bound main branch. Each of `from`/`to` is either the main ref
 * itself (`origin/<mainBranch>`, or the local branch without one) or a sha that main already contains, so
 * a side branch or an unpushed local commit is never read.
 */
export async function changedFiles(repoPath: string, from: string, to: string, mainBranch: string): Promise<ChangedFile[]> {
  if (!isBranchName(mainBranch)) throw new Error("主分支名称无效");
  const ref = await mainRef(repoPath, mainBranch);
  for (const rev of [from, to]) {
    if (rev === ref) continue;
    if (!SHA_RE.test(rev) || !(await isOnMain(repoPath, rev, ref))) throw new Error(`提交 ${rev} 不在主分支上`);
  }
  return diffNameStatus(repoPath, from, to);
}

/** The raw diff between two refs, for the daemon's own index sync. Plugin calls go through `changedFiles`. */
export async function diffNameStatus(repoPath: string, from: string, to: string): Promise<ChangedFile[]> {
  for (const rev of [from, to]) {
    if (rev.startsWith("-")) throw new Error(`无效的提交 ${rev}`);
  }
  return parseNameStatus(await gitRaw(repoPath, ["diff", "--name-status", "-M", "-z", from, to, "--"]));
}

export async function exportSnapshot(repoPath: string, ref: string, destDir: string): Promise<void> {
  const archived = await gitRaw(repoPath, ["archive", "--format=tar", "--", ref], 60_000);
  // execFile in this runtime does not forward an `input` option to stdin, so the archive
  // is a temp file. tar still extracts that stream with `-x -C destDir` and no shell.
  const scratch = await mkdtemp(path.join(tmpdir(), "nema-snapshot-"));
  const archivePath = path.join(scratch, "tree.tar");
  try {
    await writeFile(archivePath, stripSymlinkEntries(archived), { mode: 0o600 });
    await emptyDir(destDir);
    await execBuf("tar", ["-x", "-f", archivePath, "-C", destDir], { timeout: 60_000 });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
