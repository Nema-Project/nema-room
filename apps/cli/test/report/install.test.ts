import { expectPrivate } from "../nativePermissions.js";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { hookCommand, installReport, reportHookInstalled, uninstallReport, type ReportAgent } from "../../src/report/install.js";
import { reportTokenPath } from "../../src/report/token.js";
import { collectOut, tmp } from "./helpers.js";

const NODE = "/opt/node/bin/node";
const ENTRY = "/opt/nema/apps/cli/dist/index.js";

function setup() {
  const home = tmp("nema-install-home-");
  const nemaHome = path.join(home, ".nema");
  const o = collectOut();
  const run = (agent: ReportAgent) => installReport({ agent, home, nemaHome, out: o.out, nodeBin: NODE, cliEntry: ENTRY });
  const undo = (agent: ReportAgent) => uninstallReport({ agent, home, out: o.out });
  return { home, nemaHome, run, undo, ...o };
}

const claudeSettings = (home: string) => path.join(home, ".claude", "settings.json");
const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>> };

const ORCA = {
  model: "opus",
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "/bin/sh ~/.orca/agent-hooks/claude-hook.sh", timeout: 10 }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "orca-pre" }] }],
  },
  permissions: { allow: ["Bash(ls:*)"] },
};

describe("nema report install", () => {
  test("install adds Stop and SessionEnd hooks with an absolute command and writes the skill", async () => {
    const s = setup();
    expect(await s.run("claude")).toBe(0);
    const cfg = read(claudeSettings(s.home));
    for (const ev of ["Stop", "SessionEnd"]) {
      const cmds = cfg.hooks[ev]!.flatMap((g) => g.hooks.map((h) => h.command));
      expect(cmds).toEqual([hookCommand(NODE, ENTRY, "claude")]);
      expect(cfg.hooks[ev]![0]!.hooks[0]!.type).toBe("command");
    }
    const skill = readFileSync(path.join(s.home, ".claude", "skills", "nema-report", "SKILL.md"), "utf8");
    expect(skill).toContain("nema report");
    expect(skill).toContain("R-7");
    expectPrivate(reportTokenPath(s.nemaHome), 0o600);
    expect(s.logs.join("\n")).toContain("重启");
    expect(s.logs.join("\n")).not.toContain(readFileSync(reportTokenPath(s.nemaHome), "utf8"));
  });

  test("codex: hooks go to ~/.codex/hooks.json and the skill to ~/.agents/skills", async () => {
    const s = setup();
    expect(await s.run("codex")).toBe(0);
    const cfg = read(path.join(s.home, ".codex", "hooks.json"));
    expect(cfg.hooks.Stop![0]!.hooks[0]!.command).toBe(hookCommand(NODE, ENTRY, "codex"));
    expect(cfg.hooks.SessionEnd![0]!.hooks[0]!.command).toBe(hookCommand(NODE, ENTRY, "codex"));
    expect(existsSync(path.join(s.home, ".agents", "skills", "nema-report", "SKILL.md"))).toBe(true);
  });

  test("install keeps an existing Orca hook and key order byte-identical except the added entries", async () => {
    const s = setup();
    mkdirSync(path.join(s.home, ".claude"));
    const original = `${JSON.stringify(ORCA, null, 2)}\n`;
    writeFileSync(claudeSettings(s.home), original);
    expect(await s.run("claude")).toBe(0);
    const after = readFileSync(claudeSettings(s.home), "utf8");
    const cfg = JSON.parse(after) as typeof ORCA & { hooks: Record<string, unknown[]> };
    expect(Object.keys(cfg)).toEqual(["model", "hooks", "permissions"]);
    expect(Object.keys(cfg.hooks)).toEqual(["Stop", "PreToolUse", "SessionEnd"]);
    expect(cfg.hooks.Stop[0]).toEqual(ORCA.hooks.Stop[0]);
    expect(cfg.hooks.Stop).toHaveLength(2);
    // Taking Nema's entries back out gives the original bytes.
    expect(await s.undo("claude")).toBe(0);
    expect(readFileSync(claudeSettings(s.home), "utf8")).toBe(original);
  });

  test("install twice does not duplicate entries", async () => {
    const s = setup();
    await s.run("claude");
    const once = readFileSync(claudeSettings(s.home), "utf8");
    expect(await s.run("claude")).toBe(0);
    expect(readFileSync(claudeSettings(s.home), "utf8")).toBe(once);
    expect(read(claudeSettings(s.home)).hooks.Stop).toHaveLength(1);
  });

  test("uninstall removes only Nema's entries and the skill", async () => {
    const s = setup();
    mkdirSync(path.join(s.home, ".claude"));
    writeFileSync(claudeSettings(s.home), JSON.stringify(ORCA, null, 2));
    await s.run("claude");
    expect(await s.undo("claude")).toBe(0);
    expect(JSON.parse(readFileSync(claudeSettings(s.home), "utf8"))).toEqual(ORCA);
    expect(existsSync(path.join(s.home, ".claude", "skills", "nema-report"))).toBe(false);
    expect(existsSync(reportTokenPath(s.nemaHome))).toBe(true);
    expect(reportHookInstalled("claude", s.home)).toBe(false);
  });

  test("install refuses a settings file that is not JSON and leaves it unchanged", async () => {
    const s = setup();
    mkdirSync(path.join(s.home, ".claude"));
    writeFileSync(claudeSettings(s.home), "{ not json");
    expect(await s.run("claude")).toBe(1);
    expect(readFileSync(claudeSettings(s.home), "utf8")).toBe("{ not json");
    expect(s.errors).toEqual([`无法解析 ${claudeSettings(s.home)}，未修改`]);
    expect(existsSync(path.join(s.home, ".claude", "skills", "nema-report"))).toBe(false);
  });

  test("reportHookInstalled sees the hook after install", async () => {
    const s = setup();
    expect(reportHookInstalled("claude", s.home)).toBe(false);
    await s.run("claude");
    expect(reportHookInstalled("claude", s.home)).toBe(true);
    expect(reportHookInstalled("codex", s.home)).toBe(false);
  });

  test("paths with spaces are quoted in the hook command", async () => {
    const s = setup();
    await installReport({ agent: "claude", home: s.home, nemaHome: s.nemaHome, out: s.out, nodeBin: "/opt/my node/node", cliEntry: ENTRY });
    const command = read(claudeSettings(s.home)).hooks.Stop![0]!.hooks[0]!.command as string;
    if (process.platform === "win32") {
      // Windows hooks are an encoded PowerShell script; the quoting lives inside it.
      const encoded = /-EncodedCommand (\S+)$/.exec(command)![1]!;
      expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(`& '/opt/my node/node' '${ENTRY}' report hook --agent claude; exit $LASTEXITCODE`);
    } else expect(command).toBe(`'/opt/my node/node' ${ENTRY} report hook --agent claude`);
  });
});
