import { execFile } from "node:child_process";
import path from "node:path";

const PICK_TIMEOUT_MS = 10 * 60 * 1000;

// ponytail: FolderBrowserDialog is the legacy tree picker. Upgrade path is the Vista IFileDialog with FOS_PICKFOLDERS.
const WIN_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$d.ShowNewFolderButton = $false",
  "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
].join("; ");

export type CommandRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<{ stdout: string }>;

export function pickerCommand(platform: NodeJS.Platform): { cmd: string; args: string[] } {
  if (platform === "win32") return { cmd: "powershell.exe", args: ["-NoProfile", "-STA", "-Command", WIN_SCRIPT] };
  if (platform === "darwin") return { cmd: "osascript", args: ["-e", "POSIX path of (choose folder)"] };
  return { cmd: "zenity", args: ["--file-selection", "--directory"] };
}

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/** A cancelled dialog is an empty result. Anything that is not one absolute path is refused. */
export function normalizePickedPath(stdout: string, platform: NodeJS.Platform): string | null {
  const picked = stdout.replace(/^\uFEFF/, "").replace(/\r?\n$/, "").trim();
  if (!picked || picked.includes("\0") || /[\r\n]/.test(picked) || picked.length > 4096) return null;
  const api = pathApi(platform);
  if (!api.isAbsolute(picked)) return null;
  const sep = api.sep;
  if (picked.length > 3 && (picked.endsWith(sep) || (platform === "win32" && picked.endsWith("/")))) return picked.slice(0, -1);
  return picked;
}

function isCancel(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code !== 1 && code !== "1") return false;
  const stderr = String((error as { stderr?: unknown }).stderr ?? "");
  return stderr.trim() === "" || /User canceled|-128/.test(stderr);
}

function defaultRun(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        (error as NodeJS.ErrnoException & { stderr?: string }).stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });
}

let pending: Promise<string | null> | null = null;

/** Opens the OS folder dialog on this machine. A second call shares the dialog already open. */
export function pickDirectory(platform = process.platform, run: CommandRunner = defaultRun): Promise<string | null> {
  if (pending && run === defaultRun) return pending;
  const work = (async () => {
    const { cmd, args } = pickerCommand(platform);
    try {
      const { stdout } = await run(cmd, args, PICK_TIMEOUT_MS);
      return normalizePickedPath(stdout, platform);
    } catch (error) {
      if (isCancel(error)) return null;
      throw new Error("无法打开文件夹选择器");
    }
  })();
  if (run !== defaultRun) return work;
  pending = work.finally(() => {
    pending = null;
  });
  return pending;
}
