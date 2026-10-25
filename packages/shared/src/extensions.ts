export type ExtensionKind = "skill" | "mcp" | "plugin";
export type Provision = "bundled" | "managed" | "external";
export type InstallState = "absent" | "installing" | "installed" | "updating" | "removing" | "failed";
export type UseState = "enabled" | "disabled";
export type Availability = "ready" | "missing-dependency" | "incompatible" | "damaged";

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
