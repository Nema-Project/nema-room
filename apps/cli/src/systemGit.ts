import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** `rev-parse --path-format=absolute` (worktree mapping) needs Git 2.31. */
export const MIN_GIT_VERSION = [2, 31, 0] as const;
const MIN_TEXT = MIN_GIT_VERSION.join(".");
const INSTALL_URL = "https://git-scm.com/downloads";

export function parseGitVersion(output: string): [number, number, number] | null {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function meetsMinimum(version: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (version[i] !== MIN_GIT_VERSION[i]) return version[i] > MIN_GIT_VERSION[i];
  return true;
}

function unavailable(reason: { zh: string; en: string }, cause?: unknown): Error {
  return Object.assign(
    new Error(`Nema 需要 Git ${MIN_TEXT} 或更高版本：${reason.zh}。请从 ${INSTALL_URL} 安装后重新打开 Nema。 / Nema needs Git ${MIN_TEXT} or later: ${reason.en}. Install it from ${INSTALL_URL} and reopen Nema.`, { cause }),
    { code: "NEMA_GIT_UNAVAILABLE" },
  );
}

/** PATH a Mac app gets when Finder opens it. Anything else is left alone, including a test that cleared PATH. */
export const FINDER_GIT_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
/** Install locations Finder does not put on PATH. Homebrew (Apple silicon, then Intel) and MacPorts. */
export const EXTRA_GIT_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];

export function gitPathForFinderLaunch(currentPath: string | undefined, presentDirectories: readonly string[], platform = process.platform): string | undefined {
  if (platform !== "darwin") return currentPath;
  const parts = (currentPath ?? "").split(":").filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !FINDER_GIT_PATH.includes(part))) return currentPath;
  const prefix = presentDirectories.filter((dir) => EXTRA_GIT_DIRECTORIES.includes(dir) && !parts.includes(dir));
  return prefix.length ? [...prefix, ...parts].join(":") : currentPath;
}

function directoriesWithGit(directories: readonly string[]): string[] {
  return directories.filter((dir) => {
    try {
      accessSync(path.join(dir, "git"), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

async function gitVersionOutput(): Promise<string> {
  if (process.platform === "darwin") {
    const next = gitPathForFinderLaunch(process.env.PATH, directoriesWithGit(EXTRA_GIT_DIRECTORIES));
    if (next && next !== process.env.PATH) process.env.PATH = next;
  }
  const { stdout } = await execFileAsync("git", ["--version"], { timeout: 15_000, windowsHide: true });
  return stdout;
}

/**
 * Nema runs the git the user already has, so fetch uses their own credential helpers and SSH setup.
 * A Mac app opened from Finder only has /usr/bin on PATH; Homebrew and MacPorts git are added in that case.
 * Resolves with the `git --version` line; rejects with code NEMA_GIT_UNAVAILABLE and install guidance.
 */
export async function requireSystemGit(run: () => Promise<string> = gitVersionOutput): Promise<string> {
  let output: string;
  try {
    output = await run();
  } catch (error) {
    throw unavailable({ zh: "找不到可用的 git", en: "git could not be run" }, error);
  }
  const line = output.trim().split("\n")[0] ?? "";
  const version = parseGitVersion(line);
  if (!version) throw unavailable({ zh: `无法识别 git 版本（${line}）`, en: `its version is unreadable (${line})` });
  if (!meetsMinimum(version)) throw unavailable({ zh: `当前是 ${version.join(".")}`, en: `found ${version.join(".")}` });
  return line;
}
