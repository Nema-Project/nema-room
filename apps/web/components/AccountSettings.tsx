"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  AccountsError,
  AccountsUnsupportedError,
  accountsApi,
  type AccountCreate,
  type AccountView,
  type AccountsList,
} from "@/lib/accounts";
import { ModelSettingsError } from "@/lib/modelSettings";
import { useT } from "@/lib/i18n";

/**
 * The account block of the model settings page (spec 2026-10-31 §1.1).
 *
 * It is an addition to the 0.2.0 page, not a replacement: when the daemon has no `/_nema/accounts` route
 * this renders nothing at all, and the four dropdowns above it keep working exactly as they did. A
 * single-account user sees one row that describes the setup they already have.
 *
 * Credentials are write-only here. The page shows a state, never a value, and the key field is cleared as
 * soon as it is sent.
 */

type Kind = "siwc" | "compat" | "byok" | "claude";

type Draft = {
  id?: string;
  name: string;
  kind: Kind;
  baseUrl: string;
  model: string;
  image: "undeclared" | "yes" | "no";
  pdf: "undeclared" | "yes" | "no";
  contextTokens: string;
  costTier: "low" | "standard" | "high";
};

const EMPTY_DRAFT: Draft = {
  name: "",
  kind: "siwc",
  baseUrl: "",
  model: "",
  image: "undeclared",
  pdf: "undeclared",
  contextTokens: "",
  costTier: "standard",
};

/** The four combinations the interface offers, mapped onto the two adapters and three auth modes. */
function kindOf(account: AccountView): Kind {
  if (account.adapter === "claude-code") return "claude";
  return account.authMode ?? "siwc";
}

function draftOf(account: AccountView): Draft {
  return {
    id: account.id,
    name: account.name,
    kind: kindOf(account),
    baseUrl: account.baseUrl ?? "",
    model: account.model ?? "",
    image: account.capabilities?.image === undefined ? "undeclared" : account.capabilities.image ? "yes" : "no",
    pdf: account.capabilities?.pdf === undefined ? "undeclared" : account.capabilities.pdf ? "yes" : "no",
    contextTokens: account.capabilities?.contextTokens === undefined ? "" : String(account.capabilities.contextTokens),
    costTier: account.costTier,
  };
}

/**
 * The body a save sends.
 *
 * Empty fields are **omitted**, never sent as `null`. The stored row schema has `.optional()` on `model`,
 * `capabilities` and `baseUrl` but not `.nullable()`, so a `null` is a validation failure — and since every
 * kind except a keyed account with an endpoint has an empty `baseUrl`, sending `null` made create fail for
 * almost every account. Only the update path needs `null`: that is what clears a field, and `applyPatch`
 * drops it before the row is validated.
 */
function bodyOf(draft: Draft, mode: "create" | "update"): Record<string, unknown> {
  const capabilities: Record<string, unknown> = {};
  if (draft.image !== "undeclared") capabilities.image = draft.image === "yes";
  if (draft.pdf !== "undeclared") capabilities.pdf = draft.pdf === "yes";
  const tokens = draft.contextTokens.trim();
  if (tokens !== "" && /^\d+$/.test(tokens)) capabilities.contextTokens = Number(tokens);

  const model = draft.model.trim();
  const baseUrl = draft.kind === "byok" ? draft.baseUrl.trim() : "";
  const filled: Record<string, unknown> = {
    name: draft.name.trim(),
    adapter: draft.kind === "claude" ? "claude-code" : "codex-direct",
    costTier: draft.costTier,
  };
  if (draft.kind !== "claude") filled.authMode = draft.kind;
  if (model !== "") filled.model = model;
  if (Object.keys(capabilities).length > 0) filled.capabilities = capabilities;
  if (baseUrl !== "") filled.baseUrl = baseUrl;

  if (mode === "create") return filled;
  // An update says "clear this" explicitly, so a field the form left empty loses its stored value. `null`
  // for the fields the new kind does not use is what removes them when the user switches kind: a
  // `claude-code` row may not keep an `authMode`, and a row that is not a keyed account may not keep a
  // `baseUrl`. The server applies the same rule, so an older page cannot leave one behind either.
  return {
    ...filled,
    model: filled.model ?? null,
    capabilities: filled.capabilities ?? null,
    baseUrl: filled.baseUrl ?? null,
    authMode: filled.authMode ?? null,
  };
}

/**
 * The message key for a failure. `ModelSettingsError` is the base class: a network failure throws that, not
 * an `AccountsError`, and it has a code of its own. Checking only the subclass left every
 * `service_unavailable` showing the generic sentence.
 */
function errorKey(error: unknown): string {
  if (error instanceof ModelSettingsError) return `account.error.${error.code}`;
  return "account.error.generic";
}

function Capability({ label, value }: { label: string; value: "undeclared" | "yes" | "no" }) {
  const t = useT();
  // Three labels, not two: "not declared" is not "not supported", and the automatic choice relies on it.
  return <span className="kmeta">{t(label)}: {t(`account.cap.${value}`)}</span>;
}

export function AccountSettings({ onChanged }: { onChanged?: () => void }) {
  const t = useT();
  const [state, setState] = useState<AccountsList | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [secretFor, setSecretFor] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  /** Re-reads the list after a mutation. The first read is the effect below, which does its own chaining. */
  const reload = useCallback(async () => {
    try {
      setState(await accountsApi.list());
      setUnsupported(false);
      setError(null);
    } catch (e: unknown) {
      if (e instanceof AccountsUnsupportedError) {
        // An older daemon: hide the block and leave the rest of the page exactly as it was.
        setUnsupported(true);
        return;
      }
      setError(errorKey(e));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // State is set when the answer arrives, never while the effect body runs.
    accountsApi.list(controller.signal).then((list) => {
      if (controller.signal.aborted) return;
      setState(list);
      setUnsupported(false);
      setError(null);
    }).catch((e: unknown) => {
      if (controller.signal.aborted) return;
      if (e instanceof AccountsUnsupportedError) {
        setUnsupported(true);
        return;
      }
      setError(errorKey(e));
    });
    return () => controller.abort();
  }, []);

  if (unsupported) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = draft.id
        ? await accountsApi.update({ ...bodyOf(draft, "update"), id: draft.id })
        : await accountsApi.create(bodyOf(draft, "create") as AccountCreate);
      setDraft(null);
      setNotice("account.saved");
      // A key account is only usable once its key is saved, so the field appears right away.
      const saved = result.account;
      setSecretFor(saved.adapter === "claude-code" || saved.authMode === "byok" ? saved.id : null);
      await reload();
      onChanged?.();
    } catch (e: unknown) {
      setError(errorKey(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveSecret(id: string, kind: "byok" | "claude") {
    const value = secret;
    setSecret("");
    setError(null);
    setNotice(null);
    try {
      await accountsApi.saveSecret(id, kind, value);
      setNotice("account.secretSaved");
      await reload();
      onChanged?.();
    } catch (e: unknown) {
      setError(errorKey(e));
    }
  }

  async function remove(id: string) {
    setError(null);
    setNotice(null);
    setRowError(null);
    try {
      await accountsApi.remove(id);
      setConfirming(null);
      setNotice("account.saved");
      await reload();
      onChanged?.();
    } catch (e: unknown) {
      // `account_in_use` names the scopes that still point here; showing them is the only useful answer.
      if (e instanceof AccountsError && e.code === "account_in_use") {
        setRowError({ id, message: t("account.inUse", { scopes: (e.bindings ?? []).join(", ") }) });
        return;
      }
      setRowError({ id, message: t(errorKey(e)) });
    }
  }

  async function startLogin(id: string) {
    setError(null);
    setNotice(null);
    try {
      await accountsApi.login(id);
      setNotice("account.loginStarted");
    } catch (e: unknown) {
      setError(errorKey(e));
    }
  }

  if (state === null) {
    if (error) return <section className="account-settings settings-group"><p className="error" role="alert">{t(error)}</p></section>;
    return null;
  }

  const unavailable = state.unusableReason !== undefined;

  return (
    <section className="account-settings settings-group" aria-label={t("account.title")}>
      <h2 className="label">{t("account.title")}</h2>
      <p className="help">{t("account.help")}</p>
      {error && <p className="error" role="alert">{t(error)}</p>}
      {notice && <p className="notice" role="status">{t(notice)}</p>}

      {unavailable ? (
        <p className="error" role="alert">{t("account.unusable", { reason: state.unusableReason ?? "" })}</p>
      ) : (
        <>
          <ul className="account-list">
            {(state.accounts ?? []).map((account) => {
              const kind = kindOf(account);
              const isDefault = account.id === state.defaultAccountId;
              // The synthesized account has no stored row, so none of the routes can address it: the id it
              // carries is the reserved one, which `requestId` refuses, so a login, save, edit or delete
              // here could only ever come back "not found". The row describes the setup the user already
              // has; the provider controls above it are where that setup is changed, and "Add account" is
              // how they leave it behind.
              const readOnly = account.implicit;
              return (
                <li key={account.id} className="account-row" data-testid="account-row">
                  <div className="bar">
                    <b>{account.name}</b>
                    {isDefault && <span className="kmeta">{t("account.default")}</span>}
                    {account.implicit && <span className="kmeta">{t("account.implicit")}</span>}
                    <span className="kmeta">{t(`account.kind.${kind}`)}</span>
                  </div>
                  {kind === "byok" && account.baseUrl && <p className="kmeta">{account.baseUrl}</p>}
                  {account.model && <p className="kmeta">{t("account.model")}: {account.model}</p>}
                  <p className="kmeta" role="status">{t(`account.credential.${account.credential}`)}</p>
                  <p className="kmeta account-caps">
                    <Capability label="account.cap.image" value={account.capabilities?.image === undefined ? "undeclared" : account.capabilities.image ? "yes" : "no"} />
                    {" · "}
                    <Capability label="account.cap.pdf" value={account.capabilities?.pdf === undefined ? "undeclared" : account.capabilities.pdf ? "yes" : "no"} />
                    {account.capabilities?.contextTokens !== undefined && <> · {t("account.cap.context")}: {account.capabilities.contextTokens}</>}
                  </p>
                  <p className="kmeta">{t("account.costTier")}: {t(`account.costTier.${account.costTier}`)}</p>

                  {kind === "compat" && <p className="help">{t("account.compatHelp")}</p>}
                  {kind === "siwc" && !readOnly && (
                    <button type="button" onClick={() => void startLogin(account.id)}>{t("account.login")}</button>
                  )}
                  {(kind === "byok" || kind === "claude") && !readOnly && (
                    <div className="field">
                      <label className="label" htmlFor={`account-secret-${account.id}`}>
                        {t(kind === "byok" ? "account.keyLabel" : "account.tokenLabel")}
                      </label>
                      <input
                        id={`account-secret-${account.id}`}
                        type="password"
                        autoComplete="new-password"
                        placeholder={t("account.keyPlaceholder")}
                        value={secretFor === account.id ? secret : ""}
                        onChange={(e) => {
                          setSecretFor(account.id);
                          setSecret(e.target.value);
                        }}
                      />
                      <button
                        type="button"
                        disabled={secretFor !== account.id || secret === ""}
                        onClick={() => void saveSecret(account.id, kind)}
                      >
                        {t("account.saveSecret")}
                      </button>
                    </div>
                  )}

                  {!readOnly && (
                    <div className="account-actions">
                      <button type="button" onClick={() => setDraft(draftOf(account))}>{t("account.edit")}</button>
                      {confirming === account.id ? (
                        <>
                          <button type="button" onClick={() => void remove(account.id)}>{t("account.deleteConfirm")}</button>
                          <button type="button" onClick={() => setConfirming(null)}>{t("account.cancel")}</button>
                        </>
                      ) : (
                        <button type="button" onClick={() => setConfirming(account.id)}>{t("account.delete")}</button>
                      )}
                    </div>
                  )}
                  {rowError?.id === account.id && <p className="error" role="alert">{rowError.message}</p>}
                </li>
              );
            })}
          </ul>

          {draft ? (
            <form className="editform account-form" onSubmit={submit}>
              <label className="field"><span className="label">{t("account.name")}</span>
                <input aria-label={t("account.name")} type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="field"><span className="label">{t("account.kind")}</span>
                <select aria-label={t("account.kind")} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind })}>
                  <option value="siwc">{t("account.kind.siwc")}</option>
                  <option value="compat">{t("account.kind.compat")}</option>
                  <option value="byok">{t("account.kind.byok")}</option>
                  <option value="claude">{t("account.kind.claude")}</option>
                </select>
              </label>
              {draft.kind === "byok" && <label className="field"><span className="label">{t("account.baseUrl")}</span>
                <input aria-label={t("account.baseUrl")} type="text" inputMode="url" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
              </label>}
              <label className="field"><span className="label">{t("account.model")}</span>
                <input aria-label={t("account.model")} type="text" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
                <span className="help">{t("account.modelHelp")}</span>
              </label>

              <fieldset className="field">
                <legend className="label">{t("account.capabilities")}</legend>
                {(["image", "pdf"] as const).map((capability) => (
                  <label key={capability} className="field">
                    <span className="label">{t(`account.cap.${capability}`)}</span>
                    <select
                      aria-label={t(`account.cap.${capability}`)}
                      value={draft[capability]}
                      onChange={(e) => setDraft({ ...draft, [capability]: e.target.value as Draft["image"] })}
                    >
                      <option value="undeclared">{t("account.cap.undeclared")}</option>
                      <option value="yes">{t("account.cap.yes")}</option>
                      <option value="no">{t("account.cap.no")}</option>
                    </select>
                  </label>
                ))}
                <label className="field"><span className="label">{t("account.cap.context")}</span>
                  <input aria-label={t("account.cap.context")} type="text" inputMode="numeric" value={draft.contextTokens} onChange={(e) => setDraft({ ...draft, contextTokens: e.target.value })} />
                </label>
              </fieldset>

              <label className="field"><span className="label">{t("account.costTier")}</span>
                <select aria-label={t("account.costTier")} value={draft.costTier} onChange={(e) => setDraft({ ...draft, costTier: e.target.value as Draft["costTier"] })}>
                  <option value="low">{t("account.costTier.low")}</option>
                  <option value="standard">{t("account.costTier.standard")}</option>
                  <option value="high">{t("account.costTier.high")}</option>
                </select>
                <span className="help">{t("account.costTierHelp")}</span>
              </label>

              <div className="account-actions">
                <button type="submit" className="primary" disabled={saving}>{saving ? t("account.saving") : t("account.save")}</button>
                <button type="button" onClick={() => setDraft(null)}>{t("account.cancel")}</button>
              </div>
            </form>
          ) : (
            <button type="button" onClick={() => setDraft({ ...EMPTY_DRAFT })}>{t("account.add")}</button>
          )}
        </>
      )}
    </section>
  );
}
