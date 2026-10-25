"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ModelSettingsError, modelSettingsApi, validateByokBaseUrl, type AuthJob, type ModelSettingsDto, type SettingMode, type SettingsPatch } from "@/lib/modelSettings";
import { useT } from "@/lib/i18n";

const JOB_POLL_MS = 800;

function modeFor(settings: ModelSettingsDto): SettingMode {
  return settings.config.adapter === "claude-code" ? "claude" : settings.config.authMode;
}

function errorKey(error: unknown): string {
  const code = error instanceof ModelSettingsError ? error.code : "service_unavailable";
  return `model.error.${code}`;
}

function savedConnectionKey(mode: SettingMode): string {
  switch (mode) {
    case "siwc": return "model.connection.chatgptBrowser";
    case "compat": return "model.connection.chatgptCodex";
    case "byok": return "model.connection.apiKey";
    case "claude": return "model.connection.claude";
  }
}

export function ModelSettings({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [settings, setSettings] = useState<ModelSettingsDto | null>(null);
  const [mode, setMode] = useState<SettingMode>("siwc");
  const [customModel, setCustomModel] = useState(false);
  const [model, setModel] = useState("");
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
      setModel(value.config.model ?? "");
      setCustomModel(!!value.config.model);
      setEffort(value.config.reasoningEffort);
      setBaseUrl(value.config.byokBaseUrl ?? "");

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
      reasoningEffort: effort,
      model: customModel ? model : null,
      byokBaseUrl: mode === "byok" ? baseUrl.trim() || null : settings.config.byokBaseUrl ?? null,
    };
    setSaving(true);
    try {
      await modelSettingsApi.patch(patch);
      const next = await modelSettingsApi.read();
      setSettings(next);
      setMode(modeFor(next));
      setModel(next.config.model ?? "");
      setCustomModel(!!next.config.model);
      setEffort(next.config.reasoningEffort);
      setBaseUrl(next.config.byokBaseUrl ?? "");
      setNotice("model.saved");
    } catch (e: unknown) {
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
      const { loggedOut } = await modelSettingsApi.logout(settings.auth.credential);
      if (loggedOut) setSettings({ ...settings, auth: { ...settings.auth, state: "missing" } });
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
  const configSaved = modeSaved && !!settings
    && effort === settings.config.reasoningEffort
    && (customModel ? model : null) === (settings.config.model ?? null)
    && (mode !== "byok" || baseUrl.trim() === (settings.config.byokBaseUrl ?? ""));
  const configReady = configSaved && !saving && !isBusy;
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
          <form className="editform" onSubmit={save}>
            <label className="field"><span className="label">{t("model.agent")}</span>
              <select aria-label={t("model.agent")} value={mode === "claude" ? "claude" : "nema"} disabled={saving || isBusy} onChange={(e) => { setMode(e.target.value === "claude" ? "claude" : "siwc"); setSecret(""); setQuotaConfirmed(false); setError(null); }}>
                <option value="nema">{t("model.agent.nema")}</option><option value="claude">{t("model.agent.claude")}</option>
              </select>
            </label>
            {mode !== "claude" && <>
            <label className="field"><span className="label">{t("model.service")}</span>
              <select aria-label={t("model.service")} value={mode === "byok" ? "api" : "chatgpt"} disabled={saving || isBusy} onChange={(e) => { setMode(e.target.value === "api" ? "byok" : "siwc"); setSecret(""); setQuotaConfirmed(false); setError(null); }}>
                <option value="chatgpt">{t("model.service.chatgpt")}</option><option value="api">{t("model.service.api")}</option>
              </select>
            </label>
            {mode !== "byok" && <label className="field"><span className="label">{t("model.signin")}</span>
              <select aria-label={t("model.signin")} value={mode === "compat" ? "codex" : "browser"} disabled={saving || isBusy} onChange={(e) => { setMode(e.target.value === "codex" ? "compat" : "siwc"); setSecret(""); setQuotaConfirmed(false); setError(null); }}>
                <option value="browser">{t("model.signin.browser")}</option><option value="codex">{t("model.signin.codex")}</option>
              </select>
            </label>}
            {mode === "compat" && <p className="help">{t("model.compatHelp")}</p>}
            </>}
            {mode === "claude" && <p className="help">{settings.tools.claude.available ? t("model.claudeAvailable") : t("model.claudeUnavailable")}</p>}
            <label className="field"><span className="label">{t("model.modelChoice")}</span>
              <select aria-label={t("model.modelChoice")} value={customModel ? "custom" : "default"} disabled={saving || isBusy} onChange={(e) => setCustomModel(e.target.value === "custom")}>
                <option value="default">{t("model.modelDefault")}</option><option value="custom">{t("model.modelCustom")}</option>
              </select>
              <span className="help">{t("model.modelHelp")}</span>
            </label>
            {customModel && <label className="field"><span className="label">{t("model.modelId")}</span>
              <input aria-label={t("model.modelId")} value={model} disabled={saving || isBusy} onChange={(e) => setModel(e.target.value)} />
            </label>
            }
            <label className="field"><span className="label">{t("model.reasoning")}</span>
              <select aria-label={t("model.reasoning")} disabled={saving || isBusy} value={effort} onChange={(e) => setEffort(e.target.value as "low" | "medium" | "high")}>
                <option value="low">{t("model.effort.low")}</option>
                <option value="medium">{t("model.effort.medium")}</option>
                <option value="high">{t("model.effort.high")}</option>
              </select>
            </label>
            {mode === "byok" && <label className="field"><span className="label">{t("model.baseUrl")}</span>
              <input aria-label={t("model.baseUrl")} type="text" inputMode="url" value={baseUrl} disabled={saving || isBusy} onChange={(e) => setBaseUrl(e.target.value)} aria-invalid={error === "model.error.invalidBaseUrl"} />
              <span className="help">{t("model.baseUrlHelp")}</span>
            </label>}
            <button type="submit" className="primary" disabled={saving || isBusy}>{saving ? t("model.saving") : t("model.save")}</button>
          </form>

          <section className="model-block" aria-label={t("model.authentication")}>
            <h2 className="label">{t("model.authentication")}</h2>
            <p className="kmeta" role="status">{configSaved ? t(`model.auth.${settings.auth.state}`) : t("model.auth.savedConfigStatus", { mode: t(savedConnectionKey(modeFor(settings))) })}</p>
            {!configReady && <p className="help">{t("model.saveBeforeAuth")}</p>}
            {canLogin &&
              <button type="button" onClick={() => void startLogin()} disabled={!authStatusLoaded || !configReady || isBusy}>{t("model.login")}</button>
            }
            {isBusy && <button type="button" onClick={() => void cancelLogin()}>{t("model.cancelTask")}</button>}
            {mode === "byok" || mode === "claude" ? <div className="field">
              <label className="label" htmlFor="model-secret">{t(secretLabel)}</label>
              <input id="model-secret" type="password" autoComplete="new-password" disabled={saving || isBusy} value={secret} onChange={(e) => setSecret(e.target.value)} />
              <button type="button" disabled={!secret || !configReady} onClick={() => void saveSecret(secretKind)}>{t("model.saveSecret")}</button>
            </div> : null}
            {configReady && settings.auth.state === "connected" && <button type="button" onClick={() => void logout()}>{t("model.logout")}</button>}
            {mode === "claude" && <p className="help">{t("model.claudeProbeUnsupported")}</p>}
            {mode !== "claude" && <div className="field">
              <label className="check"><input type="checkbox" checked={quotaConfirmed} disabled={saving} onChange={(e) => setQuotaConfirmed(e.target.checked)} />{t("model.quotaConfirm")}</label>
              <p className="help">{t("model.quotaHelp")}</p>
              <button type="button" disabled={!authStatusLoaded || !quotaConfirmed || !configReady || isBusy} onClick={() => void probe()}>{t("model.probe")}</button>
            </div>}
            {jobMessage && <p role="status">{t(jobMessage)}</p>}
          </section>

        </>}
      </div>
    </aside>
  );
}
