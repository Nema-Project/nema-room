// Per-workspace Codex isolation (spec 6.6). Security boundary: content of workspace A must not
// reach a run for workspace B through Codex memory, history, global instructions, other MCP
// servers or files. The Codex home is generated from scratch; the ONLY thing taken from the
// user's Codex home is an auth.json symlink.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

export type IsolationPaths = {
  wsHome: string;
  codexHome: string;
  workDir: string;
  tmpDir: string;
};

export type McpSpec = { command: string; args: string[]; env: Record<string, string> };

export function checkCodexAuth(userCodexHome: string): { ok: true; authPath: string } | { ok: false; error: string } {
  const authPath = path.join(userCodexHome, "auth.json");
  try {
    const cfg = parseToml(readFileSync(path.join(userCodexHome, "config.toml"), "utf8")) as Record<string, unknown>;
    if (cfg.cli_auth_credentials_store === "keyring") {
      return {
        ok: false,
        error:
          'Codex 凭证存放在系统钥匙串中，Nema 无法读取。请在 ~/.codex/config.toml 设置 cli_auth_credentials_store = "file"，然后重新运行 codex login。',
      };
    }
  } catch {
    // missing or unparsable user config: fall through to the auth.json check
  }
  if (!existsSync(authPath)) {
    return {
      ok: false,
      error: `找不到 Codex 登录文件 ${authPath}。请先运行 codex login；如果凭证存在系统钥匙串里，请在 ~/.codex/config.toml 设置 cli_auth_credentials_store = "file" 后重新登录。`,
    };
  }
  return { ok: true, authPath };
}

export function renderCodexConfig(mcp: McpSpec): string {
  // default_tools_approval_mode: under approval_policy="never" non-interactive `codex exec` auto-rejects MCP tool
  // approvals (Codex 0.148), so the (only) room server's tools must be pre-approved.
  // smol-toml stringify escapes every string, so values cannot break out of their TOML string.
  return stringifyToml({
    approval_policy: "never",
    sandbox_mode: "read-only",
    web_search: "disabled",
    check_for_update_on_startup: false,
    history: { persistence: "none" },
    features: { memories: false },
    analytics: { enabled: false },
    shell_environment_policy: { inherit: "core" },
    mcp_servers: { room: { command: mcp.command, args: mcp.args, env: mcp.env, default_tools_approval_mode: "approve" } },
  }) + "\n";
}

export async function prepareIsolation(opts: {
  nemaHome: string;
  workspaceId: string;
  userCodexHome: string;
  mcp: McpSpec;
}): Promise<IsolationPaths> {
  if (!/^[A-Za-z0-9_-]+$/.test(opts.workspaceId)) throw new Error(`invalid workspace id: ${opts.workspaceId}`);
  const wsHome = path.join(opts.nemaHome, "ws", opts.workspaceId);
  const codexHome = path.join(wsHome, "codex-home");
  await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask and skipped for existing dirs; enforce explicitly.
  await fs.chmod(wsHome, 0o700);
  await fs.chmod(codexHome, 0o700);

  const link = path.join(codexHome, "auth.json");
  await fs.rm(link, { force: true });
  await fs.symlink(path.join(opts.userCodexHome, "auth.json"), link);

  // Regenerated every run: it carries this run's token. Write then chmod so a pre-existing file is covered too.
  const cfgPath = path.join(codexHome, "config.toml");
  await fs.writeFile(cfgPath, renderCodexConfig(opts.mcp), { mode: 0o600 });
  await fs.chmod(cfgPath, 0o600);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "nema-run-"));
  const tmpDir = path.join(workDir, ".tmp");
  await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });
  return { wsHome, codexHome, workDir, tmpDir };
}

export function buildEnv(paths: IsolationPaths, parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "LANG", "LC_ALL", "TERM"]) {
    const v = parentEnv[k];
    if (v !== undefined) env[k] = v;
  }
  env.HOME = paths.wsHome;
  env.CODEX_HOME = paths.codexHome;
  env.TMPDIR = paths.tmpDir;
  return env;
}

export function preflight(paths: IsolationPaths): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];

  for (const f of ["AGENTS.md", "AGENTS.override.md", "instructions.md"]) {
    if (existsSync(path.join(paths.codexHome, f))) problems.push(`codexHome 中存在不应有的 ${f}`);
  }

  try {
    const cfg = parseToml(readFileSync(path.join(paths.codexHome, "config.toml"), "utf8")) as { mcp_servers?: Record<string, unknown> };
    const names = Object.keys(cfg.mcp_servers ?? {});
    if (names.length !== 1 || names[0] !== "room") {
      problems.push(`config.toml 的 mcp_servers 必须恰好只有 room，实际为 [${names.join(", ")}]`);
    }
  } catch (e) {
    problems.push(`无法读取或解析 config.toml：${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    if (!lstatSync(path.join(paths.codexHome, "auth.json")).isSymbolicLink()) problems.push("auth.json 不是符号链接");
  } catch {
    problems.push("auth.json 不存在");
  }

  // Codex discovers project docs / project root by walking up from the cwd.
  let dir = path.resolve(paths.workDir);
  for (;;) {
    for (const f of [".git", "AGENTS.md", "AGENTS.override.md"]) {
      if (existsSync(path.join(dir, f))) problems.push(`${dir} 中存在 ${f}`);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return problems.length ? { ok: false, problems } : { ok: true };
}

export async function cleanupRun(paths: IsolationPaths): Promise<void> {
  await fs.rm(paths.workDir, { recursive: true, force: true });
}
