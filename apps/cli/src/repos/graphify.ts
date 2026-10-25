// Runs graphify against a code snapshot. The child sees only PATH, LANG, and a HOME under the
// snapshot, so it cannot read the user's git config, credentials, or the rest of the environment.
import { execFile, type ChildProcess, type ExecException } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { commandSpec, windowsRuntimeEnv } from "../platform.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import { runHelperFile } from "@nema/shared/ownedHelper";

const MAX_OUT = 65_536;
const MAX_BUFFER = 256 * 1024 * 1024;
const INSTALL_HINT = "随包的 Graphify 运行环境缺失";

export function graphifyEnv(snapshotRoot: string): NodeJS.ProcessEnv {
  return {
    ...windowsRuntimeEnv(process.env),
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "",
    HOME: path.join(snapshotRoot, "home"),
    GRAPHIFY_BACKEND: "none",
    GRAPHIFY_QUERY_LOG_DISABLE: "1",
  };
}

/**
 * Where graphify is and how long a call may run. Tests pass a fake binary.
 * An omitted `bin` is the packaged file, never a `PATH` lookup.
 * Read at call time, so a caller may fill the object in after handing it over.
 */
export type GraphifyOpts = { bin?: string; timeoutMs?: number; ownedHelpers?: OwnedHelperScope };

const DEFAULT_TIMEOUT_MS = 60_000;

/** `tools/graphify/graphify` under the payload, or `NEMA_GRAPHIFY_BIN` when that is set. */
export function packagedGraphifyBin(env: NodeJS.ProcessEnv = process.env): string {
  const name = process.platform === "win32" ? "graphify.exe" : "graphify";
  const fromEnv = env.NEMA_GRAPHIFY_BIN;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  const root = typeof env.NEMA_PAYLOAD_ROOT === "string" && env.NEMA_PAYLOAD_ROOT !== ""
    ? env.NEMA_PAYLOAD_ROOT
    : path.dirname(process.execPath);
  return path.join(root, "tools", "graphify", name);
}

function graphifyBin(opts?: GraphifyOpts): string {
  return opts?.bin || packagedGraphifyBin();
}

function graphifyTimeout(opts?: GraphifyOpts): number {
  const n = opts?.timeoutMs;
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

function cutUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let index = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += ch.length;
  }
  return text.slice(0, index);
}

type RunResult = { code: number; stdout: Buffer; stderr: Buffer };

/** `null` is what this Node reports after a timeout kill. `Number(null)` is 0, so it must not count as success. */
function exitCode(error: ExecException): number | "missing" | "killed" {
  if (error.code === "ENOENT") return "missing";
  if (error.signal || error.killed || error.code == null || error.code === 0) return "killed";
  if (typeof error.code === "number") return error.code;
  const parsed = Number(error.code);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : "killed";
}

function stopChild(child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const sigkill = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, 200);
  child.once("exit", () => clearTimeout(sigkill));
}

// ponytail: stdout/stderr are buffered up to 1MB, then the returned text is cut to 64KB.
// A larger graphify print fails the call. Upgrade path: stream and destroy the child after 64KB.
function runGraphify(snapshotRoot: string, args: string[], cwd: string, opts?: GraphifyOpts): Promise<RunResult> {
  const bin = graphifyBin(opts);
  const command = commandSpec(bin, args, graphifyEnv(snapshotRoot));
  if (opts?.ownedHelpers) {
    return runHelperFile(command.bin, command.args, {
      cwd,
      env: graphifyEnv(snapshotRoot),
      timeout: graphifyTimeout(opts),
      encoding: "buffer",
      maxBuffer: 1024 * 1024,
    }, opts.ownedHelpers).then((result) => {
      if (result.error) {
        const code = exitCode(result.error as ExecException);
        if (code === "missing") throw new Error(INSTALL_HINT);
        if (code === "killed") throw new Error("graphify 已中断");
        return { code, stdout: result.stdout, stderr: result.stderr };
      }
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(
      command.bin,
      command.args,
      { cwd, env: graphifyEnv(snapshotRoot), shell: false, encoding: "buffer", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
        const errOut = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");
        if (timedOut) {
          reject(new Error("graphify 已中断"));
          return;
        }
        if (!error) {
          resolve({ code: 0, stdout: out, stderr: errOut });
          return;
        }
        const code = exitCode(error);
        if (code === "missing") {
          reject(new Error(INSTALL_HINT));
          return;
        }
        if (code === "killed") {
          reject(new Error("graphify 已中断"));
          return;
        }
        resolve({ code, stdout: out, stderr: errOut });
      },
    );
    // Report timeout only after execFile's close callback confirms the child exited.
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      stopChild(child);
    }, graphifyTimeout(opts));
  });
}

function finish(result: RunResult): string {
  if (result.code === 3) throw new Error("名称不唯一");
  if (result.code === 4) throw new Error("没有匹配");
  if (result.code !== 0) {
    const text = result.stderr.toString("utf8").trim();
    throw new Error(text || `graphify exited ${result.code}`);
  }
  return cutUtf8(result.stdout.toString("utf8"), MAX_OUT);
}

export async function buildIndex(snapshotRoot: string, opts?: GraphifyOpts): Promise<void> {
  const src = path.join(snapshotRoot, "src");
  await mkdir(path.join(snapshotRoot, "home"), { recursive: true });
  finish(await runGraphify(snapshotRoot, ["extract", src, "--code-only"], snapshotRoot, opts));
}

/** Runs from the snapshot root, like extract and update, so graphify finds the same graphify-out/. */
export async function queryIndex(
  snapshotRoot: string,
  kind: "query" | "explain" | "path",
  args: string[],
  opts?: GraphifyOpts,
): Promise<string> {
  // ponytail: `--` before the values is not used because no real graphify CLI was available to confirm it.
  for (const arg of args) {
    if (arg.startsWith("-")) throw new Error(`参数不能以 - 开头：${arg}`);
  }
  return finish(await runGraphify(snapshotRoot, [kind, ...args], snapshotRoot, opts));
}

/** Version text when `graphify --version` runs; the install hint when the binary is missing. */
export async function graphifyInstallStatus(opts?: GraphifyOpts): Promise<{ installed: boolean; detail: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "nema-graphify-version-"));
  try {
    await mkdir(path.join(dir, "home"), { recursive: true });
    const detail = finish(await runGraphify(dir, ["--version"], dir, opts)).trim();
    return { installed: true, detail };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === INSTALL_HINT) return { installed: false, detail: message };
    throw e;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...windowsRuntimeEnv(process.env),
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function git(repoPath: string, args: string[], ownedHelpers?: OwnedHelperScope): Promise<Buffer> {
  if (ownedHelpers) {
    return runHelperFile("git", ["-C", repoPath, ...args], {
      env: gitEnv(), encoding: "buffer", maxBuffer: MAX_BUFFER,
    }, ownedHelpers).then((result) => {
      if (result.error) {
        const text = result.stderr.toString("utf8").trim();
        throw new Error(text || result.error.message);
      }
      return result.stdout;
    });
  }
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", repoPath, ...args],
      { env: gitEnv(), shell: false, encoding: "buffer", maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
        if (error) {
          const text = (Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "")).toString("utf8").trim();
          reject(new Error(text || error.message));
          return;
        }
        resolve(out);
      },
    );
  });
}

/** Reject absolute, empty, and any path that still contains a `..` segment after normalization. */
function normalizeRepoPath(relPath: string): string {
  if (relPath === "" || path.isAbsolute(relPath)) throw new Error("路径必须是仓库内的相对路径");
  const normalized = path.posix.normalize(relPath);
  if (normalized.split("/").includes("..")) throw new Error("路径必须是仓库内的相对路径");
  return normalized;
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

/** Full blob bytes, or null for a symlink (mode 120000), which is not written into the snapshot. */
async function blobAt(repoPath: string, ref: string, relPath: string, ownedHelpers?: OwnedHelperScope): Promise<Buffer | null> {
  const rel = normalizeRepoPath(relPath);
  const rows = parseLsTree(await git(repoPath, ["--literal-pathspecs", "ls-tree", "-z", ref, "--", rel], ownedHelpers));
  const row = rows.length === 1 && rows[0]?.path === rel ? rows[0] : undefined;
  if (!row || row.type !== "blob") throw new Error(`${rel} 不存在于 ${ref}`);
  if (row.mode === "120000") return null;
  return git(repoPath, ["cat-file", "blob", row.sha], ownedHelpers);
}

function destination(src: string, relPath: string): string {
  const rel = normalizeRepoPath(relPath);
  const dest = path.resolve(src, rel);
  const fromSrc = path.relative(src, dest);
  if (fromSrc === "" || fromSrc === ".." || fromSrc.startsWith(`..${path.sep}`) || path.isAbsolute(fromSrc)) {
    throw new Error("路径必须是仓库内的相对路径");
  }
  return dest;
}

async function writeInside(src: string, relPath: string, data: Buffer): Promise<void> {
  const dest = destination(src, relPath);
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    if ((await lstat(dest)).isSymbolicLink()) await rm(dest);
  } catch {
    // The file is not there yet.
  }
  await writeFile(dest, data);
}

export async function updateIndex(
  snapshotRoot: string,
  changed: { status: string; path: string }[],
  repoPath: string,
  ref: string,
  opts?: GraphifyOpts,
): Promise<void> {
  const src = path.join(snapshotRoot, "src");
  await mkdir(src, { recursive: true });
  for (const file of changed) {
    if (file.status.startsWith("D")) {
      await rm(destination(src, file.path), { force: true });
      continue;
    }
    const blob = await blobAt(repoPath, ref, file.path, opts?.ownedHelpers);
    if (blob === null) continue;
    await writeInside(src, file.path, blob);
  }
  await mkdir(path.join(snapshotRoot, "home"), { recursive: true });
  // Like extract: only code is indexed, so no model backend is ever asked for docs or images.
  finish(await runGraphify(snapshotRoot, ["update", src, "--code-only"], snapshotRoot, opts));
}
