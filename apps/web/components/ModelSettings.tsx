"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ModelSettingsError, modelSettingsApi, validateByokBaseUrl, type AuthJob, type ModelSettingsDto, type ModelsCatalog, type SettingMode, type SettingsPatch } from "@/lib/modelSettings";
import { useT } from "@/lib/i18n";

const JOB_POLL_MS = 800;
const CLAUDE_MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable", "best", "opusplan"] as const;

function modeFor(settings: ModelSettingsDto): SettingMode {
  return settings.config.adapter === "claude-code" ? "claude" : settings.config.authMode;
}

function errorKey(error: unknown): string {
  const code = error instanceof ModelSettingsError ? error.code : "service_unavailable";
  return `model.error.${code}`;
}

function credentialKind(mode: SettingMode): "siwc" | "compat" | "byok" | "claude" {
  return mode === "claude" ? "claude" : mode;
}

function credentialState(settings: ModelSettingsDto, mode: SettingMode): "connected" | "missing" | "unusable" {
  const recorded = settings.credentials?.[credentialKind(mode)];
  if (recorded) return recorded;
  return modeFor(settings) === mode ? settings.auth.state : "missing";
}

export function ModelSettings({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [settings, setSettings] = useState<ModelSettingsDto | null>(null);
  const [mode, setMode] = useState<SettingMode>("siwc");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelsUnavailable, setModelsUnavailable] = useState<ModelsCatalog["unavailable"]>(undefined);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [effort, setEffort] = useState<"low" | "medium" | "high">("medium");
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [quotaConfirmed, setQuotaConfirmed] = useState(false);
  const [job, setJob] = useState<AuthJob | null>(null);
  const [authStatusLoaded, setAuthStatusLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const refreshController = useRef<AbortController | null>(null);
  const pollFailures = useRef(0);

  async function refreshSettings() {
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    try {
      setSettings(await modelSettingsApi.read(controller.signal));
    } catch (e: unknown) {
      if (!controller.signal.aborted) setError(errorKey(e));
    }
  }

  useEffect(() => () => refreshController.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    let retryTimer: number | undefined;
    let failures = 0;
    void modelSettingsApi.read(controller.signal).then((value) => {
      if (!live) return;
      setSettings(value);
      setMode(modeFor(value));
      setEffort(value.config.reasoningEffort);
      setBaseUrl(value.config.byokBaseUrl ?? "");
      if (value.config.adapter === "claude-code") setModel(value.config.model ?? "");

      const loadStatus = () => {
        void modelSettingsApi.status(controller.signal).then((nextJob) => {
          if (!live) return;
          failures = 0;
          setStatusError(null);
          setJob(nextJob);
          setAuthStatusLoaded(true);
          if (nextJob.state === "succeeded") void refreshSettings();
        }).catch((e: unknown) => {
          if (!live || controller.signal.aborted) return;
          setStatusError(errorKey(e));
          failures += 1;
          retryTimer = window.setTimeout(loadStatus, Math.min(JOB_POLL_MS * 2 ** failures, 8_000));
        });
      };
      loadStatus();
    }).catch((e: unknown) => {
      if (!controller.signal.aborted) setError(errorKey(e));
    });
    return () => {
      live = false;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      controller.abort();
    };
  }, []);

  const catalogKey = settings && settings.config.adapter === "codex-direct" && settings.auth.state === "connected"
    ? `${settings.config.authMode}\n${settings.config.byokBaseUrl ?? ""}`
    : "";
  const [catalogSeen, setCatalogSeen] = useState(catalogKey);
  if (catalogKey !== catalogSeen) {
    setCatalogSeen(catalogKey);
    setModels([]);
    setModelsUnavailable(undefined);
    setModelsLoaded(false);
    setModel(settings?.config.adapter === "claude-code" ? (settings.config.model ?? "") : "");
  }

  useEffect(() => {
    if (!catalogKey || !settings) return;
    const controller = new AbortController();
    const savedModel = settings.config.model ?? "";
    void modelSettingsApi.models(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      const list = Array.isArray(result.models) ? result.models.filter((id) => id !== "") : [];
      setModels(list);
      setModelsUnavailable(result.unavailable);
      setModelsLoaded(true);
      setModel(list.includes(savedModel) ? savedModel : "");
    }).catch(() => {
      if (controller.signal.aborted) return;
      setModels([]);
      setModelsUnavailable("list_failed");
      setModelsLoaded(true);
      setModel("");
    });
    return () => controller.abort();
  }, [catalogKey, settings]);

  useEffect(() => {
    if (!job || (job.state !== "running" && job.state !== "cancelling")) return;
    const controller = new AbortController();
    let retryTimer: number | undefined;
    const timer = window.setTimeout(() => {
      void modelSettingsApi.status(controller.signal).then(async (nextJob) => {
        pollFailures.current = 0;
        setStatusError(null);
        setJob(nextJob);
        if (nextJob.state === "succeeded") void refreshSettings();
      }).catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setStatusError(errorKey(e));
          pollFailures.current += 1;
          const delay = Math.min(JOB_POLL_MS * 2 ** pollFailures.current, 8_000);
          retryTimer = window.setTimeout(() => setJob((current) => current ? { ...current } : current), delay);
        }
      });
    }, JOB_POLL_MS);
    return () => {
      window.clearTimeout(timer);
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      controller.abort();
    };
  }, [job, authStatusLoaded]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setError(null);
    setNotice(null);
    if (mode === "byok" && !validateByokBaseUrl(baseUrl)) {
      setError("model.error.invalidBaseUrl");
      return;
    }
    const patch: SettingsPatch = {
      adapter: mode === "claude" ? "claude-code" : "codex-direct",
      authMode: mode === "claude" ? settings.config.authMode : mode,
      byokBaseUrl: mode === "byok" ? baseUrl.trim() || null : settings.config.byokBaseUrl ?? null,
    };
    setSaving(true);
    try {
      await modelSettingsApi.patch(patch);
      const next = await modelSettingsApi.read();
      setSettings(next);
      setMode(modeFor(next));
      setEffort(next.config.reasoningEffort);
      setBaseUrl(next.config.byokBaseUrl ?? "");
      setNotice("model.saved");
    } catch (e: unknown) {
      setError(errorKey(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveModel(e: FormEvent) {
    e.preventDefault();
    if (!settings || !providerSaved) return;
    setError(null);
    setNotice(null);
    const patch: SettingsPatch = { reasoningEffort: effort };
    if (settings.config.adapter === "claude-code") {
      if ((model || null) !== (settings.config.model ?? null)) patch.model = model || null;
    } else if (model) {
      patch.model = model;
    }
    setSavingModel(true);
    try {
      await modelSettingsApi.patch(patch);
      const next = await modelSettingsApi.read();
      setSettings(next);
      setEffort(next.config.reasoningEffort);
      if (next.config.adapter === "claude-code") setModel(next.config.model ?? "");
      setNotice("model.modelSaved");
    } catch (e: unknown) {
      setError(errorKey(e));
    } finally {
      setSavingModel(false);
    }
  }

  async function applyProvider(next: SettingMode) {
    setMode(next);
    setSecret("");
    setQuotaConfirmed(false);
    setError(null);
    setNotice(null);
    if (!settings || saving || isBusy) return;
    if (modeFor(settings) === next && (next !== "byok" || baseUrl.trim() === (settings.config.byokBaseUrl ?? ""))) return;
    const patch: SettingsPatch = {
      adapter: next === "claude" ? "claude-code" : "codex-direct",
      authMode: next === "claude" ? settings.config.authMode : next,
      byokBaseUrl: next === "byok"
        ? (validateByokBaseUrl(baseUrl) && baseUrl.trim() !== "" ? baseUrl.trim() : settings.config.byokBaseUrl ?? null)
        : settings.config.byokBaseUrl ?? null,
    };
    setSaving(true);
    try {
      await modelSettingsApi.patch(patch);
      const refreshed = await modelSettingsApi.read();
      setSettings(refreshed);
      setMode(modeFor(refreshed));
      setEffort(refreshed.config.reasoningEffort);
      setBaseUrl(refreshed.config.byokBaseUrl ?? "");
    } catch (e: unknown) {
      setMode(modeFor(settings));
      setError(errorKey(e));
    } finally {
      setSaving(false);
    }
  }

  async function saveSecret(kind: "byok" | "claude") {
    const value = secret;
    setSecret("");
    setError(null);
    setNotice(null);
    try {
      await modelSettingsApi.saveSecret(kind, value);
      if (settings) {
        setSettings({ ...settings, auth: { ...settings.auth, state: "connected" } });
      }
      setNotice("model.secretSaved");
    } catch (e: unknown) {
      setError(errorKey(e));
    } finally {
      setSecret("");
    }
  }

  async function startLogin() {
    setError(null);
    setNotice(null);
    try {
      await modelSettingsApi.login();
      setJob({ state: "running", error: null });
    } catch (e: unknown) {
      setError(errorKey(e));
    }
  }

  async function cancelLogin() {
    setError(null);
    try {
      setJob(await modelSettingsApi.cancel());
    } catch (e: unknown) {
      setError(errorKey(e));
    }
  }

  async function probe() {
    setError(null);
    setNotice(null);
    try {
      await modelSettingsApi.probe();
      setJob({ state: "running", error: null });
    } catch (e: unknown) {
      setError(errorKey(e));
    }
  }

  async function logout() {
    if (!settings) return;
    setError(null);
    setNotice(null);
    try {
      const kind = credentialKind(mode);
      const { loggedOut } = await modelSettingsApi.logout(kind);
      if (loggedOut) {
        setSettings({
          ...settings,
          credentials: { ...settings.credentials, [kind]: "missing" },
          auth: settings.auth.credential === kind ? { ...settings.auth, state: "missing" } : settings.auth,
        });
      }
      setNotice(loggedOut ? "model.loggedOut" : "model.compatLogoutNoop");
    } catch (e: unknown) {
      setError(errorKey(e));
    }
  }

  const isBusy = job?.state === "running" || job?.state === "cancelling";
  const secretKind = mode === "byok" ? "byok" : "claude";
  const secretLabel = mode === "byok" ? "model.byokKey" : "model.claudeToken";
  const canLogin = mode === "siwc" || mode === "compat";
  const modeSaved = !!settings && modeFor(settings) === mode;
  const providerSaved = modeSaved && !!settings
    && (mode !== "byok" || baseUrl.trim() === (settings.config.byokBaseUrl ?? ""));
  const providerReady = providerSaved && !saving && !isBusy;
  const addressDirty = !!settings && mode === "byok" && baseUrl.trim() !== (settings.config.byokBaseUrl ?? "");
  const selectedAuth = settings ? credentialState(settings, mode) : "missing";
  const savedModel = settings?.config.model ?? "";
  const claudeSaved = !!settings && settings.config.adapter === "claude-code";
  const modelDirty = !!settings && (
    effort !== settings.config.reasoningEffort
    || (claudeSaved ? model !== savedModel : model !== "" && model !== savedModel)
  );
  const showModelList = !!settings && settings.config.adapter === "codex-direct";
  const claudeModels = savedModel && !CLAUDE_MODEL_ALIASES.includes(savedModel as typeof CLAUDE_MODEL_ALIASES[number])
    ? [savedModel, ...CLAUDE_MODEL_ALIASES]
    : [...CLAUDE_MODEL_ALIASES];
  const modelHelp = !providerSaved
    ? "model.models.saveProvider"
    : settings?.config.adapter === "claude-code"
      ? null
      : settings?.auth.state !== "connected"
        ? "model.models.connectFirst"
        : modelsUnavailable === "list_failed" || modelsUnavailable === "not_applicable"
          ? "model.models.listFailed"
          : modelsUnavailable === "not_connected"
            ? "model.models.connectFirst"
            : modelsLoaded && models.length === 0
              ? "model.models.empty"
              : savedModel && !models.includes(savedModel)
                ? "model.modelNotListed"
                : null;
  const jobMessage = job?.state === "running" ? "model.job.running"
    : job?.state === "cancelling" ? "model.job.cancelling"
      : job?.state === "cancelled" ? "model.job.cancelled"
        : job?.state === "failed" ? (job.error === "probe_failed" ? "model.job.probeFailed" : "model.job.loginFailed")
          : job?.state === "succeeded" ? "model.job.succeeded" : null;

  return (
    <aside className="drawer model-settings" role="dialog" aria-label={t("model.title")}>
      <div className="bar">
        <h1>{t("model.title")}</h1>
        <button type="button" className="sp link" onClick={onClose}>{t("common.close")}</button>
      </div>
      <div className="drawer-body">
        {error && <p className="error" role="alert">{t(error)}</p>}
        {statusError && <p className="error" role="alert">{t(statusError)}</p>}
        {notice && <p className="notice" role="status">{t(notice)}</p>}
        {!settings && !error && !statusError && <p className="kmeta">{t("common.loading")}</p>}
        {settings && <>
          <form className="editform" onSubmit={saveModel}>
            <h2 className="label">{t("model.modelChoice")}</h2>
            {showModelList && <label className="field">
              <select aria-label={t("model.modelChoice")} value={model} disabled={!providerSaved || settings.auth.state !== "connected" || models.length === 0 || saving || savingModel || isBusy} onChange={(e) => setModel(e.target.value)}>
                <option value="" disabled>{t("model.modelPick")}</option>
                {models.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>}
            {claudeSaved && <label className="field">
              <select aria-label={t("model.modelChoice")} value={model} disabled={!providerSaved || saving || savingModel || isBusy} onChange={(e) => setModel(e.target.value)}>
                <option value="">{t("model.claude.default")}</option>
                {claudeModels.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
            </label>}
            {modelHelp && <p className="help">{modelHelp === "model.modelNotListed" ? t(modelHelp, { id: savedModel }) : t(modelHelp)}</p>}
            <label className="field"><span className="label">{t("model.reasoning")}</span>
              <select aria-label={t("model.reasoning")} disabled={!providerSaved || saving || savingModel || isBusy} value={effort} onChange={(e) => setEffort(e.target.value as "low" | "medium" | "high")}>
                <option value="low">{t("model.effort.low")}</option>
                <option value="medium">{t("model.effort.medium")}</option>
                <option value="high">{t("model.effort.high")}</option>
              </select>
            </label>
            <button type="submit" disabled={!providerSaved || !modelDirty || saving || savingModel || isBusy}>{savingModel ? t("model.savingModel") : t("model.saveModel")}</button>
          </form>

          <form className="editform model-block" onSubmit={save}>
            <h2 className="label">{t("model.provider")}</h2>
            <label className="field"><span className="label">{t("model.service")}</span>
              <select aria-label={t("model.service")} value={mode === "claude" ? "claude" : mode === "byok" ? "api" : "chatgpt"} disabled={saving || isBusy} onChange={(e) => void applyProvider(e.target.value === "claude" ? "claude" : e.target.value === "api" ? "byok" : "siwc")}>
                <option value="chatgpt">{t("model.service.chatgpt")}</option>
                <option value="claude">{t("model.service.claude")}</option>
                <option value="api">{t("model.service.api")}</option>
              </select>
            </label>
            {(mode === "siwc" || mode === "compat") && <label className="field"><span className="label">{t("model.signin")}</span>
              <select aria-label={t("model.signin")} value={mode === "compat" ? "codex" : "browser"} disabled={saving || isBusy} onChange={(e) => void applyProvider(e.target.value === "codex" ? "compat" : "siwc")}>
                <option value="browser">{t("model.signin.browser")}</option><option value="codex">{t("model.signin.codex")}</option>
              </select>
            </label>}
            {mode === "compat" && <p className="help">{t("model.compatHelp")}</p>}
            {mode === "claude" && <p className="help">{settings.tools.claude.available ? t("model.claudeAvailable") : t("model.claudeUnavailable")}</p>}
            {mode === "byok" && <label className="field"><span className="label">{t("model.baseUrl")}</span>
              <input aria-label={t("model.baseUrl")} type="text" inputMode="url" value={baseUrl} disabled={saving || isBusy} onChange={(e) => setBaseUrl(e.target.value)} aria-invalid={error === "model.error.invalidBaseUrl"} />
              <span className="help">{t("model.baseUrlHelp")}</span>
            </label>}
            <button type="submit" className="primary" disabled={saving || isBusy}>{saving ? t("model.saving") : t("model.save")}</button>
          </form>

          <section className="model-block" aria-label={t("model.authentication")}>
            <h2 className="label">{t("model.authentication")}</h2>
            <p className="kmeta" role="status">{t(`model.auth.${selectedAuth}`)}</p>
            <p className="help">{t("model.auth.independent")}</p>
            {addressDirty && <p className="help">{t("model.saveBeforeAuth")}</p>}
            {canLogin &&
              <button type="button" onClick={() => void startLogin()} disabled={!authStatusLoaded || !providerReady || addressDirty || isBusy}>{t("model.login")}</button>
            }
            {isBusy && <button type="button" onClick={() => void cancelLogin()}>{t("model.cancelTask")}</button>}
            {mode === "byok" || mode === "claude" ? <div className="field">
              <label className="label" htmlFor="model-secret">{t(secretLabel)}</label>
              <input id="model-secret" type="password" autoComplete="new-password" disabled={saving || isBusy} value={secret} onChange={(e) => setSecret(e.target.value)} />
              <button type="button" disabled={!secret || saving || isBusy} onClick={() => void saveSecret(secretKind)}>{t("model.saveSecret")}</button>
            </div> : null}
            {selectedAuth === "connected" && <button type="button" onClick={() => void logout()}>{t("model.logout")}</button>}
            {mode === "claude" && <p className="help">{t("model.claudeProbeUnsupported")}</p>}
            {mode !== "claude" && <div className="field">
              <label className="check"><input type="checkbox" checked={quotaConfirmed} disabled={saving} onChange={(e) => setQuotaConfirmed(e.target.checked)} />{t("model.quotaConfirm")}</label>
              <p className="help">{t("model.quotaHelp")}</p>
              <button type="button" disabled={!authStatusLoaded || !quotaConfirmed || !providerReady || addressDirty || isBusy} onClick={() => void probe()}>{t("model.probe")}</button>
            </div>}
            {jobMessage && <p role="status">{t(jobMessage)}</p>}
          </section>

        </>}
      </div>
    </aside>
  );
}
