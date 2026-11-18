"use client";

// The optional Graphify component, as people meet it: a confirm dialog that names the size, place and sources
// before anything downloads; the graph entry in the code section; and the Settings → Components section with
// mirrors and the agent CLI check. A failure only greys the graph entry; nothing here raises a global error.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  cancelGraphifyInstall,
  formatMiB,
  refreshComponents,
  rememberDeclined,
  saveGraphifySettings,
  shouldOfferOnGraphAction,
  startGraphifyInstall,
  useComponents,
} from "@/lib/components";
import { getAgentClis } from "@/lib/hub";
import { useT } from "@/lib/i18n";
import type { AgentCliStatus, ComponentFailureReason, ComponentStatus, ComponentView } from "@/lib/types";

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
};

/** A next step per cause, so network, proxy and checksum failures read differently. */
const HINT_KEY: Partial<Record<ComponentFailureReason, string>> = {
  network: "components.hint.network",
  proxy: "components.hint.proxy",
  "hash-mismatch": "components.hint.hashMismatch",
  "self-check": "components.hint.selfCheck",
  "disk-space": "components.hint.diskSpace",
};

const PHASE_KEY = {
  download: "components.progress.download",
  verify: "components.progress.verify",
  extract: "components.progress.extract",
  "self-check": "components.progress.selfCheck",
  activate: "components.progress.activate",
} as const;

/** One sentence for the state. A version for another lock is described as turned off, never as still in use. */
export function statusText(status: ComponentStatus, t: T): string {
  switch (status.state) {
    case "installed": {
      const base = t("components.state.installed", { version: status.version.graphifyy, python: status.version.python });
      return status.lastFailure ? `${base} ${t("components.state.repairFailed", { reason: t(REASON_KEY[status.lastFailure.reason]) })}` : base;
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

/** Retry and import are the exits after a failure; install is the way in otherwise. Platform and lock problems have none. Repair re-downloads the installed version over itself. With downloads turned off, import is the only way in or out. */
function actionsFor(view: ComponentView): { install: boolean; retry: boolean; import: boolean; cancel: boolean; repair: boolean } {
  const status = view.status;
  const canDownload = view.offer !== null && !view.settings.offline.value && !(status.state === "failed" && (status.reason === "offline" || status.reason === "unsupported-platform" || status.reason === "lock-unreadable"));
  return {
    install: canDownload && (status.state === "not-installed" || status.state === "lock-mismatch"),
    retry: canDownload && status.state === "failed",
    import: status.state === "failed" ? status.reason !== "unsupported-platform" && status.reason !== "lock-unreadable" : status.state !== "installed" && status.state !== "installing",
    cancel: status.state === "installing",
    repair: canDownload && status.state === "installed",
  };
}

function ImportHelp() {
  const t = useT();
  return (
    <div className="component-import">
      <p className="help">{t("components.importHelp")}</p>
      <pre className="kid">nema components import &lt;file&gt;</pre>
    </div>
  );
}

function FailureDetail({ status }: { status: Extract<ComponentStatus, { state: "failed" }> }) {
  const t = useT();
  const hint = HINT_KEY[status.reason];
  return (
    <>
      {hint && <p className="help">{t(hint)}</p>}
      {status.detail && status.reason !== "unsupported-platform" && status.reason !== "lock-unreadable" && <p className="kmeta">{status.detail}</p>}
    </>
  );
}

/**
 * The offer, then the download it starts. Opens on the confirm step unless an install is already running.
 * "Not now" remembers the decline for this lock, so the same version is not offered again unasked.
 * With `force` the dialog is a repair: it re-downloads the installed version over itself, and declining
 * it remembers nothing (the component is already installed; there is no offer to suppress).
 */
export function GraphifyInstallDialog({ onClose, force = false }: { onClose: () => void; force?: boolean }) {
  const t = useT();
  const titleId = useId();
  const { graphify, error } = useComponents();
  const [step, setStep] = useState<"confirm" | "follow">(graphify?.status.state === "installing" ? "follow" : "confirm");
  const [showImport, setShowImport] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** This dialog cancelled the running attempt: an installed status afterwards is the old copy, not a finished repair. */
  const [cancelled, setCancelled] = useState(false);
  const firstButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstButton.current?.focus();
  }, [step]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const offer = graphify?.offer ?? null;
  const status = graphify?.status ?? null;

  async function confirm() {
    if (!offer) return;
    setBusy(true);
    setRequestError(null);
    setCancelled(false);
    try {
      // A retry after a failed repair is a repair again, even if this dialog opened as a plain install.
      const repair = force || (status?.state === "installed" && status.lastFailure !== undefined);
      await startGraphifyInstall(offer.lockHash, { force: repair });
      setStep("follow");
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function decline() {
    if (offer && !force) rememberDeclined(offer.lockHash);
    onClose();
  }

  async function cancel() {
    setBusy(true);
    try {
      await cancelGraphifyInstall();
      setCancelled(true);
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  let body: ReactNode;
  if (!graphify) {
    body = <p className={error ? "error" : "kmeta"}>{error ? t("components.state.unknown", { error }) : t("common.loading")}</p>;
  } else if (step === "confirm" && status?.state !== "installing") {
    body = offer ? (
      <>
        <h2 id={titleId}>{t(force ? "components.offer.reinstallTitle" : "components.offer.title")}</h2>
        <p>{t(force ? "components.offer.reinstallBody" : "components.offer.body")}</p>
        <dl className="component-offer-facts">
          <dt>{t("components.offer.component")}</dt>
          <dd>{t("components.graphify.name")}</dd>
          <dt>{t("components.offer.size")}</dt>
          <dd data-testid="component-offer-size">{formatMiB(offer.totalBytes)}</dd>
          <dt>{t("components.offer.location")}</dt>
          <dd className="kid">{`${offer.location.replace(/[\\/]+$/, "")}/`}</dd>
          <dt>{t("components.offer.sources")}</dt>
          <dd className="kid">{offer.hosts.join(", ")}</dd>
        </dl>
        <p className="help">{t("components.offer.declineNote")}</p>
        {requestError && <p className="error" role="alert">{requestError}</p>}
        <div className="actions">
          <button type="button" ref={firstButton} onClick={decline}>{t("components.offer.decline")}</button>
          <button type="button" disabled={busy} onClick={() => void confirm()}>{t("components.offer.confirm")}</button>
        </div>
      </>
    ) : (
      <>
        <h2 id={titleId}>{t("components.graphify.name")}</h2>
        <p>{status ? statusText(status, t) : ""}</p>
        {graphify.offerError && <p className="kmeta">{t("components.offerUnavailable", { error: graphify.offerError })}</p>}
        <div className="actions">
          <button type="button" ref={firstButton} onClick={onClose}>{t("components.close")}</button>
        </div>
      </>
    );
  } else if (status?.state === "installing") {
    const { progress } = status;
    body = (
      <>
        <h2 id={titleId}>{t("components.progress.title")}</h2>
        <progress value={progress.downloadedBytes} max={Math.max(progress.totalBytes, 1)} aria-label={t("components.progress.title")} />
        <p role="status">
          {t(PHASE_KEY[progress.phase])} {t("components.progress.bytes", { done: formatMiB(progress.downloadedBytes), total: formatMiB(progress.totalBytes) })}
        </p>
        {progress.file && <p className="kmeta">{t("components.progress.file", { file: progress.file })}</p>}
        {requestError && <p className="error" role="alert">{requestError}</p>}
        <div className="actions">
          <button type="button" ref={firstButton} disabled={busy} onClick={() => void cancel()}>{t("components.cancel")}</button>
        </div>
      </>
    );
  } else if (status?.state === "installed") {
    body = (
      <>
        <h2 id={titleId}>{t("components.graphify.name")}</h2>
        {status.lastFailure ? (
          <>
            <p role="alert">{t("components.state.repairFailed", { reason: t(REASON_KEY[status.lastFailure.reason]) })}</p>
            <div className="actions">
              <button type="button" ref={firstButton} onClick={onClose}>{t("components.close")}</button>
              {actionsFor(graphify).repair && <button type="button" disabled={busy} onClick={() => void confirm()}>{t("components.retry")}</button>}
            </div>
          </>
        ) : cancelled ? (
          <>
            <p role="status">{t("components.state.repairCancelled")}</p>
            <div className="actions">
              <button type="button" ref={firstButton} onClick={onClose}>{t("components.close")}</button>
              {actionsFor(graphify).repair && <button type="button" disabled={busy} onClick={() => void confirm()}>{t("components.retry")}</button>}
            </div>
          </>
        ) : (
          <>
            <p role="status">{t("components.done")}</p>
            <div className="actions">
              <button type="button" ref={firstButton} onClick={onClose}>{t("components.close")}</button>
            </div>
          </>
        )}
      </>
    );
  } else if (status?.state === "failed") {
    const actions = actionsFor(graphify);
    body = (
      <>
        <h2 id={titleId}>{t("components.failed.title")}</h2>
        <p role="alert">{statusText(status, t)}</p>
        <FailureDetail status={status} />
        {showImport && <ImportHelp />}
        {requestError && <p className="error" role="alert">{requestError}</p>}
        <div className="actions">
          <button type="button" ref={firstButton} onClick={onClose}>{t("components.close")}</button>
          {actions.import && <button type="button" onClick={() => setShowImport(true)}>{t("components.import")}</button>}
          {actions.retry && <button type="button" disabled={busy} onClick={() => void confirm()}>{t("components.retry")}</button>}
        </div>
      </>
    );
  } else {
    // Cancelled: back to where it was before, with the way in.
    body = (
      <>
        <h2 id={titleId}>{t("components.graphify.name")}</h2>
        <p>{status ? statusText(status, t) : ""}</p>
        <div className="actions">
          <button type="button" ref={firstButton} onClick={onClose}>{t("components.close")}</button>
          {offer && <button type="button" disabled={busy} onClick={() => setStep("confirm")}>{t("components.install")}</button>}
        </div>
      </>
    );
  }

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="confirm component-offer" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
        {body}
      </div>
    </div>
  );
}

/** Status line plus its way in or out, shared by the graph entry and the settings section. */
function GraphifyStatusRow({ view, onOpen, compact }: { view: ComponentView; onOpen: (force: boolean) => void; compact?: boolean }) {
  const t = useT();
  const [showImport, setShowImport] = useState(false);
  const actions = actionsFor(view);
  const status = view.status;
  // Failed, offline, unsupported: the graph features are unavailable, so the entry reads as such.
  const unavailable = status.state !== "installed" && status.state !== "installing";
  return (
    <div className={unavailable ? "component-entry unavailable" : "component-entry"} data-state={status.state} aria-disabled={unavailable || undefined}>
      <p className="kmeta">{statusText(status, t)}</p>
      {status.state === "failed" && !compact && <FailureDetail status={status} />}
      {status.state === "installing" && <progress value={status.progress.downloadedBytes} max={Math.max(status.progress.totalBytes, 1)} aria-label={t("components.progress.title")} />}
      <div className="component-actions">
        {actions.install && <button type="button" className="settings-action" onClick={() => onOpen(false)}>{t("components.install")}</button>}
        {actions.retry && <button type="button" className="settings-action" onClick={() => onOpen(false)}>{t("components.retry")}</button>}
        {actions.cancel && <button type="button" className="settings-action" onClick={() => onOpen(false)}>{t("components.showProgress")}</button>}
        {actions.repair && <button type="button" className="settings-action" onClick={() => onOpen(true)}>{t("components.reinstall")}</button>}
        {actions.import && <button type="button" className="settings-action" onClick={() => setShowImport((open) => !open)} aria-expanded={showImport}>{t("components.import")}</button>}
      </div>
      {showImport && <ImportHelp />}
    </div>
  );
}

/**
 * The graph entry in the code section. `offerSignal` changes when the person starts a graph feature (binding a
 * repository starts its graph build); that, or the install button, is the only thing that opens the offer.
 */
export function GraphifyEntry({ offerSignal = 0 }: { offerSignal?: number }) {
  const t = useT();
  const { graphify, error, loaded } = useComponents();
  const [dialog, setDialog] = useState<null | "install" | "repair">(null);
  const handled = useRef(offerSignal);

  useEffect(() => {
    if (offerSignal === handled.current) return;
    handled.current = offerSignal;
    let live = true;
    void refreshComponents().then((next) => {
      if (live && shouldOfferOnGraphAction(next.graphify)) setDialog("install");
    });
    return () => {
      live = false;
    };
  }, [offerSignal]);

  // A daemon that reports no Graphify row (an older one) leaves the entry out rather than showing it stuck.
  if (loaded && !graphify && !error) return null;
  return (
    <div className="graph-entry">
      <h3 className="label">{t("components.graphEntry")}</h3>
      {graphify ? (
        <GraphifyStatusRow view={graphify} onOpen={(force) => setDialog(force ? "repair" : "install")} compact />
      ) : (
        <p className="kmeta">{error ? t("components.state.unknown", { error }) : t("components.state.checking")}</p>
      )}
      {dialog && <GraphifyInstallDialog force={dialog === "repair"} onClose={() => setDialog(null)} />}
    </div>
  );
}

function MirrorSettings({ view }: { view: ComponentView }) {
  const t = useT();
  const pythonId = useId();
  const pypiId = useId();
  const [python, setPython] = useState(view.settings.pythonMirror.config ?? "");
  const [pypi, setPypi] = useState(view.settings.pypiBase.config ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  async function save() {
    setState("saving");
    setSaveError(null);
    try {
      await saveGraphifySettings({ pythonMirror: python.trim() === "" ? null : python.trim(), pypiBase: pypi.trim() === "" ? null : pypi.trim() });
      setState("saved");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }

  async function setOffline(offline: boolean) {
    setSaveError(null);
    try {
      await saveGraphifySettings({ offline });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }

  const envNote = (setting: ComponentView["settings"]["pythonMirror"], name: string) =>
    setting.source === "env" ? <p className="help">{t("components.mirror.fromEnv", { name, value: setting.value ?? "" })}</p> : null;

  return (
    <div className="component-mirrors">
      <h3 className="label">{t("components.mirrors")}</h3>
      <p className="help">{t("components.mirror.help", { pythonEnv: "NEMA_GRAPHIFY_PYTHON_MIRROR", pypiEnv: "NEMA_GRAPHIFY_PYPI_BASE" })}</p>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="field" htmlFor={pythonId}>
          <span className="label">{t("components.mirror.python")}</span>
          <input id={pythonId} type="url" value={python} placeholder="https://github.com/astral-sh/python-build-standalone/releases/download" disabled={view.settings.pythonMirror.source === "env"} onChange={(event) => { setPython(event.target.value); setState("idle"); }} />
        </label>
        {envNote(view.settings.pythonMirror, "NEMA_GRAPHIFY_PYTHON_MIRROR")}
        <label className="field" htmlFor={pypiId}>
          <span className="label">{t("components.mirror.pypi")}</span>
          <input id={pypiId} type="url" value={pypi} placeholder="https://files.pythonhosted.org" disabled={view.settings.pypiBase.source === "env"} onChange={(event) => { setPypi(event.target.value); setState("idle"); }} />
        </label>
        {envNote(view.settings.pypiBase, "NEMA_GRAPHIFY_PYPI_BASE")}
        <button type="submit" className="settings-action" disabled={state === "saving"}>{t("components.mirror.save")}</button>
        {state === "saved" && <p className="help" role="status">{t("components.mirror.saved")}</p>}
      </form>
      <label className="check">
        <input type="checkbox" checked={view.settings.offline.value} disabled={view.settings.offline.source === "env"} onChange={(event) => void setOffline(event.target.checked)} />
        <span>{t("components.offline")}</span>
      </label>
      {view.settings.offline.source === "env" && <p className="help">{t("components.offlineEnv")}</p>}
      {saveError && <p className="error" role="alert">{saveError}</p>}
    </div>
  );
}

const AGENT_NAME: Record<AgentCliStatus["id"], string> = { codex: "components.agents.codex", "claude-code": "components.agents.claude" };

/** D-6: detection and guidance only. Nema links to the vendor's instructions and never runs an installer. */
function AgentClis() {
  const t = useT();
  const [agents, setAgents] = useState<AgentCliStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getAgentClis()
      .then((body) => {
        if (live) setAgents(body.agents);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="agent-clis">
      <h3 className="label">{t("components.agents")}</h3>
      <p className="help">{t("components.agents.note")}</p>
      {error && <p className="kmeta">{t("components.agents.error", { error })}</p>}
      {!agents && !error && <p className="kmeta">{t("common.loading")}</p>}
      {agents?.map((agent) => (
        <div key={agent.id} className="agent-cli" data-agent={agent.id}>
          <span className="label">{t(AGENT_NAME[agent.id])}</span>{" "}
          {agent.installed ? (
            <span className="kmeta">{t("components.agents.installed", { version: agent.version ?? agent.command })}</span>
          ) : (
            <span className="kmeta">
              {t("components.agents.missing", { command: agent.command })}{" "}
              <a href={agent.installUrl} target="_blank" rel="noreferrer noopener">{t("components.agents.installLink")}</a>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Settings → Components: Graphify's state with install / retry / import, the mirror fields, and the agent CLI check. */
export function ComponentsSettings() {
  const t = useT();
  const { graphify, error, loaded } = useComponents();
  const [dialog, setDialog] = useState<null | "install" | "repair">(null);

  return (
    <section className="app-settings-section components-settings" aria-labelledby="app-settings-components-title">
      <h2 id="app-settings-components-title" className="label">{t("components.title")}</h2>
      <h3 className="label">{t("components.graphify.name")}</h3>
      <p className="help">{t("components.graphify.purpose")}</p>
      {graphify ? (
        <>
          <GraphifyStatusRow view={graphify} onOpen={(force) => setDialog(force ? "repair" : "install")} />
          {graphify.offer && <p className="kmeta">{t("components.offer.location")}: <span className="kid">{`${graphify.offer.location.replace(/[\\/]+$/, "")}/`}</span></p>}
          {graphify.offerError && <p className="kmeta">{t("components.offerUnavailable", { error: graphify.offerError })}</p>}
          <MirrorSettings key={`${graphify.settings.pythonMirror.config ?? ""}|${graphify.settings.pypiBase.config ?? ""}`} view={graphify} />
        </>
      ) : error ? (
        <p className="kmeta">{t("components.state.unknown", { error })}</p>
      ) : (
        !loaded && <p className="kmeta">{t("common.loading")}</p>
      )}
      <AgentClis />
      {dialog && <GraphifyInstallDialog force={dialog === "repair"} onClose={() => setDialog(null)} />}
    </section>
  );
}
