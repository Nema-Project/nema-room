import type { Account } from "../accounts/schema.js";
import type { CredentialState } from "../accounts/credentials.js";
import { accountForNeed, resolveCapability, type CapabilityNeed, type CapabilitySupport, type TaskNeeds } from "./capabilities.js";

/**
 * Which accounts of this adapter could take this task, and why the others could not (spec 2026-10-31 §4.1).
 *
 * The exclusions are a user-facing answer to "why was my other account not used", so they are recorded here
 * rather than recomputed by whoever asks. Accounts of a different adapter are not in this list at all: they
 * were never candidates, and saying "excluded because it is Claude" would imply a choice that does not exist.
 */

export type Candidate = {
  account: Account;
  model: string;
  capabilities: Record<CapabilityNeed, CapabilitySupport>;
};

export type ExclusionReason =
  | "disabled"
  | "credential_missing"
  | "credential_unusable"
  | "compat_unreadable"
  | "cooling"
  | "capability"
  | "model_missing";

export type Excluded = { accountId: string; accountName: string; reason: ExclusionReason; missing?: CapabilityNeed[]; until?: number };

export type CandidateSet = { candidates: Candidate[]; excluded: Excluded[]; empty: boolean };

/** The user's own ordering, then the declared tier, then the id — the last one only so the result is stable. */
const TIER_RANK: Record<Account["costTier"], number> = { low: 0, standard: 1, high: 2 };

function byPreference(a: Candidate, b: Candidate): number {
  if (a.account.order !== b.account.order) return a.account.order - b.account.order;
  const tier = TIER_RANK[a.account.costTier] - TIER_RANK[b.account.costTier];
  if (tier !== 0) return tier;
  return a.account.id < b.account.id ? -1 : a.account.id > b.account.id ? 1 : 0;
}

export function computeCandidates(o: {
  accounts: Account[];
  adapter: Account["adapter"];
  needs: TaskNeeds;
  credentialOf: (a: Account) => CredentialState;
  coolingUntil: (id: string) => number | null;
  now: () => number;
  resolveModel: (a: Account) => string | null;
}): CandidateSet {
  const candidates: Candidate[] = [];
  const excluded: Excluded[] = [];
  for (const account of o.accounts) {
    if (account.adapter !== o.adapter) continue;
    const label = { accountId: account.id, accountName: account.name };

    if (!account.enabled) {
      excluded.push({ ...label, reason: "disabled" });
      continue;
    }

    const state = o.credentialOf(account);
    if (state !== "connected") {
      // A compat account's credential is the Codex CLI's own login, which Nema neither writes nor owns, so
      // "it is not there" and "it is there and unreadable" are worth telling apart from our own files.
      const reason = account.adapter === "codex-direct" && account.authMode === "compat"
        ? "compat_unreadable"
        : state === "missing"
          ? "credential_missing"
          : "credential_unusable";
      excluded.push({ ...label, reason });
      continue;
    }

    const cooling = o.coolingUntil(account.id);
    if (cooling !== null && cooling > o.now()) {
      excluded.push({ ...label, reason: "cooling", until: cooling });
      continue;
    }

    const model = o.resolveModel(account);
    if (model === null) {
      excluded.push({ ...label, reason: "model_missing" });
      continue;
    }

    const ok = accountForNeed(account, model, o.needs);
    if (!ok.ok) {
      excluded.push({ ...label, reason: "capability", missing: ok.missing });
      continue;
    }

    candidates.push({
      account,
      model,
      capabilities: { image: resolveCapability(account, model, "image"), pdf: resolveCapability(account, model, "pdf") },
    });
  }
  candidates.sort(byPreference);
  return { candidates, excluded, empty: candidates.length === 0 };
}
