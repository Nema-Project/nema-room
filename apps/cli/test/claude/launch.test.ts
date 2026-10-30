import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CLAUDE_ROOM_TOOLS, prepareClaudeLaunch, withSkillArgs } from "../../src/claude/launch.js";
import { ROOM_TOOLS } from "../../src/direct/tools.js";

let root: string;
let nemaHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nema-claude-launch-test-"));
  nemaHome = join(root, "nema");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const options = (model?: string) => ({
  nemaHome,
  taskId: "task-123",
  hubUrl: "http://127.0.0.1:4010",
  runToken: "task-run-token",
  token: "claude-token",
  model,
  cliEntry: "/opt/nema/dist/index.js",
  execPath: "/usr/local/bin/node",
  parentEnv: {
    PATH: "/usr/local/bin:/usr/bin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TERM: "xterm-256color",
    AWS_SECRET_ACCESS_KEY: "sekret",
    NEMA_RUN_TOKEN: "leak",
  },
});

describe("Claude Code launch", () => {
  test("CLAUDE_ROOM_TOOLS is exactly the Room functions codex-direct declares", () => {
    expect([...CLAUDE_ROOM_TOOLS]).toEqual(ROOM_TOOLS.map((tool) => `mcp__room__${tool.name}`));
    expect(CLAUDE_ROOM_TOOLS).toContain("mcp__room__offer_skill_install");
  });

  test("CLAUDE_ROOM_TOOLS contains mcp__room__open_thread", () => {
    expect(CLAUDE_ROOM_TOOLS).toContain("mcp__room__open_thread");
  });

  test("uses the explicit packaged CLI entry and executable in MCP argv", () => {
    const launch = prepareClaudeLaunch(options());
    const config = JSON.parse(readFileSync(launch.mcpPath, "utf8"));
    expect(config.mcpServers.room).toMatchObject({
      command: "/usr/local/bin/node",
      args: ["/opt/nema/dist/index.js", "mcp"],
    });
  });

  test("withSkillArgs swaps sources, tools and approvals once each, then adds dirs and settings", () => {
    const launch = prepareClaudeLaunch(options("sonnet"));
    const before = [...launch.args];
    const args = withSkillArgs(launch.args, { settingsPath: "/run/claude-settings.json", addDirs: ["/run/repo-skills/web-abc123", "/run/repo-skills/api-def456"] });
    expect(launch.args).toEqual(before);
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args.filter((a) => a === "--setting-sources")).toHaveLength(1);
    expect(args.filter((a) => a === "--tools")).toHaveLength(1);
    expect(value("--setting-sources")).toBe("project");
    expect(value("--tools")).toBe("Skill,Read");
    expect(value("--allowedTools")).toBe([...CLAUDE_ROOM_TOOLS, "Skill", "Read(/.claude/skills/**)"].join(","));
    expect(value("--disallowedTools")).toBe("AskUserQuestion");
    expect(args.slice(before.length)).toEqual([
      "--add-dir", "/run/repo-skills/web-abc123",
      "--add-dir", "/run/repo-skills/api-def456",
      "--settings", "/run/claude-settings.json",
    ]);
    const unchanged = (list: string[]) => list.filter((_, i) => !["--setting-sources", "--tools", "--allowedTools"].includes(list[i - 1] ?? ""));
    expect(unchanged(args.slice(0, before.length))).toEqual(unchanged(before));
  });

  test("maxTurns replaces the default --max-turns", () => {
    const launch = prepareClaudeLaunch({ ...options(), maxTurns: 48 });
    expect(launch.args[launch.args.indexOf("--max-turns") + 1]).toBe("48");
  });

  test("prepares isolated directories, arguments, environment, and MCP config", () => {
    const launch = prepareClaudeLaunch(options());
    const configDir = join(launch.runDir, "claude-config");
    const workDir = join(launch.runDir, "work");

    expect(launch.runDir).toBe(join(nemaHome, "run", "task-123"));
    expect(launch.mcpPath).toBe(join(launch.runDir, "mcp.json"));
    // On Windows the launch redirects the profile, so APPDATA/LOCALAPPDATA live under the config dir.
    expect(readdirSync(configDir)).toEqual(process.platform === "win32" ? ["AppData"] : []);
    expect(readdirSync(workDir)).toEqual([]);
    // Windows reports synthetic modes and prepareClaudeLaunch sets no DACL there, so this proves only the POSIX modes.
    if (process.platform !== "win32") {
      expect(lstatSync(configDir).mode & 0o777).toBe(0o700);
      expect(lstatSync(launch.mcpPath).mode & 0o777).toBe(0o600);
    }

    expect(launch.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--mcp-config",
      launch.mcpPath,
      "--setting-sources",
      "",
      "--tools",
      "",
      "--allowedTools",
      CLAUDE_ROOM_TOOLS.join(","),
      "--disallowedTools",
      "AskUserQuestion",
      "--max-turns",
      "24",
    ]);
    for (const arg of ["--permission-mode", "--dangerously-skip-permissions", "--resume", "--effort", "--append-system-prompt"]) {
      expect(launch.args).not.toContain(arg);
    }

    expect(launch.env).toEqual({
      PATH: options().parentEnv.PATH,
      LANG: options().parentEnv.LANG,
      LC_ALL: options().parentEnv.LC_ALL,
      TERM: options().parentEnv.TERM,
      CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
      HOME: configDir,
      CLAUDE_CONFIG_DIR: configDir,
      TMPDIR: tmpdir(),
      ...(process.platform === "win32" && {
        USERPROFILE: configDir,
        APPDATA: join(configDir, "AppData", "Roaming"),
        LOCALAPPDATA: join(configDir, "AppData", "Local"),
      }),
    });
    expect(launch.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(launch.env).not.toHaveProperty("NEMA_RUN_TOKEN");

    expect(JSON.parse(readFileSync(launch.mcpPath, "utf8"))).toEqual({
      mcpServers: {
        room: {
          command: "/usr/local/bin/node",
          args: ["/opt/nema/dist/index.js", "mcp"],
          env: {
            NEMA_HUB_URL: "http://127.0.0.1:4010",
            NEMA_RUN_TOKEN: "task-run-token",
          },
        },
      },
    });
  });

  test("--allowedTools includes mcp__room__code__read when given", () => {
    const launch = prepareClaudeLaunch({
      ...options(),
      pluginTools: [{ name: "code__read", description: "Read a file", parameters: { type: "object" } }],
    });
    const allowed = launch.args[launch.args.indexOf("--allowedTools") + 1];
    expect(allowed).toBe([...CLAUDE_ROOM_TOOLS, "mcp__room__code__read"].join(","));
    expect(launch.args[launch.args.indexOf("--tools") + 1]).toBe("");
    expect(launch.args.filter((arg) => arg === "--mcp-config")).toHaveLength(1);
  });

  test("adds the model argument only when configured", () => {
    expect(prepareClaudeLaunch(options()).args).not.toContain("--model");
    expect(prepareClaudeLaunch(options("sonnet")).args).toEqual(expect.arrayContaining(["--model", "sonnet"]));
  });

  test("rejects task ids that escape the run directory", () => {
    mkdirSync(nemaHome, { recursive: true });
    const sentinel = join(nemaHome, "sentinel");
    writeFileSync(sentinel, "keep");
    for (const taskId of ["..", "../x"]) {
      expect(() => prepareClaudeLaunch({ ...options(), taskId })).toThrow(/unsafe task id/);
      expect(readFileSync(sentinel, "utf8")).toBe("keep");
    }
  });
});
