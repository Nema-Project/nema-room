import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginToolSpec } from "@nema/shared";
import { claudeAllowedToolNames } from "../direct/tools.js";
import { windowsRuntimeEnv } from "../platform.js";

export const CLAUDE_ROOM_TOOLS = [
  "mcp__room__list_entries",
  "mcp__room__read_entry",
  "mcp__room__upsert_entry",
  "mcp__room__open_thread",
  "mcp__room__offer_skill_install",
] as const;

export type ClaudeLaunch = {
  args: string[];
  env: NodeJS.ProcessEnv;
  runDir: string;
  mcpPath: string;
};

export function prepareClaudeLaunch(o: {
  nemaHome: string;
  taskId: string;
  hubUrl: string;
  runToken: string;
  token: string;
  model?: string;
  cliEntry: string;
  execPath: string;
  parentEnv: NodeJS.ProcessEnv;
  pluginTools?: PluginToolSpec[];
  /** `--max-turns`; defaults to 24. */
  maxTurns?: number;
}): ClaudeLaunch {
  if (!/^[A-Za-z0-9_-]+$/.test(o.taskId)) throw new Error("unsafe task id");
  const runDir = path.join(o.nemaHome, "run", o.taskId);
  const configDir = path.join(runDir, "claude-config");
  const workDir = path.join(runDir, "work");
  const mcpPath = path.join(runDir, "mcp.json");

  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(workDir);
  writeFileSync(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        room: {
          command: o.execPath,
          args: [o.cliEntry, "mcp"],
          env: { NEMA_HUB_URL: o.hubUrl, NEMA_RUN_TOKEN: o.runToken },
        },
      },
    }),
    { mode: 0o600 },
  );

  const env: NodeJS.ProcessEnv = windowsRuntimeEnv(o.parentEnv);
  for (const key of ["PATH", "LANG", "LC_ALL", "TERM"] as const) {
    if (o.parentEnv[key] !== undefined) env[key] = o.parentEnv[key];
  }
  Object.assign(env, {
    TMPDIR: tmpdir(),
    HOME: configDir,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_OAUTH_TOKEN: o.token,
  });

  if (process.platform === "win32") {
    env.USERPROFILE = configDir;
    env.APPDATA = path.join(configDir, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(configDir, "AppData", "Local");
    env.PATH ??= Object.entries(o.parentEnv).find(([key]) => key.toLowerCase() === "path")?.[1];
    mkdirSync(env.APPDATA, { recursive: true });
    mkdirSync(env.LOCALAPPDATA, { recursive: true });
  }
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config",
    mcpPath,
    "--setting-sources",
    "",
    // --allowedTools only pre-approves. Without this, init lists Bash, Read, Write and friends.
    "--tools",
    "",
    "--allowedTools",
    claudeAllowedToolNames(o.pluginTools ?? []).join(","),
    "--disallowedTools",
    "AskUserQuestion",
    "--max-turns",
    String(o.maxTurns ?? 24),
  ];
  if (o.model !== undefined) args.push("--model", o.model);

  return { args, env, runDir, mcpPath };
}

/** The built-in tools a task with Skills gets (spec §3). */
export const CLAUDE_SKILL_TOOLS = ["Skill", "Read"] as const;
/** On the command line, `/path` is anchored at the main working directory. */
export const CLAUDE_SKILL_READ_RULE = "Read(/.claude/skills/**)";

/**
 * The launch arguments for a task with Skills: `project` settings (which load the copied Skills), the
 * Skill and Read tools, their approval, one `--add-dir` per repository, and the task's settings file.
 * Without Skills, `prepareClaudeLaunch`'s arguments are used unchanged.
 */
export function withSkillArgs(args: string[], prep: { settingsPath: string; addDirs: string[] }): string[] {
  const out = [...args];
  const replace = (flag: string, value: (old: string) => string) => {
    const at = out.indexOf(flag);
    if (at < 0 || at + 1 >= out.length || out.indexOf(flag, at + 1) >= 0) throw new Error(`launch arguments: expected one ${flag}`);
    out[at + 1] = value(out[at + 1]!);
  };
  replace("--setting-sources", () => "project");
  replace("--tools", () => CLAUDE_SKILL_TOOLS.join(","));
  replace("--allowedTools", (old) => [...(old ? old.split(",") : []), "Skill", CLAUDE_SKILL_READ_RULE].join(","));
  for (const dir of prep.addDirs) out.push("--add-dir", dir);
  out.push("--settings", prep.settingsPath);
  return out;
}
