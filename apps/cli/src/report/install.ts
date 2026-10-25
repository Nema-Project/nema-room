// `nema report install` / `uninstall`: the report hook and the nema-report skill for Claude Code and Codex.
// Both agents read `{ hooks: { <Event>: [{ matcher?, hooks: [{ type: "command", command }] }] } }`:
// Claude Code from ~/.claude/settings.json, Codex (0.163+) from ~/.codex/hooks.json. Both fire Stop and SessionEnd.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Out } from "../direct/authCommands.js";
import { ensureReportToken, reportTokenPath } from "./token.js";

export type ReportAgent = "claude" | "codex";
export const REPORT_AGENTS: readonly ReportAgent[] = ["claude", "codex"];

const EVENTS = ["Stop", "SessionEnd"] as const;
/** Every hook command Nema writes contains this; nothing else in a settings file is ever touched. */
const MARKER = " report hook --agent ";
const SKILL_NAME = "nema-report";

type Json = Record<string, unknown>;
type Paths = { settings: string; skillDir: string };

function agentPaths(agent: ReportAgent, home: string): Paths {
  return agent === "claude"
    ? { settings: path.join(home, ".claude", "settings.json"), skillDir: path.join(home, ".claude", "skills", SKILL_NAME) }
    : { settings: path.join(home, ".codex", "hooks.json"), skillDir: path.join(home, ".agents", "skills", SKILL_NAME) };
}

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isNema = (h: unknown): boolean => {
  if (!isObj(h) || typeof h.command !== "string") return false;
  if (h.command.includes(MARKER)) return true;
  const encoded = /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(h.command);
  return encoded !== null && Buffer.from(encoded[1]!, "base64").toString("utf16le").includes(MARKER);
};

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_\/.,:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function hookCommand(nodeBin: string, cliEntry: string, agent: ReportAgent, platform = process.platform): string {
  if (platform === "win32") {
    const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const script = `& ${psQuote(nodeBin)} ${psQuote(cliEntry)} report hook --agent ${agent}; exit $LASTEXITCODE`;
    return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  return `${shellQuote(nodeBin)} ${shellQuote(cliEntry)} report hook --agent ${agent}`;
}

type Loaded = { data: Json; indent: string; newline: boolean; existed: boolean };

/** null means the file exists but is not a JSON object with an object `hooks` (or none). */
function load(file: string): Loaded | null {
  if (!existsSync(file)) return { data: {}, indent: "  ", newline: true, existed: false };
  const raw = readFileSync(file, "utf8");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(data) || (data.hooks !== undefined && !isObj(data.hooks))) return null;
  if (isObj(data.hooks) && Object.values(data.hooks).some((v) => !Array.isArray(v))) return null;
  const indent = /\n([ \t]+)\S/.exec(raw)?.[1] ?? "  ";
  return { data, indent, newline: raw.endsWith("\n"), existed: true };
}

/** Atomic write next to the real file (a symlinked settings file stays a symlink), keeping its mode. */
function save(file: string, l: Loaded): void {
  const target = l.existed ? realpathSync(file) : file;
  mkdirSync(path.dirname(target), { recursive: true });
  const mode = l.existed ? statSync(target).mode & 0o777 : 0o644;
  const tmp = `${target}.${process.pid}.nema.tmp`;
  writeFileSync(tmp, `${JSON.stringify(l.data, null, l.indent)}${l.newline ? "\n" : ""}`, { mode });
  renameSync(tmp, target);
}

/** Replaces the first Nema hook in the event in place, drops any other Nema hooks, else appends a new group. */
function putHook(hooks: Json, event: string, command: string): void {
  const groups = (hooks[event] ??= []) as unknown[];
  let placed = false;
  const kept: unknown[] = [];
  for (const g of groups) {
    if (!isObj(g) || !Array.isArray(g.hooks) || !g.hooks.some(isNema)) {
      kept.push(g);
      continue;
    }
    const inner: unknown[] = [];
    for (const h of g.hooks) {
      if (!isNema(h)) inner.push(h);
      else if (!placed) {
        placed = true;
        inner.push({ ...(h as Json), type: "command", command });
      }
    }
    if (inner.length > 0) kept.push({ ...g, hooks: inner });
  }
  if (!placed) kept.push({ hooks: [{ type: "command", command }] });
  hooks[event] = kept;
}

/** Removes every Nema hook; groups, events and `hooks` emptied by that removal go too. Returns whether anything changed. */
function stripHooks(data: Json): boolean {
  if (!isObj(data.hooks)) return false;
  const hooks = data.hooks;
  let changed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    let touched = false;
    const kept: unknown[] = [];
    for (const g of groups) {
      if (!isObj(g) || !Array.isArray(g.hooks) || !g.hooks.some(isNema)) {
        kept.push(g);
        continue;
      }
      touched = true;
      const inner = g.hooks.filter((h) => !isNema(h));
      if (inner.length > 0) kept.push({ ...g, hooks: inner });
    }
    if (!touched) continue;
    changed = true;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (changed && Object.keys(hooks).length === 0) delete data.hooks;
  return changed;
}

const skillSource = (): string => readFileSync(new URL("../../src/report/SKILL.md", import.meta.url), "utf8");

export type InstallRun = {
  agent: ReportAgent;
  home: string;
  nemaHome: string;
  out: Out;
  nodeBin: string;
  cliEntry: string;
};

export function installReport(o: InstallRun): number {
  const p = agentPaths(o.agent, o.home);
  const loaded = load(p.settings);
  if (!loaded) {
    o.out.error(`无法解析 ${p.settings}，未修改`);
    return 1;
  }
  try {
    ensureReportToken(o.nemaHome);
  } catch (e) {
    o.out.error(e instanceof Error ? e.message : String(e));
    return 1;
  }
  mkdirSync(p.skillDir, { recursive: true });
  const skillFile = path.join(p.skillDir, "SKILL.md");
  writeFileSync(skillFile, skillSource());
  o.out.log(`已写入技能：${skillFile}`);

  const before = JSON.stringify(loaded.data);
  const hooks = ((loaded.data.hooks as Json | undefined) ??= {});
  const command = hookCommand(o.nodeBin, o.cliEntry, o.agent);
  for (const ev of EVENTS) putHook(hooks, ev, command);
  if (JSON.stringify(loaded.data) === before) {
    o.out.log(`${p.settings} 里的 ${EVENTS.join("、")} 钩子已是最新`);
  } else {
    save(p.settings, loaded);
    o.out.log(`已在 ${p.settings} 写入 ${EVENTS.join("、")} 钩子`);
  }
  o.out.log(`上报令牌已就绪：${reportTokenPath(o.nemaHome)}`);
  o.out.log("请重启 nema daemon，让它登记上报令牌");
  return 0;
}

export type UninstallRun = { agent: ReportAgent; home: string; out: Out };

/** Removes exactly Nema's hook entries and the nema-report skill dir. The report token stays. */
export function uninstallReport(o: UninstallRun): number {
  const p = agentPaths(o.agent, o.home);
  const loaded = load(p.settings);
  if (!loaded) {
    o.out.error(`无法解析 ${p.settings}，未修改`);
    return 1;
  }
  if (loaded.existed && stripHooks(loaded.data)) {
    save(p.settings, loaded);
    o.out.log(`已从 ${p.settings} 移除 Nema 的钩子`);
  } else {
    o.out.log(`${p.settings} 里没有 Nema 的钩子`);
  }
  if (existsSync(p.skillDir)) {
    rmSync(p.skillDir, { recursive: true, force: true });
    o.out.log(`已删除技能：${p.skillDir}`);
  }
  return 0;
}

/** For `nema doctor`: whether the agent's settings carry a Nema Stop or SessionEnd hook. Never throws. */
export function reportHookInstalled(agent: ReportAgent, home: string): boolean {
  try {
    const loaded = load(agentPaths(agent, home).settings);
    if (!loaded || !isObj(loaded.data.hooks)) return false;
    const hooks = loaded.data.hooks;
    return EVENTS.some((ev) => (hooks[ev] as unknown[] | undefined)?.some((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some(isNema)));
  } catch {
    return false;
  }
}
