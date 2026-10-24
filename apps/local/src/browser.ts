import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ensureLocalRuntime, shutdownLocalRuntime } from "./runtime.js";
import { defaultHome } from "./paths.js";
import { discoverInstance } from "./instance.js";

const ticketPattern = /^[0-9a-f]{64}$/;

export function validateLaunchUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !/^[1-9]\d{0,4}$/.test(url.port) || Number(url.port) > 65535 ||
      url.pathname !== "/_nema/launch" || url.username || url.password || url.hash || [...url.searchParams.keys()].join(",") !== "ticket" ||
      !ticketPattern.test(url.searchParams.get("ticket") ?? "")) throw new Error("invalid");
    return true;
  } catch {
    throw new Error("Managed runtime did not return a verified loopback launch URL");
  }
}

export function parseBrowserArgs(args: string[]): { assetsDir: string; noOpen: boolean; quit: boolean } {
  let assetsDir: string | undefined;
  let noOpen = false;
  let quit = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--assetsDir" && args[index + 1] && !assetsDir) assetsDir = args[++index];
    else if (arg === "--no-open" && !noOpen) noOpen = true;
    else if (arg === "--quit" && !quit) quit = true;
    else throw new Error("Usage: browser --assetsDir <installation-directory> [--no-open | --quit]");
  }
  if (!assetsDir || (noOpen && quit)) throw new Error("Usage: browser --assetsDir <installation-directory> [--no-open | --quit]");
  return { assetsDir, noOpen, quit };
}

function browserCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    const command = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\cmd.exe`;
    return { command, args: ["/d", "/s", "/c", `start "" "${url}"`] };
  }
  if (process.platform === "darwin") return { command: "/usr/bin/open", args: [url] };
  if (process.platform === "linux") return { command: "/usr/bin/xdg-open", args: [url] };
  throw new Error(`Browser mode is unsupported on ${process.platform}`);
}

export async function runBrowserLauncher(args: string[]): Promise<string> {
  const { assetsDir, noOpen, quit } = parseBrowserArgs(args);
  const home = defaultHome();
  if (quit) {
    const instance = await discoverInstance(home);
    if (!instance) throw new Error("No authenticated Nema core is running for this home");
    await shutdownLocalRuntime({ home, assetsDir, expectedInstanceId: instance.instanceId });
    process.stdout.write("Nema local core stopped\n");
    return "";
  }
  const runtime = await ensureLocalRuntime({ home, assetsDir });
  validateLaunchUrl(runtime.launchUrl);
  if (noOpen) {
    process.stdout.write(`${runtime.launchUrl}\n`);
    return runtime.launchUrl;
  }
  const { command, args: openerArgs } = browserCommand(runtime.launchUrl);
  await new Promise<void>((resolve, reject) => {
    const opener = spawn(command, openerArgs, { stdio: "ignore", windowsHide: true });
    opener.once("error", reject);
    opener.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`System browser opener exited with status ${code}`)));
  });
  return runtime.launchUrl;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(entry).href === import.meta.url);
}

if (isDirectExecution()) {
  runBrowserLauncher(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
