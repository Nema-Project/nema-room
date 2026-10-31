import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { commandSpec } from "./platform.js";
import { requireSystemGit } from "./systemGit.js";
import { claudeTokenPath, readClaudeToken } from "./claude/token.js";
import { checkCodexAuth } from "./codex/isolation.js";
import type { NemaConfig } from "./config.js";
import { AuthStore, UNUSABLE_FILE_MESSAGE } from "./direct/authStore.js";
import { readByokKey } from "./direct/byok.js";
import { readCodexCliTokens } from "./direct/codexLogin.js";
import { jwtExp } from "./direct/jwt.js";
import { siwcRefresher } from "./direct/siwc.js";
import { graphifyInstallStatus, type GraphifyOpts } from "./repos/graphify.js";
import { REPORT_AGENTS, reportHookInstalled } from "./report/install.js";
import { reportTokenPath } from "./report/token.js";
import { githubTokenPath, readGithubToken } from "./secrets/github.js";
import { hasSymlinkedComponent, strandedRetireClaims } from "./accounts/paths.js";

const execFileAsync = promisify(execFile);

export type DoctorCheck = { name: string; ok: boolean; detail: string };
export type DoctorOpts = {
  codexBin: string;
  userCodexHome: string;
  hubUrl: string;
  tokenFile: string;
  /** Where Nema's own direct login lives (`<nemaHome>/auth.json`). */
  nemaHome: string;
  /** The configured adapter: a missing login only fails the check when this is codex-direct. */
  adapter: NemaConfig["adapter"];
  /** Defaults to siwc. compat reads the Codex CLI login instead of ~/.nema/auth.json. */
  authMode?: NemaConfig["authMode"];
  model?: NemaConfig["model"];
  /** For tests: production passes nothing and runs `graphify` from PATH. */
  graphify?: GraphifyOpts;
  /** Home dir holding ~/.claude and ~/.codex for the report-hook rows. Defaults to os.homedir(). */
  agentHome?: string;
  /** For tests: production runs `github-mcp-server` from PATH. */
  githubMcpServerBin?: string;
};

export function defaultTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.NEMA_DATA_DIR || path.join(os.homedir(), ".nema", "data");
  const dir = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.join(dir, "daemon-token");
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function version(bin: string, args: string[]): Promise<string> {
  const command = commandSpec(bin, args);
  const { stdout } = await execFileAsync(command.bin, command.args, { timeout: 10_000, windowsHide: true });
  return stdout.trim().split("\n")[0] ?? "";
}

/** Direct-login status; never reveals token contents. */
function directLoginCheck(opts: DoctorOpts): DoctorCheck {
  const name = "直连登录";
  const required = opts.adapter === "codex-direct" && (opts.authMode ?? "siwc") !== "byok";
  if (opts.authMode === "byok") return { name, ok: true, detail: "未检查（authMode=byok 使用 BYOK key）" };
  if ((opts.authMode ?? "siwc") === "compat") {
    try {
      const t = readCodexCliTokens(opts.userCodexHome);
      const tail = t.accountId ? `，账号 …${t.accountId.slice(-4)}` : "";
      const exp = t.exp === null ? "到期时间未知" : `到期 ${new Date(t.exp * 1000).toISOString()}`;
      return { name, ok: true, detail: `已登录（compat，读取 Codex 登录${tail}，${exp}）` };
    } catch (e) {
      return { name, ok: !required, detail: e instanceof Error ? e.message : String(e) };
    }
  }
  const { auth, reason } = new AuthStore(opts.nemaHome, siwcRefresher).inspect();
  if (!auth) return { name, ok: !required, detail: reason === "unusable" ? UNUSABLE_FILE_MESSAGE : "未登录" };
  if (auth.tokens.refresh_token === "") return { name, ok: !required, detail: "已失效，请运行 nema auth login" };
  const exp = jwtExp(auth.tokens.access_token);
  return { name, ok: true, detail: `已登录（${auth.mode}，${exp === null ? "到期时间未知" : `到期 ${new Date(exp * 1000).toISOString()}`}）` };
}

const CLAUDE_ONLY = "未检查（仅 adapter=claude-code 需要）";
const CLAUDE_MISSING = "找不到 claude。请先安装 Claude Code 并把它放到 PATH 上。";

async function claudeBinaryCheck(opts: DoctorOpts): Promise<DoctorCheck> {
  const name = "claude 可用";
  if (opts.adapter !== "claude-code") return { name, ok: true, detail: CLAUDE_ONLY };
  try {
    return { name, ok: true, detail: await version("claude", ["--version"]) };
  } catch {
    return { name, ok: false, detail: CLAUDE_MISSING };
  }
}

function claudeTokenCheck(opts: DoctorOpts): DoctorCheck {
  const name = "Claude Code token";
  if (opts.adapter !== "claude-code") return { name, ok: true, detail: CLAUDE_ONLY };
  try {
    readClaudeToken(opts.nemaHome);
    return { name, ok: true, detail: `${process.platform === "win32" ? "私有 Windows ACL" : "权限为 0600"}（${claudeTokenPath(opts.nemaHome)}）` };
  } catch (e) {
    return { name, ok: false, detail: msg(e) };
  }
}

/** Informational. A missing binary is the install hint, never a failed check. */
async function graphifyCheck(opts: DoctorOpts): Promise<DoctorCheck> {
  const name = "graphify 可用";
  try {
    const status = await graphifyInstallStatus(opts.graphify);
    return { name, ok: true, detail: status.detail };
  } catch (e) {
    return { name, ok: true, detail: msg(e) };
  }
}

function byokCheck(opts: DoctorOpts): DoctorCheck {
  const name = "BYOK";
  if (opts.adapter !== "codex-direct" || opts.authMode !== "byok") {
    return { name, ok: true, detail: "未启用（仅 authMode=byok 需要）" };
  }

  const problems: string[] = [];
  try {
    readByokKey(opts.nemaHome);
  } catch (e) {
    problems.push(msg(e));
  }
  if (!opts.model) problems.push("未设置 model，请运行 nema config set model <名称>");
  return {
    name,
    ok: problems.length === 0,
    detail: problems.length === 0 ? `${process.platform === "win32" ? "key 使用私有 Windows ACL" : "key 文件权限为 0600"}，model 已设置` : problems.join("；"),
  };
}

const GITHUB_MCP_SERVER_HINT = "https://github.com/github/github-mcp-server/releases";

/** Informational. A missing binary is the install hint, never a failed check. */
async function githubMcpServerCheck(opts: DoctorOpts): Promise<DoctorCheck> {
  const name = "github-mcp-server";
  try {
    return { name, ok: true, detail: `可用：${await version(opts.githubMcpServerBin ?? "github-mcp-server", ["--version"])}` };
  } catch {
    return { name, ok: true, detail: `未安装：请从 ${GITHUB_MCP_SERVER_HINT} 下载` };
  }
}

/**
 * Informational: credential copies an interrupted migration left under a claim name.
 *
 * They are harmless (the account already holds the credential) but they are duplicates of a secret sitting
 * where nothing reads them, so the user should know they exist and can remove them by hand. Only the names
 * are printed; never the contents.
 */
function strandedClaimsCheck(opts: DoctorOpts): DoctorCheck {
  const name = "迁移遗留文件";
  // A linked home is not a layout the account store reads, so nothing under it is reported as a leftover:
  // the names would describe a directory Nema refuses to use.
  if (hasSymlinkedComponent(opts.nemaHome, opts.nemaHome)) return { name, ok: true, detail: "未检查（Nema 主目录是符号链接）" };
  const stranded = strandedRetireClaims(opts.nemaHome);
  if (stranded.length === 0) return { name, ok: true, detail: "无" };
  const paths = stranded.map((file) => path.join(opts.nemaHome, file)).join("、");
  return {
    name,
    ok: true, // informational: a leftover never means the current login is unusable
    detail: `发现 ${stranded.length} 个退役过程中留下的旧凭据副本（${paths}）。账户里已经有一份，确认后可以手动删除这些文件。`,
  };
}

/** Informational; never reveals the token. */
function githubTokenCheck(opts: DoctorOpts): DoctorCheck {
  const name = "GitHub 令牌";
  if (!existsSync(githubTokenPath(opts.nemaHome))) return { name, ok: true, detail: "不存在（可运行 nema auth github）" };
  try {
    readGithubToken(opts.nemaHome);
    return { name, ok: true, detail: `存在，${process.platform === "win32" ? "私有 Windows ACL" : "权限为 0600"}（${githubTokenPath(opts.nemaHome)}）` };
  } catch (e) {
    return { name, ok: true, detail: msg(e) };
  }
}

export async function runDoctor(opts: DoctorOpts): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  try {
    checks.push({ name: "git 可用", ok: true, detail: await requireSystemGit() });
  } catch (e) {
    checks.push({ name: "git 可用", ok: false, detail: msg(e) });
  }

  // The codex binary is not used: Codex runs in-process. The row stays so a missing install is visible, and it never fails the check.
  const fileRequired = opts.adapter === "codex-direct" && (opts.authMode ?? "siwc") === "compat";
  try {
    checks.push({ name: "codex 可用", ok: true, detail: await version(opts.codexBin, ["--version"]) });
  } catch (e) {
    checks.push({ name: "codex 可用", ok: true, detail: `未安装（Codex 已改为直连，不启动 CLI）：${msg(e)}` });
  }

  const auth = checkCodexAuth(opts.userCodexHome);
  checks.push({
    name: "Codex 登录文件",
    ok: auth.ok || !fileRequired,
    detail: auth.ok ? auth.authPath : fileRequired ? auth.error : "未找到（仅 authMode=compat 需要）",
  });

  checks.push(directLoginCheck(opts));
  checks.push(byokCheck(opts));

  const statusUrl = `${opts.hubUrl.replace(/\/+$/, "")}/api/daemon/status`;
  try {
    const res = await fetch(statusUrl, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { connected?: boolean };
    checks.push({ name: "hub 可达", ok: true, detail: `${opts.hubUrl}（daemon ${body.connected ? "已连接" : "未连接"}）` });
  } catch (e) {
    checks.push({ name: "hub 可达", ok: false, detail: `无法访问 ${statusUrl}：${msg(e)}。请先运行 npm run dev` });
  }

  const hasToken = existsSync(opts.tokenFile);
  checks.push({
    name: "daemon token 文件",
    ok: hasToken,
    detail: hasToken ? opts.tokenFile : `找不到 ${opts.tokenFile}。请先启动 hub（它会生成该文件）`,
  });

  checks.push(await claudeBinaryCheck(opts));
  checks.push(claudeTokenCheck(opts));
  checks.push(await graphifyCheck(opts));

  // Informational: the report hook and token never fail the doctor.
  const agentHome = opts.agentHome ?? os.homedir();
  for (const agent of REPORT_AGENTS) {
    checks.push({ name: `上报钩子：${agent}`, ok: true, detail: reportHookInstalled(agent, agentHome) ? "已安装" : "未安装" });
  }
  checks.push({ name: "上报令牌", ok: true, detail: existsSync(reportTokenPath(opts.nemaHome)) ? "存在" : "不存在" });

  // Informational: the GitHub plugin is off by default.
  checks.push(await githubMcpServerCheck(opts));
  checks.push(githubTokenCheck(opts));
  checks.push(strandedClaimsCheck(opts));

  return checks;
}
