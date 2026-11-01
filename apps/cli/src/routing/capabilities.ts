import type { TaskAssign } from "@nema/shared";
import type { Account } from "../accounts/schema.js";

/**
 * What an account has *declared* it can take, three layers deep (spec 2026-10-31 §4.2). Nothing here asks a
 * model what it can do: the answer only ever comes from a declaration the user or an import made, or from the
 * adapter's own table as the last resort.
 *
 * "undeclared" is a third answer on purpose. Automatic routing treats it like "no" (only an explicit yes is
 * picked), but the settings page and the refusal text say "not declared" instead of "not supported", because
 * those are different facts and the user can act on only one of them.
 */
export type CapabilitySupport = "yes" | "no" | "undeclared";

export type CapabilityNeed = "image" | "pdf";

export type TaskNeeds = { image?: boolean; pdf?: boolean };

/** The kinds this task actually carries. Text files need no declaration: every adapter takes them. */
export function taskNeeds(task: TaskAssign): TaskNeeds {
  const needs: TaskNeeds = {};
  for (const ref of task.attachments ?? []) {
    if (ref.kind === "image") needs.image = true;
    if (ref.kind === "pdf") needs.pdf = true;
  }
  return needs;
}

/**
 * Layer 1 and 2: the model's own declaration first, then the account's. `undefined` means this layer said
 * nothing, which is not the same as saying "no".
 */
export function accountCapability(account: Account, model: string, need: CapabilityNeed): CapabilitySupport {
  const declared = account.modelCapabilities?.[model]?.[need];
  if (declared !== undefined) return declared ? "yes" : "no";
  const atAccount = account.capabilities?.[need];
  if (atAccount !== undefined) return atAccount ? "yes" : "no";
  return "undeclared";
}

/**
 * Layer 3: what the running adapter can hand over at all, from the existing table in
 * `attachments/capabilities.ts` — the same table the attachment refusal reads, so the two cannot disagree
 * about what is possible. "native" and "text" mean yes; "unknown" means Nema cannot tell, not that it fails.
 */
export function adapterCapability(adapter: Account["adapter"], need: CapabilityNeed): CapabilitySupport {
  if (adapter === "claude-code") {
    // Claude Code's stream-json has no documented `document` block, so a PDF is unproven there.
    return need === "image" ? "yes" : "undeclared";
  }
  return "yes";
}

/** All three layers, most specific first. */
export function resolveCapability(account: Account, model: string, need: CapabilityNeed): CapabilitySupport {
  const declared = accountCapability(account, model, need);
  return declared === "undeclared" ? adapterCapability(account.adapter, need) : declared;
}

/**
 * Whether this account can take everything the task carries. "undeclared" counts as missing: automatic
 * routing only picks an account that said yes (D-4 A), so an unproven ability is a reason not to pick it,
 * while a manual choice is honoured anyway.
 */
export function accountForNeed(
  account: Account,
  model: string,
  needs: TaskNeeds,
): { ok: true } | { ok: false; missing: CapabilityNeed[] } {
  const missing: CapabilityNeed[] = [];
  for (const need of ["image", "pdf"] as const) {
    if (needs[need] !== true) continue;
    if (resolveCapability(account, model, need) !== "yes") missing.push(need);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
