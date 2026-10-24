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

export function ModelSettings({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [settings, setSettings] = useState<ModelSettingsDto | null>(null);
  const [mode, setMode] = useState<SettingMode>("siwc");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<"low" | "medium" | "high">("medium");
  const [baseUrl, setBaseUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [githubSecret, setGithubSecret] = useState("");
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
      model: model.trim() || null,
      byokBaseUrl: mode === "byok" ? baseUrl.trim() || null : settings.config.byokBaseUrl ?? null,
    };
    setSaving(true);
    try {
      await modelSettingsApi.patch(patch);
      const next = await modelSettingsApi.read();
      setSettings(next);
      setMode(modeFor(next));
      setModel(next.config.model ?? "");
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

  async function saveGithubSecret() {
    const value = githubSecret;
    setGithubSecret("");
    setError(null);
    try {
      await modelSettingsApi.saveSecret("github", value);
      if (settings) setSettings({ ...settings, tools: { ...settings.tools, github: { ...settings.tools.github, tokenSaved: true } } });
      setNotice("model.secretSaved");
    } catch (e: unknown) {
      setError(errorKey(e));
    } finally {
      setGithubSecret("");
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

  async function logoutGithub() {
    if (!settings) return;
    setError(null);
    setNotice(null);
    try {
      await modelSettingsApi.logout("github");
      setSettings({ ...settings, tools: { ...settings.tools, github: { ...settings.tools.github, tokenSaved: false } } });
      setNotice("model.githubLoggedOut");
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
    && model.trim() === (settings.config.model ?? "")
    && (mode !== "byok" || baseUrl.trim() === (settings.config.byokBaseUrl ?? ""));
  const configReady = configSaved && !saving;
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
            <fieldset className="field">
              <legend className="label">{t("model.mode")}</legend>
              {(["siwc", "compat", "byok", "claude"] as const).map((choice) => (
                <label className="check" key={choice}>
                  <input type="radio" name="modelMode" checked={mode === choice} disabled={saving} onChange={() => { setMode(choice); setSecret(""); setError(null); }} />
                  <span>{t(`model.mode.${choice}`)}</span>
                </label>
              ))}
              {mode === "compat" && <p className="help">{t("model.compatHelp")}</p>}
            </fieldset>
            <label className="field"><span className="label">{t("model.model")}</span>
              <input aria-label={t("model.model")} value={model} disabled={saving} onChange={(e) => setModel(e.target.value)} />
            </label>
            <label className="field"><span className="label">{t("model.reasoning")}</span>
              <select aria-label={t("model.reasoning")} disabled={saving} value={effort} onChange={(e) => setEffort(e.target.value as "low" | "medium" | "high")}>
                <option value="low">{t("model.effort.low")}</option>
                <option value="medium">{t("model.effort.medium")}</option>
                <option value="high">{t("model.effort.high")}</option>
              </select>
            </label>
            {mode === "byok" && <label className="field"><span className="label">{t("model.baseUrl")}</span>
              <input aria-label={t("model.baseUrl")} type="text" inputMode="url" value={baseUrl} disabled={saving} onChange={(e) => setBaseUrl(e.target.value)} aria-invalid={error === "model.error.invalidBaseUrl"} />
              <span className="help">{t("model.baseUrlHelp")}</span>
            </label>}
            <button type="submit" className="primary" disabled={saving}>{saving ? t("model.saving") : t("model.save")}</button>
          </form>

          <section className="model-block" aria-label={t("model.authentication")}>
            <h2 className="label">{t("model.authentication")}</h2>
            <p className="kmeta" role="status">{configSaved ? t(`model.auth.${settings.auth.state}`) : t("model.auth.savedConfigStatus", { mode: t(`model.mode.${modeFor(settings)}`) })}</p>
            {!configReady && <p className="help">{t("model.saveBeforeAuth")}</p>}
            {canLogin &&
              <button type="button" onClick={() => void startLogin()} disabled={!authStatusLoaded || !configReady || isBusy}>{t("model.login")}</button>
            }
            {isBusy && <button type="button" onClick={() => void cancelLogin()}>{t("model.cancelTask")}</button>}
            {mode === "byok" || mode === "claude" ? <div className="field">
              <label className="label" htmlFor="model-secret">{t(secretLabel)}</label>
              <input id="model-secret" type="password" autoComplete="new-password" disabled={saving} value={secret} onChange={(e) => setSecret(e.target.value)} />
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

          <section className="model-block" aria-label={t("model.optionalTools")}>
            <h2 className="label">{t("model.optionalTools")}</h2>
            <p className="help">{settings.tools.claude.available ? t("model.claudeAvailable") : t("model.claudeUnavailable")}</p>
            <p className="help">{settings.tools.github.available ? t("model.githubAvailable") : t("model.githubUnavailable")}</p>
            <p className="kmeta">{settings.tools.github.tokenSaved ? t("model.githubSaved") : t("model.githubMissing")}</p>
            <label className="field"><span className="label">{t("model.githubToken")}</span>
              <input type="password" autoComplete="new-password" value={githubSecret} disabled={saving} onChange={(e) => setGithubSecret(e.target.value)} />
            </label>
            <button type="button" disabled={!githubSecret || saving} onClick={() => void saveGithubSecret()}>{t("model.saveGithubToken")}</button>
            {settings.tools.github.tokenSaved && <button type="button" disabled={saving} onClick={() => void logoutGithub()}>{t("model.removeGithubToken")}</button>}
          </section>
        </>}
      </div>
    </aside>
  );
}
