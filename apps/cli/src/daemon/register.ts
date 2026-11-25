import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { readSecretLine, saveSecretLine } from "../secrets/file.js";

export function daemonCredentialPath(nemaHome: string): string {
  return path.join(nemaHome, "daemon-credential");
}

export function resolveDaemonToken(nemaHome: string, fallback: { token: string } | { tokenFile: string }): string {
  const file = daemonCredentialPath(nemaHome);
  // lstat distinguishes a missing credential from a broken symlink or an unreadable credential.
  if (lstatSync(file, { throwIfNoEntry: false })) {
    return readSecretLine(file, "Daemon credential disappeared. Restart the daemon.", "Daemon credential file is invalid.");
  }
  return "token" in fallback ? fallback.token : readFileSync(fallback.tokenFile, "utf8").trim();
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
  const hub = URL.parse(o.hubUrl);
  if (!hub || !["http:", "https:"].includes(hub.protocol) || hub.username || hub.password) {
    throw new Error("Provide an HTTP or HTTPS hub URL.");
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
  if (typeof result?.credential !== "string") throw new Error("The hub returned an invalid daemon credential.");
  saveSecretLine(daemonCredentialPath(o.nemaHome), result.credential);
}
