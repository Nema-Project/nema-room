// Runs graphify against a code snapshot. The child sees only PATH, LANG, and a HOME under the
// snapshot, so it cannot read the user's git config, credentials, or the rest of the environment.
import { execFile, type ChildProcess, type ExecException } from "node:child_process";
import { lstatSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { commandSpec, windowsRuntimeEnv } from "../platform.js";
import { componentBin, componentStatusSync, type ComponentEnv } from "../components/store.js";
import type { ComponentStatus, FailureReason } from "../components/types.js";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import { runHelperFile } from "@nema/shared/ownedHelper";

const MAX_OUT = 65_536;
const MAX_BUFFER = 256 * 1024 * 1024;

export const INSTALL_COMMAND = "nema components install graphify";

/** What a caller can tell apart: usable, never installed, installed for another lock (disabled), or a failed last attempt. */
export type GraphifyState = "installed" | "not-installed" | "lock-mismatch" | "failed" | "installing";

const REASON_TEXT: Record<FailureReason, string> = {
  network: "网络错误",
  proxy: "代理错误",
  "hash-mismatch": "下载内容与锁不一致",
  "self-check": "自检失败",
  "unsupported-platform": "平台不支持",
  offline: "离线模式",
  "disk-space": "磁盘空间不足",
  "lock-unreadable": "组件锁无法读取",
  "offer-changed": "组件内容已变更，需要重新确认",
};

function stateOf(status: ComponentStatus | null): Exclude<GraphifyState, "installed"> {
  if (!status || status.state === "installed") return "not-installed";
  return status.state;
}

/** One sentence per state, each with the way out. A lock mismatch says the old version is off, never that it is still used. */
export function unavailableMessage(status: ComponentStatus | null): string {
  const install = `请在设置页安装，或运行 ${INSTALL_COMMAND}`;
  if (!status || status.state === "not-installed" || status.state === "installed") return `Graphify 组件未安装。${install}`;
  if (status.state === "installing") return "Graphify 组件正在安装，安装完成后再试";
  if (status.state === "lock-mismatch") return `已安装的 Graphify 组件与当前版本的 Nema 不匹配，已停用。${install}`;
  if (status.reason === "lock-unreadable") return `Graphify 组件锁无法读取：${status.detail}。这是 Nema 自身的分发损坏，重新安装 Nema 后再试`;
  if (status.reason === "unsupported-platform") return `此平台不支持 Graphify 组件：${status.detail}`;
  const disabled = status.installedLockHash ? "旧版本组件已停用。" : "";
  if (status.reason === "offline") return `Graphify 组件未安装，组件下载已关闭（离线模式）。${disabled}请导入离线组件包`;
  return `Graphify 组件未安装（上次安装失败：${REASON_TEXT[status.reason]}，${status.detail}）。${disabled}重试：${INSTALL_COMMAND}`;
}

/** Graphify cannot run here. `state` and `status` say why; the message is the one shown to people and agents. */
export class GraphifyUnavailableError extends Error {
  readonly code = "graphify-unavailable";
  constructor(readonly state: Exclude<GraphifyState, "installed">, readonly status: ComponentStatus | null, message = unavailableMessage(status)) {
    super(message);
    this.name = "GraphifyUnavailableError";
  }
}

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
 * An omitted `bin` is resolved by `resolveGraphify`, never by a `PATH` lookup.
 * Read at call time, so a caller may fill the object in after handing it over.
 */
export type GraphifyOpts = {
  bin?: string;
  timeoutMs?: number;
  ownedHelpers?: OwnedHelperScope;
  /** Component store and lock to resolve against; tests pass temp directories. */
  components?: ComponentEnv;
  /** A desktop payload root that may still hold `tools/graphify` (payloads from before on-demand install). */
  payloadRoot?: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Full `extract` of a repository. The one-minute cap kills a monorepo mid-build and reports
 * the same "graphify 已中断" as a cancel. Stays under the hub's 5-minute index RPC so fetch
 * and the snapshot export still fit.
 * ponytail: a larger repo needs this and INDEX_RPC_TIMEOUT_MS raised together.
 */
export const EXTRACT_TIMEOUT_MS = 180_000;

export type GraphifyResolution =
  | { found: true; bin: string; source: "env" | "component" | "payload" }
  | { found: false; state: Exclude<GraphifyState, "installed">; status: ComponentStatus | null };

function regularFile(file: string): boolean {
  try {
    const info = lstatSync(file);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Which graphify to run, in order: `NEMA_GRAPHIFY_BIN`; the component store's active version when its
 * lock-hash is the shipped lock's; `tools/graphify` in an older desktop payload; otherwise not installed,
 * with the component status saying why. A version installed for another lock is never used. No PATH lookup.
 */
export function resolveGraphify(env: NodeJS.ProcessEnv = process.env, opts: Pick<GraphifyOpts, "components" | "payloadRoot"> = {}): GraphifyResolution {
  const fromEnv = env.NEMA_GRAPHIFY_BIN;
  if (typeof fromEnv === "string" && fromEnv !== "") return { found: true, bin: fromEnv, source: "env" };
  const components: ComponentEnv = { env, ...opts.components };
  const component = componentBin("graphify", components);
  if (component) return { found: true, bin: component, source: "component" };
  const payloadRoot = opts.payloadRoot
    ?? (typeof env.NEMA_PAYLOAD_ROOT === "string" && env.NEMA_PAYLOAD_ROOT !== "" ? env.NEMA_PAYLOAD_ROOT : path.dirname(process.execPath));
  const payload = path.join(payloadRoot, "tools", "graphify", process.platform === "win32" ? "graphify.exe" : "graphify");
  if (regularFile(payload)) return { found: true, bin: payload, source: "payload" };
  let status: ComponentStatus | null = null;
  try {
    status = componentStatusSync("graphify", components);
  } catch (error) {
    // An unreadable shipped lock is not "not installed": installing cannot fix it, so the
    // resolution carries the lock error itself and status/doctor show it as such.
    status = {
      state: "failed",
      name: "graphify",
      lockHash: null,
      reason: "lock-unreadable",
      detail: error instanceof Error ? error.message : String(error),
      at: null,
    };
  }
  return { found: false, state: stateOf(status), status };
}

/** The graphify `resolveGraphify` picks, or null when none is installed. */
export function packagedGraphifyBin(env: NodeJS.ProcessEnv = process.env, opts: Pick<GraphifyOpts, "components" | "payloadRoot"> = {}): string | null {
  const resolved = resolveGraphify(env, opts);
  return resolved.found ? resolved.bin : null;
}

function graphifyBin(opts?: GraphifyOpts): string {
  if (opts?.bin) return opts.bin;
  const resolved = resolveGraphify(process.env, opts ?? {});
  if (!resolved.found) throw new GraphifyUnavailableError(resolved.state, resolved.status);
  return resolved.bin;
}

/** The binary was resolved but is gone (or an explicit `bin` never existed). */
const missingBinary = () => new GraphifyUnavailableError("not-installed", null);

function graphifyTimeout(opts?: GraphifyOpts): number {
  const n = opts?.timeoutMs;
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** An explicit `timeoutMs` still wins, so tests can stop a hung extract quickly. */
function extractCallOpts(opts?: GraphifyOpts): GraphifyOpts {
  if (opts?.timeoutMs !== undefined && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) return opts;
  return { ...opts, timeoutMs: EXTRACT_TIMEOUT_MS };
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
        if (code === "missing") throw missingBinary();
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
          reject(missingBinary());
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
  finish(await runGraphify(snapshotRoot, ["extract", src, "--code-only"], snapshotRoot, extractCallOpts(opts)));
}

/** Extract writes `src/graphify-out/graph.json`. A query from the snapshot root looks beside itself and misses it. */
function graphJson(snapshotRoot: string): string {
  return path.join(snapshotRoot, "src", "graphify-out", "graph.json");
}

export async function queryIndex(
  snapshotRoot: string,
  kind: "query" | "explain" | "path",
  args: string[],
  opts?: GraphifyOpts,
): Promise<string> {
  for (const arg of args) {
    if (arg.startsWith("-")) throw new Error(`参数不能以 - 开头：${arg}`);
  }
  return finish(await runGraphify(snapshotRoot, [kind, ...args, "--graph", graphJson(snapshotRoot)], snapshotRoot, opts));
}

export type GraphifyInstallStatus = {
  installed: boolean;
  /** The version text when installed; otherwise the sentence for `state`, with the way out. */
  detail: string;
  state: GraphifyState;
  /** Why the last attempt failed, when `state` is `failed`. */
  reason?: FailureReason;
  /** Which resolution step supplied the binary; `explicit` for a caller-given `bin`. */
  source?: "explicit" | "env" | "component" | "payload";
};

/**
 * Resolution first, so a missing, mismatched or failed component is reported as such without running
 * anything; then `graphify --version` on what was found. A binary that runs but fails still throws.
 */
export async function graphifyInstallStatus(opts?: GraphifyOpts): Promise<GraphifyInstallStatus> {
  let source: GraphifyInstallStatus["source"] = "explicit";
  let call = opts;
  if (!opts?.bin) {
    const resolved = resolveGraphify(process.env, opts ?? {});
    if (!resolved.found) {
      const reason = resolved.status?.state === "failed" ? resolved.status.reason : undefined;
      return { installed: false, detail: unavailableMessage(resolved.status), state: resolved.state, ...(reason ? { reason } : {}) };
    }
    source = resolved.source;
    call = { ...opts, bin: resolved.bin };
  }
  const dir = await mkdtemp(path.join(tmpdir(), "nema-graphify-version-"));
  try {
    await mkdir(path.join(dir, "home"), { recursive: true });
    const detail = finish(await runGraphify(dir, ["--version"], dir, call)).trim();
    return { installed: true, detail, state: "installed", source };
  } catch (e) {
    if (e instanceof GraphifyUnavailableError) return { installed: false, detail: e.message, state: e.state };
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
