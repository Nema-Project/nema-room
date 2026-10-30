import type { McpRecordState } from "./mcpConfig.js";
import type { SkillUsage } from "./skills.js";

export type ExtensionKind = "skill" | "mcp" | "plugin";
export type Provision = "bundled" | "managed" | "external";
export type InstallState = "absent" | "installing" | "installed" | "updating" | "removing" | "failed";
export type UseState = "enabled" | "disabled";
export type Availability = "ready" | "missing-dependency" | "incompatible" | "damaged";

/** Where a managed copy came from, kept with the record so it stays auditable after the source moves. */
export type ExtensionProvenance = {
  repository: string;
  /** 40-character commit the files were copied from. */
  commit: string;
  /** Folder inside the repository; `.` is the root. */
  path: string;
  /** Git blob SHA-1 of the skill's SKILL.md at that commit. */
  digest: string;
  /** SPDX id GitHub reported for the repository, or null. */
  license: string | null;
};

export type ExtensionRecord = {
  id: string;
  kind: ExtensionKind;
  name: string;
  summary: string;
  source: string;
  revision: string;
  provision: Provision;
  installState: InstallState;
  useState: UseState;
  availability: Availability;
  externalPath: string | null;
  error: string | null;
  /** Only on records Nema installed from a pinned source. */
  provenance?: ExtensionProvenance;
  /**
   * Only on a bundled item someone checked with Repair: when the check ran. Its `availability` and
   * `error` then replace the shipped seed's; without it the seed's values stand.
   */
  checkedAt?: string;
  /** Only on MCP records, filled in by the daemon when it lists them. Holds no command line, address or value. */
  mcp?: McpRecordState;
  /** Only on Skill records, filled in by the daemon when it lists them: what works under each runtime. */
  skill?: SkillUsage;
};

/**
 * A Repair check time exactly as the daemon writes it (`Date#toISOString()`): it has to survive a
 * round trip, which rules out impossible dates such as February 30 that `Date.parse` would roll over.
 */
export function isCheckTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

/** Why a skill folder on this computer cannot be attached. */
export type AttachProblem = "missing-frontmatter" | "invalid-id" | "bundled-id" | "id-taken" | "outside-location" | "too-large" | "not-a-folder" | "unreadable";

/** One skill folder found in a known location, as `GET /api/extensions/discover` returns it. */
export type DiscoveredSkill = {
  /** Real path of the folder; links inside the location are resolved, links out of it are not followed. */
  path: string;
  /** Which known location it was found in: `claude`, `codex` or `agents`. */
  location: string;
  name: string | null;
  description: string | null;
  /** Id the record would take; null when it cannot be attached (see `problem`). */
  id: string | null;
  /** An external record already points at this real path. */
  attached: boolean;
  problem: AttachProblem | null;
};

export type SkillDiscovery = {
  /** `unreadable` is set only on a location that exists but could not be listed. */
  locations: Array<{ label: string; path: string; found: boolean; unreadable?: boolean }>;
  skills: DiscoveredSkill[];
  /** More folders were present than the list holds. */
  truncated: boolean;
};

function bundled(id: string, name: string, availability: Availability, error: string | null): ExtensionRecord {
  return {
    id,
    kind: "plugin",
    name,
    summary: "",
    source: "bundled",
    revision: "bundled",
    provision: "bundled",
    installState: "installed",
    useState: "enabled",
    availability,
    externalPath: null,
    error,
  };
}

/** Plugins that ship with the app. Graphify's runtime package is a later plan, so it stays repairable. */
export function bundledExtensions(): ExtensionRecord[] {
  return [
    bundled("code", "graphify", "missing-dependency", "bundled-runtime-missing"),
    bundled("diagram", "archify", "ready", null),
    bundled("superpowers", "superpowers", "ready", null),
    bundled("grill", "grill-me", "ready", null),
    bundled("github", "GitHub", "ready", null),
  ];
}
