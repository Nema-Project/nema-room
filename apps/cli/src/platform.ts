import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Electron's executable is a GUI binary unless this is set. Real Node ignores it. */
export function electronRunAsNode(): boolean {
  return process.env.ELECTRON_RUN_AS_NODE === "1" || process.versions.electron !== undefined;
}

/** Copy the flag into a replacement environment so a child of Electron stays Node. */
export function withElectronNode<T extends NodeJS.ProcessEnv>(env: T): T {
  if (!electronRunAsNode()) return env;
  return { ...env, ELECTRON_RUN_AS_NODE: "1" } as T;
}

export function windowsRuntimeEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.platform !== "win32") return env;
  for (const name of ["SystemRoot", "ComSpec", "PATHEXT", "TEMP", "TMP"]) {
    const key = Object.keys(parent).find(key => key.toLowerCase() === name.toLowerCase());
    if (key && parent[key] !== undefined) env[name] = parent[key];
  }
  return env;
}

/**
 * The paths a command name may resolve to, in lookup order. On Windows these are exactly the candidates
 * `commandSpec` walks (case-insensitive `Path`, `;`-separated, `.exe .com .cmd .bat` then the bare name). On
 * POSIX `commandSpec` leaves the lookup to the OS, so this is the plain `PATH` walk `execvp` does: each
 * directory — an empty entry means the current directory — no extensions, and a name with a slash is taken
 * as given.
 */
export function commandPathCandidates(bin: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const searchPath = Object.entries(env).find(([key]) => platform === "win32" ? key.toLowerCase() === "path" : key === "PATH")?.[1] ?? "";
  if (platform !== "win32") {
    if (bin.includes("/")) return [bin];
    // Join by hand, not path.posix.join: join normalizes `..` away, but the kernel resolves PATH entries
    // left to right, so `dir/nonexistent/../bin` is ENOENT while the normalized `dir/bin` exists.
    return searchPath.split(":").map((dir) => (dir === "" ? `./${bin}` : `${dir}/${bin}`));
  }
  const p = path.win32;
  const dirs = p.isAbsolute(bin) || /[/\\]/.test(bin) ? [""] : searchPath.split(";");
  const extensions = p.extname(bin) ? [""] : [".exe", ".com", ".cmd", ".bat", ""];
  const candidates: string[] = [];
  for (const dir of dirs) for (const ext of extensions) candidates.push(dir ? p.join(dir, bin + ext) : bin + ext);
  return candidates;
}

/** Resolve native executables and npm JS shims without passing arguments through cmd.exe. */
export function commandSpec(bin: string, args: string[], env: NodeJS.ProcessEnv = process.env, platform = process.platform): { bin: string; args: string[] } {
  if (/\.[cm]?js$/i.test(bin) && existsSync(bin)) return { bin: process.execPath, args: [bin, ...args] };
  if (platform === "win32" && !path.extname(bin) && existsSync(bin) && /^#![^\r\n]*\bnode\b/.test(readFileSync(bin, "utf8").slice(0, 256))) return { bin: process.execPath, args: [bin, ...args] };
  if (platform !== "win32") return { bin, args };
  const p = path.win32;
  for (const candidate of commandPathCandidates(bin, env, platform)) {
    if (!existsSync(candidate)) continue;
    const candidateExt = p.extname(candidate);
    if (/\.(?:[cm]?js)$/i.test(candidateExt)) return { bin: process.execPath, args: [candidate, ...args] };
    if (!candidateExt) {
      const header = readFileSync(candidate, "utf8").slice(0, 256);
      if (/^#![^\r\n]*\bnode\b/.test(header)) return { bin: process.execPath, args: [candidate, ...args] };
    }
    if (!/\.(cmd|bat)$/i.test(candidate)) return { bin: candidate, args };
    const match = /"%(?:dp0%|~dp0)[\\/]([^"\r\n]+\.(?:[cm]?js))"/i.exec(readFileSync(candidate, "utf8"));
    if (!match) throw new Error(`Unsupported command shim: ${p.basename(candidate)}; install a native executable or a standard npm shim.`);
    const entry = p.resolve(p.dirname(candidate), match[1]!);
    if (!existsSync(entry)) throw new Error(`Command entry missing: ${p.basename(candidate)}`);
    return { bin: process.execPath, args: [entry, ...args] };
  }
  return { bin, args };
}

export function browserCommand(url: string, platform = process.platform): { bin: string; args: string[] } {
  if (platform === "win32") return { bin: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  return { bin: platform === "darwin" ? "open" : "xdg-open", args: [url] };
}
