// Optional components that Nema downloads on demand. Graphify is the only one.

export type ComponentName = "graphify";

export const COMPONENT_NAMES: readonly ComponentName[] = ["graphify"];

/** Why the last install attempt, or this platform, leaves the component unusable. */
export type FailureReason =
  | "network"
  | "proxy"
  | "hash-mismatch"
  | "self-check"
  | "unsupported-platform"
  | "offline"
  | "disk-space"
  | "lock-unreadable";

export type InstallPhase = "download" | "verify" | "extract" | "self-check" | "activate";

export type InstallProgress = {
  phase: InstallPhase;
  /** Bytes of the pinned archives received so far, across every file. */
  downloadedBytes: number;
  /** Sum of the lock's `size` fields for this platform. */
  totalBytes: number;
  /** Archive being downloaded or verified; null outside those phases. */
  file: string | null;
};

export type ComponentStatus =
  | {
      state: "installed";
      name: ComponentName;
      lockHash: string;
      version: { graphifyy: string; python: string };
      /** The `<lock-hash>` directory. */
      path: string;
      launcher: string;
    }
  | {
      state: "not-installed";
      name: ComponentName;
      lockHash: string;
    }
  | {
      /** A version is installed, but for another lock: it is not used, and the current lock needs an install. */
      state: "lock-mismatch";
      name: ComponentName;
      lockHash: string;
      installedLockHash: string;
    }
  | {
      state: "failed";
      name: ComponentName;
      /** Null when the platform has no lock target at all. */
      lockHash: string | null;
      reason: FailureReason;
      detail: string;
      /** ISO time of the failed attempt; null for a condition that was never attempted (platform, offline). */
      at: string | null;
      /** A version for another lock that stays disabled. */
      installedLockHash?: string;
    }
  | {
      state: "installing";
      name: ComponentName;
      lockHash: string;
      progress: InstallProgress;
    };

/** A failure the installer can name. Anything else thrown inside an install is reported as `self-check`. */
export class ComponentInstallError extends Error {
  constructor(readonly reason: FailureReason, message: string) {
    super(message);
    this.name = "ComponentInstallError";
  }
}
