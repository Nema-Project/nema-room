import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIAGRAM_TYPES, isDiagramType, type DiagramType } from "@nema/shared";
import type { OwnedHelperScope } from "@nema/shared/ownedHelper";
import { runHelperFile } from "@nema/shared/ownedHelper";

/**
 * Diagram validation and rendering with the vendored archify (vendor/archify, see VENDORED.md).
 * archify is a plain Node CLI: schema validation uses its precompiled validators (no ajv) and
 * rendering needs no browser. Each call runs it as a child process on a private temp directory.
 */

// The type list lives in @nema/shared so diagram entries and the plugin manifest share it.
export { DIAGRAM_TYPES, isDiagramType, type DiagramType };

const ARCHIFY_TIMEOUT_MS = 30_000;
const MAX_DIAGNOSTICS_BYTES = 8 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

let cachedCli: string | undefined;

/** Locate `vendor/archify/bin/archify.mjs`: `NEMA_ARCHIFY_DIR`, else the nearest ancestor that has it. */
export function archifyCli(): string {
  const fromEnv = process.env.NEMA_ARCHIFY_DIR;
  if (fromEnv) return path.join(fromEnv, "bin", "archify.mjs");
  if (cachedCli) return cachedCli;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "vendor", "archify", "bin", "archify.mjs");
    if (existsSync(candidate)) return (cachedCli = candidate);
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("vendored archify not found (vendor/archify/bin/archify.mjs)");
    dir = parent;
  }
}

type RunResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

function runArchify(args: string[], helpers?: OwnedHelperScope): Promise<RunResult> {
  const env = { ...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: "1" };
  if (helpers) return runHelperFile(process.execPath, [archifyCli(), ...args], {
    timeout: ARCHIFY_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", env,
  }, helpers).then((result) => ({
    code: result.error ? (typeof (result.error as NodeJS.ErrnoException).code === "number" ? Number((result.error as NodeJS.ErrnoException).code) : 1) : 0,
    stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8"), timedOut: result.timedOut,
  }));
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [archifyCli(), ...args],
      {
        timeout: ARCHIFY_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        // Never let archify phone home for release notes.
        env,
      },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: Boolean(err?.killed),
        });
      },
    );
  });
}

async function withSpecFile<T>(spec: unknown, fn: (dir: string, input: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "nema-archify-"));
  try {
    const input = path.join(dir, "diagram.json");
    await writeFile(input, JSON.stringify(spec, null, 2));
    return await fn(dir, input);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Diagnostic = { code?: unknown; severity?: unknown; message?: unknown; supportedFixes?: unknown };
type Receipt = { ok?: unknown; error?: unknown; diagnostics?: unknown };

function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  const marker = "\n…(truncated)";
  let out = Buffer.from(text, "utf8").subarray(0, max - Buffer.byteLength(marker, "utf8")).toString("utf8");
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  out = out.replace(/�+$/, "");
  return out + marker;
}

function formatDiagnostics(receipt: Receipt | undefined, run: RunResult): string {
  if (run.timedOut) return `archify timed out after ${ARCHIFY_TIMEOUT_MS / 1000}s`;
  const lines: string[] = [];
  if (receipt) {
    const list = Array.isArray(receipt.diagnostics) ? (receipt.diagnostics as Diagnostic[]) : [];
    for (const d of list) {
      const head = [d.severity, d.code].filter((v) => typeof v === "string").join(" ");
      let line = `- ${head ? `[${head}] ` : ""}${typeof d.message === "string" ? d.message : JSON.stringify(d)}`;
      const fixes = Array.isArray(d.supportedFixes) ? d.supportedFixes.filter((f) => typeof f === "string") : [];
      if (fixes.length > 0) line += ` (fix: ${fixes.join("; ")})`;
      lines.push(line);
    }
    if (lines.length === 0 && typeof receipt.error === "string") lines.push(receipt.error);
  }
  if (lines.length === 0) lines.push((run.stderr || run.stdout).trim() || `archify exited with code ${run.code}`);
  return capBytes(lines.join("\n"), MAX_DIAGNOSTICS_BYTES);
}

function parseReceipt(stdout: string): Receipt | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return parsed && typeof parsed === "object" ? (parsed as Receipt) : undefined;
  } catch {
    return undefined;
  }
}

/** Run `archify validate <type> --quality showcase --json`; on failure return the receipt's errors (≤ 8 KB). */
export async function validateDiagram(
  type: DiagramType,
  spec: unknown,
  helpers?: OwnedHelperScope,
): Promise<{ ok: true } | { ok: false; diagnostics: string }> {
  return withSpecFile(spec, async (_dir, input) => {
    const run = await runArchify(["validate", type, input, "--quality", "showcase", "--json"], helpers);
    const receipt = parseReceipt(run.stdout);
    if (!run.timedOut && run.code === 0 && receipt?.ok === true) return { ok: true };
    return { ok: false, diagnostics: formatDiagnostics(receipt, run) };
  });
}

/** Render a (validated) spec to a self-contained HTML document with `archify render`. */
export async function renderDiagram(type: DiagramType, spec: unknown, helpers?: OwnedHelperScope): Promise<string> {
  return withSpecFile(spec, async (dir, input) => {
    const output = path.join(dir, "diagram.html");
    const run = await runArchify(["render", type, input, output, "--quality", "showcase"], helpers);
    if (run.timedOut || run.code !== 0 || !existsSync(output)) {
      throw new Error(`archify render failed: ${formatDiagnostics(parseReceipt(run.stdout), run)}`);
    }
    return readFile(output, "utf8");
  });
}
