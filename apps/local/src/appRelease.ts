import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchLatestRelease, type ReleaseCheckResult, type ReleaseOffer } from "./releaseCheck.js";

export const UPDATE_CHECK_FILE = "update-check.json";
export const UPDATE_REQUEST_FILE = "update-check-request.json";
export const UPDATE_STATUS_FILE = "update-status.json";
const START_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_POLL_MS = 2_000;
const RECENT_REQUEST_MS = 60_000;

export type AppReleaseReply = { status: number; body: Record<string, unknown> };
export type AppReleaseService = {
  dispatch(method: string, pathname: string, body: unknown): Promise<AppReleaseReply | null>;
  close(): void;
};

type Prefs = { enabled: boolean };
type StatusFile = { state: ReleaseCheckResult["state"]; version?: string; url?: string; checkedAt: string };

function normalizeCommit(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[0-9a-f]{7,64}$/i.test(value.trim())) return undefined;
  return value.trim().toLowerCase().slice(0, 7);
}

function metadataCommit(root: string): string | undefined {
  try {
    const file = join(root, "build-metadata.json");
    const text = readFileSync(file, "utf8");
    if (text.length > 4096) return undefined;
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const record = raw as Record<string, unknown>;
    const build = record.build;
    const nested = build && typeof build === "object" && !Array.isArray(build) ? (build as Record<string, unknown>).commit : undefined;
    return normalizeCommit(record.commit) ?? normalizeCommit(nested);
  } catch {
    return undefined;
  }
}

/** Version from the runtime manifest, plus a short commit from the manifest or build metadata. */
export function readBuildIdentity(root: string, manifest: { version?: unknown; commit?: unknown; build?: unknown }): { version: string; commit?: string } {
  const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  const build = manifest.build;
  const nested = build && typeof build === "object" && !Array.isArray(build) ? (build as Record<string, unknown>).commit : undefined;
  const commit = normalizeCommit(manifest.commit) ?? normalizeCommit(nested) ?? metadataCommit(root);
  return { version, ...(commit ? { commit } : {}) };
}

function readPrefs(file: string): Prefs {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { enabled: true };
    const updateCheck = (raw as Record<string, unknown>).updateCheck;
    const nested = updateCheck && typeof updateCheck === "object" && !Array.isArray(updateCheck) ? updateCheck as Record<string, unknown> : null;
    return { enabled: nested ? nested.enabled !== false : true };
  } catch {
    return { enabled: true };
  }
}

function readRequestAt(file: string): number {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return 0;
    const value = (raw as Record<string, unknown>).checkRequestedAt;
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

function invalid(): AppReleaseReply { return { status: 400, body: { error: "invalid_request" } }; }

export function createAppReleaseService(options: {
  home: string;
  version: string;
  commit?: string;
  fetchImpl?: typeof fetch;
  /** Defaults to off under Vitest so runtime tests do not call GitHub. */
  schedule?: boolean;
  delayMs?: number;
  intervalMs?: number;
  requestPollMs?: number;
}): AppReleaseService {
  const prefsFile = join(options.home, UPDATE_CHECK_FILE);
  const requestFile = join(options.home, UPDATE_REQUEST_FILE);
  const statusFile = join(options.home, UPDATE_STATUS_FILE);
  const schedule = options.schedule ?? process.env.VITEST !== "true";
  let stopped = false;
  let flight: Promise<void> | undefined;
  let latest: ReleaseCheckResult = { state: "current" };
  const startedAt = Date.now();
  const initialRequest = readRequestAt(requestFile);
  // A tray click during process startup lands before this service exists. Replay only that recent request.
  let lastRequest = initialRequest >= startedAt - RECENT_REQUEST_MS ? 0 : initialRequest;
  const timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];

  const snapshot = (): Record<string, unknown> => {
    const prefs = readPrefs(prefsFile);
    const body: Record<string, unknown> = { enabled: prefs.enabled, state: latest.state };
    if (latest.offer) body.offer = { version: latest.offer.version, url: latest.offer.url };
    return body;
  };

  const writeStatus = (result: ReleaseCheckResult) => {
    // A failed recheck leaves the release the user already saw. The failure stays quiet.
    if (result.state === "error" && latest.offer) return;
    latest = result;
    const payload: StatusFile = { state: result.state, checkedAt: new Date().toISOString() };
    if (result.offer) {
      payload.version = result.offer.version;
      payload.url = result.offer.url;
    }
    try { writeJson(statusFile, payload); } catch { /* the page still reads the in-memory snapshot */ }
  };

  const runCheck = (manual: boolean): Promise<void> => {
    if (flight) return flight;
    flight = (async () => {
      if (stopped) return;
      const prefs = readPrefs(prefsFile);
      if (!manual && !prefs.enabled) {
        writeStatus({ state: "disabled" });
        return;
      }
      const result = await fetchLatestRelease(options.version, { enabled: prefs.enabled, manual, fetchImpl: options.fetchImpl });
      if (stopped) return;
      if (!manual && !readPrefs(prefsFile).enabled) {
        writeStatus({ state: "disabled" });
        return;
      }
      writeStatus(result);
    })().finally(() => { flight = undefined; });
    return flight;
  };

  const pollRequest = () => {
    if (stopped) return;
    const requestedAt = readRequestAt(requestFile);
    if (requestedAt > lastRequest) {
      lastRequest = requestedAt;
      void runCheck(true);
    }
  };

  if (schedule) {
    const delay = setTimeout(() => { void runCheck(false); }, options.delayMs ?? START_DELAY_MS);
    const interval = setInterval(() => { void runCheck(false); }, options.intervalMs ?? CHECK_INTERVAL_MS);
    const requests = setInterval(pollRequest, options.requestPollMs ?? REQUEST_POLL_MS);
    for (const timer of [delay, interval, requests]) timer.unref?.();
    timers.push(delay, interval, requests);
  }

  return {
    close() {
      stopped = true;
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    },
    async dispatch(method, pathname, body) {
      if (stopped) return { status: 503, body: { error: "service_closing" } };
      try {
        if (method === "GET" && pathname === "/_nema/version") {
          return { status: 200, body: { version: options.version, ...(options.commit ? { commit: options.commit } : {}) } };
        }
        if (method === "GET" && pathname === "/_nema/update") return { status: 200, body: snapshot() };
        if (method === "PATCH" && pathname === "/_nema/update") {
          if (!body || typeof body !== "object" || Array.isArray(body)) return invalid();
          const record = body as Record<string, unknown>;
          if (Object.keys(record).length !== 1 || typeof record.enabled !== "boolean") return invalid();
          try {
            writeJson(prefsFile, { updateCheck: { enabled: record.enabled } });
          } catch { return { status: 500, body: { error: "internal_error" } }; }
          if (!record.enabled) writeStatus({ state: "disabled" });
          return { status: 200, body: snapshot() };
        }
        if (method === "POST" && pathname === "/_nema/update/check") {
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) return invalid();
          await runCheck(true);
          return { status: 200, body: snapshot() };
        }
        return null;
      } catch {
        return { status: 500, body: { error: "internal_error" } };
      }
    },
  };
}

export type { ReleaseOffer };
