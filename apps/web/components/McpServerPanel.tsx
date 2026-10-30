"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { mcpTargetChanged, secretRefs, type ExtensionRecord, type McpConfig, type McpRecordState, type McpValue } from "@nema/shared";
import { clearMcpSecret, getMcpServer, getMcpServerStatus, saveMcpServer, setMcpSecret, startMcpServer, stopMcpServer, type McpServerStatus } from "@/lib/hub";
import { useT } from "@/lib/i18n";

/** `NAME=value`, `NAME=secret:REF`, `NAME=env:VAR`, one per line; `NAME=value:…` keeps a literal that starts with a prefix. */
export function parseValueLines(text: string): Record<string, McpValue> {
  // Entries first, then `fromEntries`, so every name (even `__proto__`) is an own property and the
  // hub's parser, not the prototype, decides what is allowed.
  const entries: Array<[string, McpValue]> = [];
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") continue;
    const at = line.indexOf("=");
    const name = at > 0 ? line.slice(0, at).trim() : "";
    if (!name) throw new Error(`NAME=VALUE expected: ${line.trim().slice(0, 40)}`);
    // The value is kept exactly as typed, spaces included.
    const rest = line.slice(at + 1);
    if (rest.startsWith("secret:")) entries.push([name, { secret: rest.slice(7) }]);
    else if (rest.startsWith("env:")) entries.push([name, { env: rest.slice(4) }]);
    else if (rest.startsWith("value:")) entries.push([name, { value: rest.slice(6) }]);
    else entries.push([name, { value: rest }]);
  }
  return Object.fromEntries(entries);
}

/** One argument per line, as typed; only the newline that ends the last line is not an argument. */
function argumentLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The inverse, for the edit form. A literal that looks like a reference keeps its `value:` prefix. */
function valueLines(values: Record<string, McpValue>): string {
  return Object.entries(values)
    .map(([name, value]) => {
      if ("secret" in value) return `${name}=secret:${value.secret}`;
      if ("env" in value) return `${name}=env:${value.env}`;
      return /^(secret|env|value):/.test(value.value) ? `${name}=value:${value.value}` : `${name}=${value.value}`;
    })
    .join("\n");
}

/**
 * Add or edit an MCP server. Credentials are never typed here: a credential slot names a secret
 * (`NAME=secret:REF`, set below the server once it is saved) or a daemon environment variable.
 */
/**
 * The row state right after a save, from the config itself: the daemon stops a running server
 * before saving, keeps a slot's value only when the target did not change, and drops slots the
 * config no longer names. So the row has its credential boxes even if the next list read fails.
 */
function savedState(config: McpConfig, initial: { config: McpConfig } | undefined, previous: McpRecordState["secrets"]): McpRecordState {
  const kept = initial !== undefined && !mcpTargetChanged(initial.config, config);
  return {
    transport: config.transport,
    connection: "disconnected",
    server: null,
    tools: [],
    secrets: secretRefs(config).map((name) => ({ name, configured: kept && previous.some((slot) => slot.name === name && slot.configured) })),
    lastError: null,
  };
}

export function McpServerForm({ initial, previousSecrets = [], onSaved, onCancel }: { initial?: { id: string; name: string; config: McpConfig }; previousSecrets?: McpRecordState["secrets"]; onSaved: (record: ExtensionRecord) => void; onCancel?: () => void }) {
  const t = useT();
  const ids = useId();
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<"stdio" | "http">(initial?.config.transport ?? "stdio");
  const stdio = initial?.config.transport === "stdio" ? initial.config : null;
  const http = initial?.config.transport === "http" ? initial.config : null;
  const [command, setCommand] = useState(stdio?.command ?? "");
  const [args, setArgs] = useState(stdio?.args.join("\n") ?? "");
  const [cwd, setCwd] = useState(stdio?.cwd ?? "");
  const [env, setEnv] = useState(stdio ? valueLines(stdio.env) : "");
  const [url, setUrl] = useState(http?.url ?? "");
  const [headers, setHeaders] = useState(http ? valueLines(http.headers) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    let config: McpConfig;
    try {
      config =
        transport === "stdio"
          ? { transport, command: command.trim(), args: argumentLines(args), ...(cwd.trim() ? { cwd: cwd.trim() } : {}), env: parseValueLines(env) }
          : { transport, url: url.trim(), headers: parseValueLines(headers) };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setSaving(true);
    setError(null);
    // An add is create-only and an edit must-exist, so neither replaces nor revives another tab's change.
    saveMcpServer({ id: id.trim(), name: name.trim(), config, create: !initial })
      .then((record) => onSaved({ ...record, mcp: savedState(config, initial, previousSecrets) }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setSaving(false));
  };

  return (
    <form className="mcp-form" onSubmit={submit} aria-label={t(initial ? "mcp.form.edit-title" : "mcp.form.title")}>
      <h3>{t(initial ? "mcp.form.edit-title" : "mcp.form.title")}</h3>
      <p className="kmeta">{t("mcp.form.note")}</p>
      <label>
        {t("mcp.form.id")}
        <input value={id} onChange={(e) => setId(e.target.value)} readOnly={Boolean(initial)} required placeholder="my-server" />
      </label>
      <label>
        {t("mcp.form.name")}
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <fieldset role="radiogroup" aria-label={t("mcp.form.transport")}>
        <label>
          <input type="radio" name={`${ids}-transport`} checked={transport === "stdio"} onChange={() => setTransport("stdio")} />
          {t("mcp.form.stdio")}
        </label>
        <label>
          <input type="radio" name={`${ids}-transport`} checked={transport === "http"} onChange={() => setTransport("http")} />
          {t("mcp.form.http")}
        </label>
      </fieldset>
      {transport === "stdio" ? (
        <>
          <label>
            {t("mcp.form.command")}
            <input value={command} onChange={(e) => setCommand(e.target.value)} required placeholder="npx" />
          </label>
          <label>
            {t("mcp.form.args")}
            <textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={3} />
          </label>
          <label>
            {t("mcp.form.cwd")}
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} />
          </label>
          <label>
            {t("mcp.form.env")}
            <textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={3} placeholder="API_TOKEN=secret:API_TOKEN" />
          </label>
        </>
      ) : (
        <>
          <label>
            {t("mcp.form.url")}
            <input value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://example.com/mcp" />
          </label>
          <label>
            {t("mcp.form.headers")}
            <textarea value={headers} onChange={(e) => setHeaders(e.target.value)} rows={3} placeholder="Authorization=secret:AUTH" />
          </label>
        </>
      )}
      {initial && <p className="plugin-note">{t("mcp.form.target-note")}</p>}
      {error && <p className="error">{error}</p>}
      <button type="submit" className="sp" disabled={saving}>
        {t("mcp.form.save")}
      </button>
      {onCancel && (
        <button type="button" className="sp" onClick={onCancel} disabled={saving}>
          {t("extensions.action.cancel")}
        </button>
      )}
    </form>
  );
}

/** One credential slot: whether it is set, and a write-only box. The stored value is never shown. */
type SecretAnswer = { id: string; name: string; configured: boolean; status: McpServerStatus };

function SecretSlot({ id, name, configured, onChanged }: { id: string; name: string; configured: boolean; onChanged: (answer: SecretAnswer) => void }) {
  const t = useT();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (request: () => Promise<SecretAnswer>) => {
    setBusy(true);
    setError(null);
    request()
      .then((answer) => {
        setValue("");
        onChanged(answer);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <li>
      <span className="kid">{name}</span>
      <span className={configured ? "chip status-ok" : "chip"}>{t(configured ? "mcp.secret.set" : "mcp.secret.unset")}</span>
      <input
        type="password"
        autoComplete="new-password"
        aria-label={t("mcp.secret.label", { name })}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={busy}
      />
      <button type="button" className="sp" onClick={() => run(() => setMcpSecret(id, name, value))} disabled={busy || value === ""}>
        {t("mcp.secret.save")}
      </button>
      {configured && (
        <button type="button" className="sp" onClick={() => run(() => clearMcpSecret(id, name))} disabled={busy}>
          {t("mcp.secret.clear")}
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </li>
  );
}

/** Start/stop, connection, what the server reports, credential slots and Edit for one MCP record. */
export function McpServerControls({ extension, onChanged }: { extension: ExtensionRecord; onChanged: (saved?: ExtensionRecord) => void }) {
  const t = useT();
  // What the row shows: the list's state, updated at once by every answer and status check, so a
  // change shows even if the list read that follows fails or another client made it.
  const [live, setLive] = useState<McpRecordState | undefined>(extension.mcp);
  useEffect(() => setLive(extension.mcp), [extension.mcp]);
  const state = live;
  const base = (): McpRecordState => ({ transport: extension.source === "mcp:http" ? "http" : "stdio", connection: "disconnected", server: null, tools: [], secrets: [], lastError: null });
  const apply = (status: McpServerStatus | undefined) => {
    if (!status || status.id !== extension.id) return;
    setLive((current) => {
      const prev = current ?? base();
      const next = { ...prev, connection: status.connection, server: status.server, tools: status.tools, lastError: status.lastError };
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
    });
  };
  const applySecret = (answer: SecretAnswer) => {
    setLive((current) => {
      const prev = current ?? base();
      return { ...prev, secrets: prev.secrets.map((slot) => (slot.name === answer.name ? { ...slot, configured: answer.configured } : slot)) };
    });
    apply(answer.status);
    changed.current();
  };
  const [busy, setBusy] = useState(false);
  // A start can take as long as the server's handshake; it never blocks Stop.
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; config: McpConfig } | null>(null);
  const connection = starting ? "connecting" : (state?.connection ?? "disconnected");
  const running = connection === "connected" || connection === "connecting";
  const changed = useRef(onChanged);
  changed.current = onChanged;

  // A server can exit, or be started from another tab or the CLI, while nobody touches this page:
  // every row checks its status now and then, and any changed field shows.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (starting) return;
    const timer = setInterval(() => {
      getMcpServerStatus(extension.id)
        .then((status) => applyRef.current(status))
        .catch(() => {});
    }, 5_000);
    return () => clearInterval(timer);
  }, [extension.id, starting]);

  const start = () => {
    if (starting || busy) return;
    setStarting(true);
    setError(null);
    startMcpServer(extension.id)
      .then((status) => {
        apply(status);
        changed.current();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setStarting(false));
  };

  const run = (request: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    request()
      .then((answer) => {
        if (answer && typeof answer === "object" && "connection" in answer) apply(answer as McpServerStatus);
        changed.current();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  // A damaged config cannot be read back (the daemon refuses it), so recovery is entering it again
  // under the same id; Uninstall on the row is the clean-up path.
  const edit = () => {
    if (extension.availability === "damaged") {
      setEditing({ id: extension.id, name: extension.name, config: { transport: extension.source === "mcp:http" ? "http" : "stdio", ...(extension.source === "mcp:http" ? { url: "", headers: {} } : { command: "", args: [], env: {} }) } as McpConfig });
      return;
    }
    run(() => getMcpServer(extension.id).then((view) => setEditing({ id: view.id, name: view.name, config: view.config })));
  };

  if (editing) {
    return (
      <McpServerForm
        initial={editing}
        previousSecrets={state?.secrets ?? []}
        onSaved={(saved) => {
          setEditing(null);
          onChanged(saved);
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <div className="mcp-controls">
      <p className="plugin-status">
        <span className={["chip", connection === "connected" ? "status-ok" : connection === "error" || connection === "needs-login" ? "status-bad" : ""].filter(Boolean).join(" ")}>
          {t(`mcp.connection.${connection}`)}
        </span>
        <span className="chip">{t(`mcp.transport.${state?.transport ?? (extension.source === "mcp:http" ? "http" : "stdio")}`)}</span>
        {state?.server && <span className="kmeta">{`${state.server.name} ${state.server.version}`}</span>}
      </p>
      {running ? (
        <button type="button" className="sp" onClick={() => run(() => stopMcpServer(extension.id))} disabled={busy}>
          {t("mcp.action.stop")}
        </button>
      ) : (
        <button
          type="button"
          className="sp"
          onClick={start}
          disabled={busy || extension.useState === "disabled" || extension.availability === "damaged"}
        >
          {t("mcp.action.start")}
        </button>
      )}
      <button type="button" className="sp" onClick={edit} disabled={busy || starting}>
        {t("mcp.action.edit")}
      </button>
      {extension.useState === "disabled" && <p className="kmeta">{t("mcp.note.disabled")}</p>}
      {extension.availability === "damaged" && <p className="plugin-note">{t("mcp.note.damaged")}</p>}
      {state?.lastError && <p className="plugin-note">{state.lastError}</p>}
      {error && <p className="error">{error}</p>}
      {state && state.secrets.length > 0 && (
        <>
          <p className="kmeta">{t("mcp.secret.note")}</p>
          <ul className="mcp-secrets">
            {state.secrets.map((slot) => (
              <SecretSlot key={slot.name} id={extension.id} name={slot.name} configured={slot.configured} onChanged={applySecret} />
            ))}
          </ul>
        </>
      )}
      {state && state.tools.length > 0 && (
        <>
          <p className="kmeta">{t("mcp.tools.note", { count: state.tools.length })}</p>
          <ul>
            {state.tools.map((tool) => (
              <li key={tool.name}>
                <span className="kid">{tool.name}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
