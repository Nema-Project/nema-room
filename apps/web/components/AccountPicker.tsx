"use client";

import { useState } from "react";
import { accountsApi, pickerHasChoices, type AccountView } from "@/lib/accounts";
import { useT } from "@/lib/i18n";

/**
 * The account picker (spec 2026-10-31 §1.2), used in the three places an account can be chosen.
 *
 * Two of the scopes are stored choices and one is not:
 *
 * - `message`: the choice belongs to this message only. It is component state and travels with the send.
 * - `thread` / `workspace`: the choice is a binding in `accounts.json` on the daemon's machine, so it is
 *   written through the accounts API. Nothing about it reaches the hub database.
 *
 * The picker hides itself when there is nothing to choose, which is what keeps a single-account setup
 * looking exactly as it did in 0.2.0.
 */

export type AccountPickerProps = {
  scope: "message" | "thread" | "workspace";
  accounts: readonly AccountView[];
  bindings: Record<string, string>;
  value: string | null;
  onChange: (id: string | null) => void;
  /** The thread's id, for `scope="thread"`. */
  threadId?: string;
  /** The workspace's id, for `scope="workspace"`. */
  workspaceId?: string;
  /** False when the daemon has no accounts route; the picker then stays out of the page. */
  supported?: boolean;
  disabled?: boolean;
};

export function AccountPicker({ scope, accounts, bindings, value, onChange, threadId, workspaceId, supported = true, disabled = false }: AccountPickerProps) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  if (!supported) return null;
  // One account and no stored choice: there is no decision to make, and a control that cannot change
  // anything is noise on a page a single-account user never asked to complicate.
  if (!pickerHasChoices(accounts, bindings)) return null;

  const scopeId = scope === "thread" ? threadId : scope === "workspace" ? workspaceId : undefined;
  const stored = scope !== "message";
  const emptyLabel = scope === "workspace" ? t("account.picker.global") : t("account.picker.follow");
  const label = t(`account.picker.${scope}`);

  async function choose(next: string) {
    const id = next === "" ? null : next;
    if (!stored) {
      // A per-message choice is this message's input; nothing is written and nothing is stored.
      setError(false);
      onChange(id);
      return;
    }
    if (scopeId === undefined) return;
    const binding = `${scope === "thread" ? "thread" : "ws"}:${scopeId}`;
    setSaving(true);
    setError(false);
    try {
      await accountsApi.bind(binding, id);
      onChange(id);
    } catch {
      // The select keeps showing the stored value: the choice was not saved, so pretending it was would
      // leave the user believing a different account answers the next task.
      setError(true);
    } finally {
      setSaving(false);
    }
  }

  // A stored choice that names no account here can happen after a restore onto another machine. It is shown
  // as its own entry instead of being dropped, so the page does not read as "not chosen".
  const missing = value !== null && value !== "auto" && !accounts.some((a) => a.id === value);

  return (
    <div className="field account-picker" data-account-picker data-scope={scope}>
      <label className="label" htmlFor={`account-picker-${scope}-${scopeId ?? "message"}`}>{label}</label>
      <select
        id={`account-picker-${scope}-${scopeId ?? "message"}`}
        aria-label={label}
        value={value ?? ""}
        disabled={disabled || saving}
        onChange={(e) => void choose(e.target.value)}
      >
        <option value="">{emptyLabel}</option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>{account.name}</option>
        ))}
        {missing && <option value={value}>{t("account.picker.unknown", { id: value })}</option>}
      </select>
      {error && <p className="error" role="alert">{t("account.picker.failed")}</p>}
    </div>
  );
}
