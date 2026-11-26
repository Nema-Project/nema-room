import type { GraphifyError, GraphifyUnavailableStatus } from "@nema/shared";
import { formatMiB } from "./components";
import type { useT } from "./i18n";
import type { ComponentFailureReason, ComponentStatus } from "./types";

type T = ReturnType<typeof useT>;

const REASON_KEY: Record<ComponentFailureReason, string> = {
  network: "components.reason.network",
  proxy: "components.reason.proxy",
  "hash-mismatch": "components.reason.hashMismatch",
  "self-check": "components.reason.selfCheck",
  "disk-space": "components.reason.diskSpace",
  offline: "components.reason.offline",
  "unsupported-platform": "components.reason.unsupportedPlatform",
  "lock-unreadable": "components.reason.lockUnreadable",
  "offer-changed": "components.reason.offerChanged",
};

export function repairFailureText(reason: ComponentFailureReason, t: T): string {
  return t("components.state.repairFailed", { reason: t(REASON_KEY[reason]) });
}

/** Describe the current component state. */
export function statusText(status: GraphifyUnavailableStatus | Extract<ComponentStatus, { state: "installed" }>, t: T): string {
  switch (status.state) {
    case "installed": {
      const base = t("components.state.installed", { version: status.version.graphifyy, python: status.version.python });
      return status.lastFailure ? `${base} ${repairFailureText(status.lastFailure.reason, t)}` : base;
    }
    case "installing":
      return t("components.state.installing", { done: formatMiB(status.progress.downloadedBytes), total: formatMiB(status.progress.totalBytes) });
    case "not-installed":
      return t("components.state.notInstalled");
    case "lock-mismatch":
      return t("components.state.lockMismatch");
    case "failed": {
      if (status.reason === "offline") return t("components.state.offline");
      if (status.reason === "unsupported-platform") return t("components.state.unsupported", { detail: status.detail });
      if (status.reason === "lock-unreadable") return t("components.state.lockUnreadable", { detail: status.detail });
      const base = t("components.state.failed", { reason: t(REASON_KEY[status.reason]) });
      return status.installedLockHash ? `${base} ${t("components.state.failedDisabled")}` : base;
    }
  }
}

export function graphifyErrorText(error: GraphifyError, t: T): string {
  if (error.code === "graphify-interrupted") return t("components.state.interrupted");

  const { status } = error;
  const text = statusText(status, t);
  if (status.state === "failed" && status.detail &&
      status.reason !== "unsupported-platform" && status.reason !== "lock-unreadable" && status.reason !== "offline") {
    return `${text} ${status.detail}`;
  }
  return text;
}
