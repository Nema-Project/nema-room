import type { McpRecordState } from "./mcpConfig.js";

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
  /** Only on MCP records, filled in by the daemon when it lists them. Holds no command line, address or value. */
  mcp?: McpRecordState;
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
