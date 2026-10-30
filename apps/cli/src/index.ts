#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { authClaude } from "./claude/token.js";
import { startDaemon } from "./daemon/setup.js";
import { stopOnSignals } from "./daemon/signals.js";
import { startMcpServer } from "./mcp/server.js";
import { configErrorMessage, DEFAULT_CONFIG, loadConfig, type NemaConfig } from "./config.js";
import { configGet, configSet } from "./configCommands.js";
import { defaultTokenFile, runDoctor } from "./doctor.js";
import { authByok, authLogin, authLogout, authProbe, authStatus, consoleOut } from "./direct/authCommands.js";
import { defaultCodexHome } from "./direct/codexLogin.js";
import { cliVersion } from "./direct/siwc.js";
import { resolveHubTarget, runReport, runReportHook, type ReportFlags } from "./report/commands.js";
import { runWpGet, runWpList } from "./wp/commands.js";
import { authGithub } from "./secrets/github.js";
import { defaultDesktopHome } from "./report/desktop.js";
import { registerMcpCommands } from "./extensions/mcpCommands.js";
import { installReport, REPORT_AGENTS, uninstallReport, type ReportAgent } from "./report/install.js";

const nemaHomeDir = () => path.join(os.homedir(), ".nema");

const program = new Command().name("nema").version(cliVersion()).enablePositionalOptions();

program
  .command("daemon")
  .description("Connect to the hub and run agent tasks")
  .option("--hub <url>", "hub URL", "http://127.0.0.1:4400")
  .option("--token-file <path>", "daemon token file", defaultTokenFile())
  .action(async (o: { hub: string; tokenFile: string }) => {
    const token = (await readFile(o.tokenFile, "utf8")).trim();
    const nemaHome = path.join(os.homedir(), ".nema");
    const daemon = startDaemon({
      hubUrl: o.hub,
      token,
      nemaHome,
      userCodexHome: defaultCodexHome(),
      version: cliVersion(),
      cliEntry: realpathSync(process.argv[1] ?? fileURLToPath(import.meta.url)),
    });
    // Ctrl-C, SIGTERM or SIGHUP close the daemon first, so its MCP servers do not outlive it.
    stopOnSignals({ close: () => daemon.close() });
    console.log(`nema daemon connecting to ${o.hub}`);
  });

const mcpCommand = program
  .command("mcp")
  .description("Run the stdio Room MCP server (used by Codex; reads NEMA_HUB_URL / NEMA_RUN_TOKEN), or manage MCP servers with its subcommands")
  .action(async () => {
    const hubUrl = process.env.NEMA_HUB_URL;
    const runToken = process.env.NEMA_RUN_TOKEN;
    if (!hubUrl || !runToken) {
      console.error("NEMA_HUB_URL and NEMA_RUN_TOKEN must be set");
      process.exit(1);
    }
    await startMcpServer({ hubUrl, runToken });
  });

registerMcpCommands(mcpCommand, { nemaHome: nemaHomeDir(), desktopHome: defaultDesktopHome(), hubUrl: (flag) => resolveHubTarget(flag), out: consoleOut, stdin: () => process.stdin });

program
  .command("doctor")
  .description("Check git, graphify, direct-mode login or BYOK key and model, Codex CLI and its login, the Claude Code binary and token file, the hub, the daemon token, github-mcp-server and the GitHub token")
  .option("--hub <url>", "hub URL", "http://127.0.0.1:4400")
  .option("--token-file <path>", "daemon token file", defaultTokenFile())
  .option("--codex-bin <path>", "codex binary", process.env.NEMA_CODEX_BIN ?? "codex")
  .action(async (o: { hub: string; tokenFile: string; codexBin: string }) => {
    let adapter: NemaConfig["adapter"] = DEFAULT_CONFIG.adapter;
    let authMode: NemaConfig["authMode"] = DEFAULT_CONFIG.authMode;
    let model: NemaConfig["model"] = DEFAULT_CONFIG.model;
    let configError: string | undefined;
    try {
      ({ adapter, authMode, model } = loadConfig(nemaHomeDir()));
    } catch (e) {
      configError = configErrorMessage(e);
    }
    const results = await runDoctor({
      codexBin: o.codexBin,
      userCodexHome: defaultCodexHome(),
      hubUrl: o.hub,
      tokenFile: o.tokenFile,
      nemaHome: nemaHomeDir(),
      adapter,
      authMode,
      model,
    });
    if (configError !== undefined) results.unshift({ name: "配置文件", ok: false, detail: configError });
    for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}：${r.detail}`);
    if (results.some((r) => !r.ok)) process.exit(1);
  });

const auth = program.command("auth").description("Direct-mode login: Sign in with ChatGPT, or (authMode=compat) the existing Codex login file");

auth
  .command("login")
  .description("SIWC browser login, or confirm the Codex login file when authMode=compat")
  .option("--port <port>", "loopback callback port (default 1455)", (v) => Number.parseInt(v, 10))
  .action(async (o: { port?: number }) => {
    process.exitCode = await authLogin({ nemaHome: nemaHomeDir(), out: consoleOut, port: o.port, codexHome: defaultCodexHome() });
  });

auth
  .command("byok")
  .description("Read a BYOK API key from standard input")
  .action(async () => {
    process.exitCode = await authByok({ nemaHome: nemaHomeDir(), out: consoleOut, stdin: process.stdin });
  });

auth
  .command("claude")
  .description("Read a Claude Code setup token from standard input")
  .action(async () => {
    process.exitCode = await authClaude({ nemaHome: nemaHomeDir(), out: consoleOut, stdin: process.stdin });
  });

auth
  .command("github")
  .description("Read a GitHub personal access token from standard input (for the read-only GitHub plugin)")
  .action(async () => {
    process.exitCode = await authGithub({ nemaHome: nemaHomeDir(), out: consoleOut, stdin: process.stdin });
  });

auth
  .command("status")
  .description("Show the login mode, account, expiry and last auth error (never prints tokens)")
  .action(() => {
    process.exitCode = authStatus({ nemaHome: nemaHomeDir(), out: consoleOut, codexHome: defaultCodexHome() });
  });

auth
  .command("logout")
  .description("Delete Nema's direct-mode credentials")
  .action(async () => {
    process.exitCode = await authLogout({ nemaHome: nemaHomeDir(), out: consoleOut });
  });

auth
  .command("probe")
  .description("List models and make one minimal Responses call (\"只回复 ok\")")
  .option("--force-refresh", "refresh the access token first (debugging)")
  .action(async (o: { forceRefresh?: boolean }) => {
    process.exitCode = await authProbe({ nemaHome: nemaHomeDir(), out: consoleOut, forceRefresh: !!o.forceRefresh, codexHome: defaultCodexHome() });
  });

const config = program.command("config").description("Show or change Nema's local settings (~/.nema/config.json)");

config
  .command("get [key]")
  .description("Print one setting, or all of them (adapter, model, reasoningEffort, authMode)")
  .action((key: string | undefined) => {
    process.exitCode = configGet({ nemaHome: nemaHomeDir(), out: consoleOut, key });
  });

config
  .command("set <key> <value>")
  .description("Set adapter (codex-direct | claude-code), model, reasoningEffort (low|medium|high), authMode (siwc|compat|byok) or byokBaseUrl")
  .action((key: string, value: string) => {
    process.exitCode = configSet({ nemaHome: nemaHomeDir(), out: consoleOut, key, value });
  });

const report = program
  .command("report")
  .description("Report finished work to Nema (summary, commits, entry ids, files); run inside the repo")
  .enablePositionalOptions()
  .option("--summary <text>", "one-line summary of the finished work")
  .option("--commits <shas>", "comma-separated commit shas")
  .option("--entries <ids>", "comma-separated entry ids, e.g. R-7,D-12")
  .option("--files <paths>", "comma-separated files that were changed")
  .option("--task <n>", "the work package task number this report finishes (use with --entries W-n)")
  .option("--progress <state>", "in_progress for unfinished work (commits optional), or completed (the default)")
  .option("--agent <name>", "coding agent name")
  .option("--json", "read the fields as a JSON object from standard input")
  .option("--hub <url>", "hub URL (default: NEMA_HUB_URL, else a running Nema desktop app, else http://127.0.0.1:4400)")
  .action(async (o: ReportFlags & { hub?: string }) => {
    const { hub, ...flags } = o;
    process.exitCode = await runReport({ nemaHome: nemaHomeDir(), hubUrl: await resolveHubTarget(hub), cwd: process.cwd(), out: consoleOut, flags, stdin: process.stdin });
  });

report
  .command("hook")
  .description("Called by a coding agent's hook: sends only agent, cwd, git common dir, branch, HEAD, time and session id")
  .requiredOption("--agent <name>", "coding agent name")
  .option("--hub <url>", "hub URL (default: NEMA_HUB_URL, else a running Nema desktop app, else http://127.0.0.1:4400)")
  .action(async (o: { agent: string; hub?: string }) => {
    process.exitCode = await runReportHook({ agent: o.agent, nemaHome: nemaHomeDir(), hubUrl: await resolveHubTarget(o.hub), stdin: process.stdin.isTTY ? null : process.stdin });
  });

function reportAgent(v: string): ReportAgent {
  if (!(REPORT_AGENTS as readonly string[]).includes(v)) throw new InvalidArgumentError(`--agent 只能是 ${REPORT_AGENTS.join(" 或 ")}`);
  return v as ReportAgent;
}

report
  .command("install")
  .description("Install the report hook (Stop, SessionEnd) and the nema-report skill for a coding agent")
  .requiredOption("--agent <name>", "claude or codex", reportAgent)
  .option("--home <dir>", "home dir holding the agent's settings (default: your home dir)")
  .action((o: { agent: ReportAgent; home?: string }) => {
    process.exitCode = installReport({
      agent: o.agent,
      home: o.home ?? os.homedir(),
      nemaHome: nemaHomeDir(),
      out: consoleOut,
      nodeBin: process.execPath,
      cliEntry: realpathSync(process.argv[1] ?? fileURLToPath(import.meta.url)),
    });
  });

report
  .command("uninstall")
  .description("Remove Nema's report hook entries and the nema-report skill; the report token stays")
  .requiredOption("--agent <name>", "claude or codex", reportAgent)
  .option("--home <dir>", "home dir holding the agent's settings (default: your home dir)")
  .action((o: { agent: ReportAgent; home?: string }) => {
    process.exitCode = uninstallReport({ agent: o.agent, home: o.home ?? os.homedir(), out: consoleOut });
  });

const wp = program.command("wp").description("Work packages: list the approved ones for this repo, or fetch one for a coding agent");

wp
  .command("list")
  .description("List the approved work packages that cover the current repo")
  .option("--hub <url>", "hub URL (default: NEMA_HUB_URL, else a running Nema desktop app, else http://127.0.0.1:4400)")
  .action(async (o: { hub?: string }) => {
    process.exitCode = await runWpList({ nemaHome: nemaHomeDir(), hubUrl: await resolveHubTarget(o.hub), cwd: process.cwd(), out: consoleOut });
  });

wp
  .command("get <id>")
  .description("Write an approved work package's spec and plan to .nema/<W-n>/ (or print them with --stdout)")
  .option("--dir <dir>", "directory to write .nema/<W-n>/ under (default: the current directory)")
  .option("--stdout", "print the spec and plan instead of writing files")
  .option("--force", "overwrite files that exist with different content")
  .option("--hub <url>", "hub URL (default: NEMA_HUB_URL, else a running Nema desktop app, else http://127.0.0.1:4400)")
  .action(async (id: string, o: { dir?: string; stdout?: boolean; force?: boolean; hub?: string }) => {
    process.exitCode = await runWpGet({
      nemaHome: nemaHomeDir(),
      hubUrl: await resolveHubTarget(o.hub),
      cwd: process.cwd(),
      out: consoleOut,
      id,
      ...(o.dir !== undefined ? { dir: o.dir } : {}),
      stdout: !!o.stdout,
      force: !!o.force,
    });
  });

await program.parseAsync(process.argv);
