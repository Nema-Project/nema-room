import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { withFileLockSync } from "../direct/lock.js";
import { readSecretLine, saveSecretLine } from "../secrets/file.js";

export function daemonCredentialPath(nemaHome: string): string {
  return path.join(nemaHome, "daemon-credential");
}

const INVALID_CREDENTIAL_FILE = "Daemon credential file is invalid.";
const isCredential = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && !/[\u0000-\u001f\u007f]/.test(value);

function readDaemonCredentials(file: string): Map<string, string> {
  const credentials = new Map<string, string>();
  // lstat distinguishes a missing credential from a broken symlink or an unreadable credential.
  if (!lstatSync(file, { throwIfNoEntry: false })) return credentials;
  const line = readSecretLine(file, "Daemon credential disappeared. Restart the daemon.", INVALID_CREDENTIAL_FILE);
  // The earliest format held an opaque credential with no origin.
  if (!line.startsWith("{")) return credentials;
  let saved: { origin?: unknown; credential?: unknown; credentialsByOrigin?: unknown };
  try {
    saved = JSON.parse(line);
  } catch {
    throw new Error(INVALID_CREDENTIAL_FILE);
  }
  const byOrigin = saved.credentialsByOrigin;
  if (typeof byOrigin === "object" && byOrigin !== null && !Array.isArray(byOrigin)) {
    for (const [origin, credential] of Object.entries(byOrigin)) {
      if (!isCredential(credential)) throw new Error(INVALID_CREDENTIAL_FILE);
      credentials.set(origin, credential);
    }
  } else if (typeof saved.origin === "string" && isCredential(saved.credential)) {
    credentials.set(saved.origin, saved.credential);
  } else {
    throw new Error(INVALID_CREDENTIAL_FILE);
  }
  return credentials;
}

export function resolveDaemonToken(nemaHome: string, hubUrl: string, fallback: { token: string } | { tokenFile: string }): string {
  const origin = URL.parse(hubUrl)?.origin;
  const saved = readDaemonCredentials(daemonCredentialPath(nemaHome)).get(origin ?? "");
  return saved ?? ("token" in fallback ? fallback.token : readFileSync(fallback.tokenFile, "utf8").trim());
}

export function parseDaemonHubUrl(hubUrl: string): URL {
  const url = URL.parse(hubUrl);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Provide an HTTP or HTTPS hub URL without credentials.");
  }
  // Check the input too: URL normalizes dot segments and hides empty query/fragment values.
  if (!/^https?:\/\/[^/\\?#]+\/?$/i.test(hubUrl.trim())) {
    throw new Error("The hub URL must be an origin with no path, query, or fragment.");
  }
  return url;
}

export function shouldWarnAboutPlaintextRegistration(hub: URL): boolean {
  const { protocol, hostname } = hub;
  // URL normalizes IPv4 and IPv6 literals before this check.
  return protocol === "http:" && hostname !== "localhost" && hostname !== "[::1]" && !/^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export async function registerDaemon(o: {
  hubUrl: string;
  code: string;
  label: string;
  nemaHome: string;
  fetcher?: typeof fetch;
}): Promise<void> {
  if (!o.code) throw new Error("A registration code is required.");
  const label = o.label.trim();
  if (!label || label.length > 120 || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new Error("The daemon label must be between 1 and 120 characters.");
  }
  const hub = parseDaemonHubUrl(o.hubUrl);
  if (shouldWarnAboutPlaintextRegistration(hub)) {
    console.error("Warning: The registration code and long-lived credential will travel across the network in plaintext. Use this only on a trusted network or VPN. On public networks, use a deployment with HTTPS termination.");
  }
  const endpoint = new URL("/api/daemons/register", hub).href;
  const response = await (o.fetcher ?? fetch)(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: o.code, label }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => { throw new Error("Could not reach the hub registration endpoint."); });
  if (response.status === 400) throw new Error("Registration code is invalid, expired, or already used.");
  if (!response.ok) throw new Error(`Daemon registration failed (HTTP ${response.status}).`);
  const result = await response.json().catch(() => null) as { credential?: unknown } | null;
  const credential = result?.credential;
  if (!isCredential(credential)) throw new Error("The hub returned an invalid daemon credential.");
  const file = daemonCredentialPath(o.nemaHome);
  mkdirSync(o.nemaHome, { recursive: true, mode: 0o700 });
  withFileLockSync(file + ".lock", () => {
    const credentials = readDaemonCredentials(file);
    credentials.set(hub.origin, credential);
    saveSecretLine(file, JSON.stringify({ credentialsByOrigin: Object.fromEntries(credentials) }));
  });
}
