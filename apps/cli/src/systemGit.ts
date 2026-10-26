import { execFile } from "node:child_process";
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

async function gitVersionOutput(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--version"], { timeout: 15_000, windowsHide: true });
  return stdout;
}

/**
 * Nema runs the git the user already has, so fetch uses their own credential helpers and SSH setup.
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
