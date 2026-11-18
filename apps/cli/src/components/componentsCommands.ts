// `nema components status | install <name> | pack <name> | import <file>`.
//
// Everything here runs in this process against the component store under ~/.nema/runtime, the same store a
// desktop, npm or Compose host daemon uses, so no daemon has to be running. The installer's cross-process
// lock keeps a CLI install and a daemon install from running at once. Nothing downloads without a yes:
// `install` shows the size, hosts and location and waits for one (or takes `--yes`); the offline switch
// refuses every download.
import { createInterface } from "node:readline";
import type { Command } from "commander";
import { loadConfig, type NemaConfig } from "../config.js";
import type { Out } from "../direct/authCommands.js";
import { installComponent, type InstallHooks, type InstallOffer, type InstallOptions } from "./install.js";
import { importComponent, packComponent, PackRejectedError, type ImportOptions, type ImportResult, type PackOptions, type PackResult } from "./pack.js";
import { componentEnvFor, componentView, type ComponentView } from "./rpc.js";
import { assertComponent, type ComponentEnv } from "./store.js";
import { COMPONENT_NAMES, ComponentInstallError, type ComponentName, type ComponentStatus, type FailureReason, type InstallProgress } from "./types.js";

export type ComponentsCommandDeps = {
  nemaHome: string;
  out: Out;
  stdin: () => NodeJS.ReadableStream;
  /** Whether a person can answer the confirmation; defaults to stdin being a TTY. */
  interactive?: () => boolean;
  /** Recorded in a pack's manifest. */
  version: string;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Store root, lock and platform; tests pass temp directories and a fixture lock. */
  components?: Omit<ComponentEnv, "env" | "offline">;
  /** Installer seams for tests (retry delays, free space, self-check). */
  hooks?: InstallHooks;
  /** Calls `abort` on Ctrl-C while an install, pack or import runs; returns the unsubscribe. */
  onInterrupt?: (abort: () => void) => () => void;
  install?: (name: string, o: InstallOptions) => Promise<ComponentStatus>;
  pack?: (name: string, o: PackOptions) => Promise<PackResult>;
  importPack?: (name: string, file: string, o: ImportOptions) => Promise<ImportResult>;
};

const MiB = 1024 * 1024;
const size = (bytes: number) => `${(bytes / MiB).toFixed(1)} MiB (${bytes} bytes)`;

const REASONS: Record<FailureReason, string> = {
  network: "network error",
  proxy: "proxy error",
  "hash-mismatch": "an archive did not match the lock (sha256 or size)",
  "self-check": "the self-check failed",
  "unsupported-platform": "this platform is not supported",
  offline: "downloads are turned off",
  "disk-space": "not enough disk space",
  "lock-unreadable": "the shipped lock is unreadable",
  "offer-changed": "the component offer changed; confirm again",
};

const INSTALL_HINT = "nema components install graphify";
const IMPORT_HINT = "nema components import <file>";

/** Human-readable status, including the lock-hash and where the component lives. */
export function formatComponentView(view: ComponentView): string[] {
  const { status, offer } = view;
  const lines: string[] = [];
  const location = offer?.location;
  switch (status.state) {
    case "installed":
      lines.push(`${status.name}: installed`);
      lines.push(`  version: graphifyy ${status.version.graphifyy}, Python ${status.version.python}`);
      lines.push(`  lock-hash: ${status.lockHash}`);
      lines.push(`  location: ${status.path}`);
      lines.push(`  launcher: ${status.launcher}`);
      if (status.lastFailure) {
        lines.push(`  last reinstall failed: ${REASONS[status.lastFailure.reason]}`);
        lines.push(`  detail: ${status.lastFailure.detail}`);
        lines.push(`  at: ${status.lastFailure.at}`);
      }
      break;
    case "installing":
      lines.push(`${status.name}: installing (${status.progress.phase}, ${size(status.progress.downloadedBytes)} of ${size(status.progress.totalBytes)})`);
      lines.push(`  lock-hash: ${status.lockHash}`);
      if (location) lines.push(`  location: ${location}`);
      break;
    case "not-installed":
      lines.push(`${status.name}: not installed`);
      lines.push(`  lock-hash: ${status.lockHash}`);
      if (location) lines.push(`  location: ${location}`);
      break;
    case "lock-mismatch":
      lines.push(`${status.name}: not installed (the installed version is for another Nema build and is disabled)`);
      lines.push(`  lock-hash: ${status.lockHash}`);
      lines.push(`  disabled version: ${status.installedLockHash}`);
      if (location) lines.push(`  location: ${location}`);
      break;
    case "failed":
      lines.push(
        status.reason === "unsupported-platform" || status.reason === "lock-unreadable" || status.at === null
          ? `${status.name}: not available (${REASONS[status.reason]})`
          : `${status.name}: not installed (last attempt failed: ${REASONS[status.reason]})`,
      );
      lines.push(`  detail: ${status.detail}`);
      if (status.lockHash) lines.push(`  lock-hash: ${status.lockHash}`);
      if (status.installedLockHash) lines.push(`  disabled version: ${status.installedLockHash} (for another Nema build, not used)`);
      if (status.at) lines.push(`  at: ${status.at}`);
      if (location) lines.push(`  location: ${location}`);
      break;
  }
  if (status.state !== "installed" && status.state !== "installing" && offer) {
    lines.push(`  download: ${size(offer.totalBytes)} from ${offer.hosts.join(", ")}`);
  }
  if (view.offerError) lines.push(`  cannot download: ${view.offerError}`);
  const { pythonMirror, pypiBase, offline } = view.settings;
  if (pythonMirror.value) lines.push(`  Python mirror: ${pythonMirror.value} (${pythonMirror.source === "env" ? "environment" : "config"})`);
  if (pypiBase.value) lines.push(`  PyPI base: ${pypiBase.value} (${pypiBase.source === "env" ? "environment" : "config"})`);
  if (offline.value) lines.push(`  offline: downloads are turned off (${offline.source === "env" ? "NEMA_GRAPHIFY_OFFLINE" : "components.offline"}); use ${IMPORT_HINT}`);
  else if (status.state === "not-installed" || status.state === "lock-mismatch" || (status.state === "failed" && status.reason !== "unsupported-platform" && status.reason !== "lock-unreadable")) {
    lines.push(`  install: ${INSTALL_HINT} (or ${IMPORT_HINT})`);
  }
  return lines;
}

function nameArg(raw: string): ComponentName {
  assertComponent(raw);
  return raw;
}

async function readAnswer(input: NodeJS.ReadableStream): Promise<string | null> {
  const rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
  try {
    for await (const line of rl) return line;
    return null;
  } finally {
    rl.close();
  }
}

function defaultOnInterrupt(abort: () => void): () => void {
  const handler = () => abort();
  process.once("SIGINT", handler);
  return () => process.off("SIGINT", handler);
}

/** One line per file and phase change, so a long download is visible without flooding a log. */
function progressPrinter(out: Out): (progress: InstallProgress) => void {
  let last = "";
  let lastTenth = -1;
  return (progress) => {
    const key = `${progress.phase}:${progress.file ?? ""}`;
    const tenth = progress.totalBytes > 0 ? Math.floor((progress.downloadedBytes / progress.totalBytes) * 10) : 0;
    if (key === last && (progress.phase !== "download" || tenth === lastTenth)) return;
    last = key;
    lastTenth = tenth;
    const done = `${(progress.downloadedBytes / MiB).toFixed(1)}/${(progress.totalBytes / MiB).toFixed(1)} MiB`;
    out.error(`  ${progress.phase}${progress.file ? ` ${progress.file}` : ""} (${done})`);
  };
}

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

export function registerComponentsCommands(components: Command, deps: ComponentsCommandDeps, exit: (code: number) => void = (code) => { process.exitCode = code; }): void {
  const processEnv = () => deps.env ?? process.env;
  const config = (): NemaConfig => loadConfig(deps.nemaHome);
  const envFor = (cfg: NemaConfig): ComponentEnv => componentEnvFor(cfg, processEnv(), deps.components);
  const view = (name: ComponentName, cfg: NemaConfig = config()) => componentView(name, { cfg, processEnv: processEnv(), components: deps.components });
  const interactive = deps.interactive ?? (() => process.stdin.isTTY === true);
  const onInterrupt = deps.onInterrupt ?? defaultOnInterrupt;

  /** Runs `body` with an AbortSignal that Ctrl-C trips; reports thrown errors and sets the exit code. */
  async function run(body: (signal: AbortSignal) => Promise<number>): Promise<void> {
    const controller = new AbortController();
    const unsubscribe = onInterrupt(() => controller.abort());
    try {
      exit(await body(controller.signal));
    } catch (error) {
      if (isAbort(error) || controller.signal.aborted) {
        deps.out.error("Cancelled; nothing was changed.");
        exit(130);
      } else {
        deps.out.error(error instanceof Error ? error.message : String(error));
        exit(1);
      }
    } finally {
      unsubscribe();
    }
  }

  function reportResult(status: ComponentStatus, cfg: NemaConfig, signal: AbortSignal, before?: ComponentStatus): number {
    if (status.state === "installed") {
      deps.out.log(`${status.name} is installed (lock-hash ${status.lockHash}) at ${status.path}`);
      return 0;
    }
    if (signal.aborted) {
      deps.out.error("Cancelled; the partial download was removed and the previous state is unchanged.");
      return 130;
    }
    const current = view(status.name, cfg);
    if (status.state === "failed") {
      // The attempt's outcome and the store's status are reported separately. Whether this was a
      // reinstall comes from the attempt's own pre-read (`before`), and the current status is
      // printed as it now stands: the pre-read happened outside the installer lock, so this
      // command cannot claim the copy now installed is the one the attempt saw, or that it is
      // unchanged — another process may have installed or repaired it in the meantime.
      const attempt = before?.state === "installed" ? "reinstall" : "install";
      deps.out.error(`${status.name}: the ${attempt} failed (${REASONS[status.reason]}).`);
      deps.out.error(`  detail: ${status.detail}`);
      if (status.at) deps.out.error(`  at: ${status.at}`);
      for (const line of formatComponentView(current)) deps.out.error(line);
      return 1;
    }
    for (const line of formatComponentView({ ...current, status })) deps.out.error(line);
    return 1;
  }

  components
    .command("status")
    .description("Show the state of optional components (Graphify): installed version, lock-hash and location")
    .argument("[name]", "component name", "graphify")
    .option("--json", "print the status as JSON")
    .action(async (rawName: string, flags: { json?: boolean }) => {
      await run(async () => {
        const name = nameArg(rawName);
        const current = view(name);
        if (flags.json) deps.out.log(JSON.stringify(current, null, 2));
        else for (const line of formatComponentView(current)) deps.out.log(line);
        return 0;
      });
    });

  components
    .command("install")
    .description("Download, verify and install an optional component after showing its size; --yes skips the question")
    .argument("<name>", `component name (${COMPONENT_NAMES.join(", ")})`)
    .option("-y, --yes", "install without asking (for scripts)")
    .option("--force", "reinstall the current version over the installed copy (repair)")
    .action(async (rawName: string, flags: { yes?: boolean; force?: boolean }) => {
      await run(async (signal) => {
        const name = nameArg(rawName);
        const cfg = config();
        const current = view(name, cfg);
        const { status } = current;
        // Without --force an installed component stays put: the repair path is the reinstall below.
        if (status.state === "installed" && !flags.force) {
          deps.out.log(`${name} is already installed (lock-hash ${status.lockHash}) at ${status.path}`);
          deps.out.log(`Reinstall it with: nema components install ${name} --force`);
          return 0;
        }
        if (status.state === "installing") {
          deps.out.error(`${name} is being installed by another process; check again with nema components status`);
          return 1;
        }
        // The offline switch refuses before anything else: no installer call, no connection.
        if (current.settings.offline.value) {
          deps.out.error(`Downloads are turned off (${current.settings.offline.source === "env" ? "NEMA_GRAPHIFY_OFFLINE" : "components.offline"}); ${name} was not downloaded.`);
          deps.out.error(`Import an offline pack instead: ${IMPORT_HINT}`);
          return 1;
        }
        if (status.state === "failed" && (status.reason === "unsupported-platform" || status.reason === "lock-unreadable")) {
          deps.out.error(`${name} cannot be installed here: ${status.detail}`);
          return 1;
        }
        if (!flags.yes && !interactive()) {
          deps.out.error(`${name} needs a confirmation before it downloads; run it in a terminal, or pass --yes`);
          return 1;
        }
        const confirm = async (offer: InstallOffer): Promise<boolean> => {
          deps.out.log(`Component: ${offer.name} (lock-hash ${offer.lockHash})`);
          if (flags.force) deps.out.log("This reinstalls the current version over the installed copy.");
          deps.out.log(`Download: ${size(offer.totalBytes)} from ${offer.hosts.join(", ")}`);
          deps.out.log(`Install location: ${offer.location}`);
          deps.out.log("Every archive is checked against the sha256 and size in the lock shipped with Nema before it is unpacked.");
          if (flags.yes) return true;
          deps.out.log("Download and install? [y/N]");
          const answer = (await readAnswer(deps.stdin()))?.trim().toLowerCase();
          return answer === "y" || answer === "yes";
        };
        let declined = false;
        const install = deps.install ?? installComponent;
        const result = await install(name, {
          env: envFor(cfg),
          signal,
          hooks: deps.hooks,
          force: flags.force === true,
          onProgress: progressPrinter(deps.out),
          confirm: async (offer) => {
            const yes = await confirm(offer);
            declined = !yes;
            return yes;
          },
        });
        if (declined) {
          deps.out.error(`${name} was not installed.`);
          return 1;
        }
        return reportResult(result, cfg, signal, status);
      });
    });

  components
    .command("pack")
    .description("Download a component's archives as the lock pins them and write them, unassembled, into an offline .nema-component pack")
    .argument("<name>", `component name (${COMPONENT_NAMES.join(", ")})`)
    .option("-o, --output <file>", "pack file to write (default: <name>-<target>-<lock-hash>.nema-component here)")
    .action(async (rawName: string, flags: { output?: string }) => {
      await run(async (signal) => {
        const name = nameArg(rawName);
        const cfg = config();
        const pack = deps.pack ?? packComponent;
        try {
          const result = await pack(name, { output: flags.output, env: envFor(cfg), hooks: deps.hooks, signal, onProgress: progressPrinter(deps.out), toolVersion: deps.version });
          deps.out.log(`Wrote ${result.file} (${size(result.bytes)})`);
          deps.out.log(`  target: ${result.manifest.target}, lock-hash: ${result.manifest.lockHash}`);
          deps.out.log(`  ${result.manifest.archives.length} archives, each checked against the lock's sha256 and size, stored unchanged`);
          deps.out.log("Import it on a machine running the same Nema version and platform with: nema components import <file>");
          deps.out.log(
            "You make and distribute this pack. It holds upstream archives (CPython from python-build-standalone and Python wheels) under their own licenses; the license obligations for passing it on are yours. Nema does not publish component packs.",
          );
          return 0;
        } catch (error) {
          if (error instanceof ComponentInstallError) {
            deps.out.error(`Could not make the pack: ${REASONS[error.reason]}: ${error.message}`);
            return 1;
          }
          throw error;
        }
      });
    });

  components
    .command("import")
    .description("Install a component from an offline .nema-component pack, checked against the lock shipped with Nema")
    .argument("<file>", "pack made by nema components pack")
    .action(async (file: string) => {
      await run(async (signal) => {
        const name: ComponentName = "graphify";
        const cfg = config();
        const before = view(name, cfg).status;
        const importPack = deps.importPack ?? importComponent;
        try {
          const result = await importPack(name, file, {
            env: envFor(cfg),
            hooks: deps.hooks,
            signal,
            onProgress: progressPrinter(deps.out),
            onAccepted: ({ target, lockHash, ignored }) => {
              deps.out.log(`Pack matches this Nema build (${target}, lock-hash ${lockHash}); verifying and installing offline`);
              if (ignored.length) {
                const shown = ignored.slice(0, 10).join(", ");
                deps.out.log(`Ignored ${ignored.length} pack entr${ignored.length === 1 ? "y" : "ies"} that are not archives (never unpacked or run): ${shown}${ignored.length > 10 ? ", …" : ""}`);
              }
            },
          });
          return reportResult(result.status, cfg, signal, before);
        } catch (error) {
          if (error instanceof PackRejectedError) {
            deps.out.error(`Pack rejected: ${error.message}`);
            deps.out.error("Nothing was installed or changed.");
            return 1;
          }
          if (error instanceof ComponentInstallError) {
            deps.out.error(`Could not import: ${REASONS[error.reason]}: ${error.message}`);
            return 1;
          }
          throw error;
        }
      });
    });
}
