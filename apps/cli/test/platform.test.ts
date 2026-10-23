import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { browserCommand, commandSpec } from "../src/platform.js";
import { hookCommand, installReport, reportHookInstalled, uninstallReport } from "../src/report/install.js";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("browser URLs remain one literal argument on every OS", () => {
  const url = "https://example.test/login?state=a&nonce=b%20c";
  expect(browserCommand(url, "win32")).toEqual({ bin: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] });
  expect(browserCommand(url, "darwin")).toEqual({ bin: "open", args: [url] });
  expect(browserCommand(url, "linux")).toEqual({ bin: "xdg-open", args: [url] });
});

test.runIf(process.platform === "win32")("npm command shims launch JS directly, preserving shell metacharacters", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nema shim space-")); roots.push(dir);
  mkdirSync(path.join(dir, "node_modules", "fake"), { recursive: true });
  const entry = path.join(dir, "node_modules", "fake", "cli.js");
  writeFileSync(entry, "console.log(JSON.stringify(process.argv.slice(2)))");
  writeFileSync(path.join(dir, "fake.cmd"), '@echo off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\fake\\cli.js" %*\r\n');
  const args = ['a & echo UNEXPECTED', 'x%PATH%', 'space " quote', '日本語'];
  const command = commandSpec("fake", args, { Path: dir });
  expect(command.bin).toBe(process.execPath);
  expect(command.args[0]).toBe(entry);
  const result = spawnSync(command.bin, command.args, { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(args);
});

test.runIf(process.platform === "win32")("PATH-resolved extensionless Node launchers run directly, preserving literal arguments", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nema path launcher space-")); roots.push(dir);
  const launcher = path.join(dir, "fake-launcher");
  writeFileSync(launcher, `#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n`);
  const args = ['a & echo UNEXPECTED', 'x%PATH%', 'space " quote', '日本語'];
  const command = commandSpec("fake-launcher", args, { Path: dir });
  expect(command.bin).toBe(process.execPath);
  expect(command.args[0]).toBe(launcher);
  const result = spawnSync(command.bin, command.args, { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(args);
});

test("Windows hook arguments are encoded as literal PowerShell strings", () => {
  const command = hookCommand("C:\\Program Files\\node.exe", "C:\\O'Brien & 100%\\nema\\index.js", "codex", "win32");
  const script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
  expect(script).toBe("& 'C:\\Program Files\\node.exe' 'C:\\O''Brien & 100%\\nema\\index.js' report hook --agent codex; exit $LASTEXITCODE");
});

test("installing and removing native hooks preserves other hooks", () => {
  const home = mkdtempSync(path.join(tmpdir(), "nema hook lifecycle-")); roots.push(home);
  const settings = path.join(home, ".claude", "settings.json");
  mkdirSync(path.dirname(settings), { recursive: true });
  const original = { hooks: { Stop: [{ hooks: [{ type: "command", command: "existing-user-hook" }] }] }, other: "preserve" };
  writeFileSync(settings, JSON.stringify(original));
  const out = { log: () => {}, error: (message: string) => { throw new Error(message); } };
  const options = { home, nemaHome: path.join(home, ".nema"), agent: "claude" as const, out, nodeBin: process.execPath, cliEntry: path.join(home, "index.js") };
  expect(installReport(options)).toBe(0);
  expect(reportHookInstalled("claude", home)).toBe(true);
  expect(installReport(options)).toBe(0);
  expect(uninstallReport(options)).toBe(0);
  expect(reportHookInstalled("claude", home)).toBe(false);
  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(original);
});

test.runIf(process.platform === "win32")("Windows hook executes from a path with spaces, quotes, ampersands and percent signs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nema O'Brien & 100%-日本語-")); roots.push(dir);
  const entry = path.join(dir, "hook.js"); const output = path.join(dir, "args.json");
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)))`);
  const command = hookCommand(process.execPath, entry, "codex", "win32");
  const encoded = command.split(" ").at(-1)!;
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(["report", "hook", "--agent", "codex"]);
});
