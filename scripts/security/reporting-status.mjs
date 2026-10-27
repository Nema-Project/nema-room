import { spawnSync } from "node:child_process";

/**
 * 200 with a boolean `enabled` is a real read. Anything else is unknown, not disabled.
 * `enabled: true` is only the repository setting. It does not show that a non-admin reporter opened the form.
 */
export function interpretReportingStatus(status, body) {
  if (status === 200 && body && typeof body === "object" && typeof body.enabled === "boolean") {
    return { state: body.enabled ? "enabled" : "disabled", enabled: body.enabled };
  }
  return { state: "unknown", enabled: null };
}

function readLive() {
  const run = spawnSync("gh", ["api", "repos/Nema-Project/nema-room/private-vulnerability-reporting"], { encoding: "utf8" });
  if (run.status !== 0) return interpretReportingStatus(0, null);
  try {
    return interpretReportingStatus(200, JSON.parse(run.stdout));
  } catch {
    return interpretReportingStatus(0, null);
  }
}

if (process.argv[1]?.endsWith("reporting-status.mjs")) {
  const result = readLive();
  console.log(JSON.stringify(result));
  process.exitCode = result.state === "unknown" ? 2 : 0;
}
