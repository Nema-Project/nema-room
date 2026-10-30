"use client";

import { useId, useState, type FormEvent } from "react";
import type { ExtensionRecord, McpConfig, McpValue } from "@nema/shared";
import { clearMcpSecret, getMcpServer, saveMcpServer, setMcpSecret, startMcpServer, stopMcpServer } from "@/lib/hub";
import { useT } from "@/lib/i18n";

/** `NAME=value`, `NAME=secret:REF`, `NAME=env:VAR`, one per line; `NAME=value:…` keeps a literal that starts with a prefix. */
export function parseValueLines(text: string): Record<string, McpValue> {
  const out: Record<string, McpValue> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf("=");
    if (at <= 0) throw new Error(`NAME=VALUE expected: ${line.slice(0, 40)}`);
    const name = line.slice(0, at);
    const rest = line.slice(at + 1);
    if (rest.startsWith("secret:")) out[name] = { secret: rest.slice(7) };
    else if (rest.startsWith("env:")) out[name] = { env: rest.slice(4) };
    else if (rest.startsWith("value:")) out[name] = { value: rest.slice(6) };
    else out[name] = { value: rest };
  }
  return out;
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
export function McpServerForm({ initial, onSaved, onCancel }: { initial?: { id: string; name: string; config: McpConfig }; onSaved: (record: ExtensionRecord) => void; onCancel?: () => void }) {
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
          ? { transport, command: command.trim(), args: args.split("\n").map((line) => line.trim()).filter(Boolean), ...(cwd.trim() ? { cwd: cwd.trim() } : {}), env: parseValueLines(env) }
          : { transport, url: url.trim(), headers: parseValueLines(headers) };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    setSaving(true);
    setError(null);
    // A new server is create-only, so it never replaces one with the same id.
    saveMcpServer({ id: id.trim(), name: name.trim(), config, ...(initial ? {} : { create: true as const }) })
      .then(onSaved)
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
function SecretSlot({ id, name, configured, onChanged }: { id: string; name: string; configured: boolean; onChanged: () => void }) {
  const t = useT();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (request: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    request()
      .then(() => {
        setValue("");
        onChanged();
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
export function McpServerControls({ extension, onChanged }: { extension: ExtensionRecord; onChanged: () => void }) {
  const t = useT();
  const state = extension.mcp;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string; config: McpConfig } | null>(null);
  const connection = state?.connection ?? "disconnected";
  const running = connection === "connected" || connection === "connecting";

  const run = (request: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    request()
      .then(onChanged)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (editing) {
    return (
      <McpServerForm
        initial={editing}
        onSaved={() => {
          setEditing(null);
          onChanged();
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
          onClick={() => run(() => startMcpServer(extension.id))}
          disabled={busy || extension.useState === "disabled" || extension.availability === "damaged"}
        >
          {t("mcp.action.start")}
        </button>
      )}
      <button type="button" className="sp" onClick={() => run(() => getMcpServer(extension.id).then((view) => setEditing({ id: view.id, name: view.name, config: view.config })))} disabled={busy}>
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
              <SecretSlot key={slot.name} id={extension.id} name={slot.name} configured={slot.configured} onChanged={onChanged} />
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
