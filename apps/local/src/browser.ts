import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ensureLocalRuntime } from "./runtime.js";
import { defaultHome } from "./paths.js";

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
  let assetsDir: string | undefined;
  let noOpen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--assetsDir" && args[index + 1] && !assetsDir) assetsDir = args[++index];
    else if (arg === "--no-open" && !noOpen) noOpen = true;
    else throw new Error("Usage: browser --assetsDir <installation-directory> [--no-open]");
  }
  if (!assetsDir) throw new Error("Usage: browser --assetsDir <installation-directory> [--no-open]");
  const runtime = await ensureLocalRuntime({ home: defaultHome(), assetsDir });
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
